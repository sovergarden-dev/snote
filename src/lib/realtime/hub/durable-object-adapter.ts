import {
  MAX_REALTIME_FRAME_BYTES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JwsPinnedKeySets,
} from "../protocol";
import type { HubClock } from "./clock";
import { systemHubClock } from "./clock";
import { verifyHubProbe } from "./health";
import { importHubPinnedKeys, type HubKeyBindings } from "./keyring";
import { HUB_CLOSE_CODES, isOpaqueRoomId, RelayCore, type HubRuntimeConfig, type HubSocketAttachment, type HubSocketPeer } from "./relay-core";
import { REPLAY_RETENTION_SECONDS, SqliteReplayStore, type SqliteDriver } from "./replay-store";
import { InMemoryHubRateLimiter, DEFAULT_HUB_RATE_LIMITS } from "./rate-limiter";

const AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_WINDOW_MS = 2_000;
const MAX_SOCKETS_PER_ROOM = 128;
const HEALTH_OBJECT_NAME = "hub-health-v1";

interface SqlCursor {
  rowsWritten: number;
  one(): Record<string, unknown> | undefined;
  toArray(): Record<string, unknown>[];
}

interface DurableObjectSqlStorage {
  exec(sql: string, ...values: (string | number)[]): SqlCursor;
}

export interface DurableObjectSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectContext {
  storage: { sql: DurableObjectSqlStorage };
  acceptWebSocket(socket: DurableObjectSocket): void;
  getWebSockets(): DurableObjectSocket[];
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface HealthObjectStub extends DurableObjectStub {
  isDraining(): Promise<boolean>;
  setDraining(draining?: boolean): Promise<void>;
}

export interface HubWorkerEnvironment extends HubKeyBindings {
  ROOM_HUB: DurableObjectNamespace;
  HUB_HEALTH: DurableObjectNamespace;
}

interface PendingSocketAttachment {
  room_id: string;
  auth_deadline_ms: number;
}

function makeSqliteDriver(storage: DurableObjectSqlStorage): SqliteDriver {
  return {
    exec(sql) {
      storage.exec(sql);
    },
    run(sql, ...values) {
      return storage.exec(sql, ...values).rowsWritten;
    },
    get(sql, ...values) {
      return storage.exec(sql, ...values).toArray()[0];
    },
  };
}

function pairConstructor(): new () => { 0: WebSocket; 1: DurableObjectSocket } {
  const globals = globalThis as typeof globalThis & {
    WebSocketPair?: new () => { 0: WebSocket; 1: DurableObjectSocket };
  };
  if (!globals.WebSocketPair) throw new Error("WebSocketPair is unavailable");
  return globals.WebSocketPair;
}

function responseWithWebSocket(webSocket: WebSocket): Response {
  return new Response(null, {
    status: 101,
    webSocket,
  } as ResponseInit & { webSocket: WebSocket });
}

function roomRoute(pathname: string): string | undefined {
  const match = /^\/room\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (!match || !isOpaqueRoomId(match[1]!)) return undefined;
  return match[1];
}

function rawRoomFromAttachment(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const roomId = (value as Record<string, unknown>).room_id;
  return typeof roomId === "string" && isOpaqueRoomId(roomId) ? roomId : undefined;
}

function isAuthenticatedAttachment(value: unknown): value is HubSocketAttachment {
  return typeof value === "object"
    && value !== null
    && "renewal_counter" in value
    && Number.isSafeInteger((value as { renewal_counter?: unknown }).renewal_counter);
}

class DurableObjectPeer implements HubSocketPeer {
  constructor(readonly socket: DurableObjectSocket) {}

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  getAttachment(): unknown {
    return this.socket.deserializeAttachment();
  }

  setAttachment(attachment: HubSocketAttachment): void {
    this.socket.serializeAttachment({ ...attachment, permissions: [...attachment.permissions] });
  }

  send(text: string): void {
    this.socket.send(text);
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }
}

export class RealtimeHubDurableObject {
  private readonly corePromise: Promise<RelayCore>;
  private readonly clock: HubClock;
  private readonly handshakeTimers = new WeakMap<DurableObjectSocket, unknown>();
  private readonly processing = new WeakSet<DurableObjectSocket>();
  private readonly limiter: InMemoryHubRateLimiter;
  private readonly addressLeases = new WeakMap<DurableObjectSocket, () => void>();
  private draining = false;
  private drainPromise?: Promise<void>;
  private resolveDrainWait?: () => void;
  private drainTimer?: unknown;

  constructor(
    private readonly state: DurableObjectContext,
    private readonly environment: HubKeyBindings,
    clock: HubClock = systemHubClock,
  ) {
    this.clock = clock;
    this.limiter = new InMemoryHubRateLimiter(clock, DEFAULT_HUB_RATE_LIMITS);
    const store = new SqliteReplayStore(makeSqliteDriver(state.storage.sql));
    this.corePromise = importHubPinnedKeys(environment).then((pinnedKeys) => new RelayCore({
      hubId: environment.HUB_ID,
      pinnedKeys,
      clock,
    }, store));
    this.restorePendingAuthTimers();
  }

  async fetch(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 404 });
    }
    const routeRoomId = roomRoute(url.pathname);
    if (
      !routeRoomId
      || request.method !== "GET"
      || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response(null, { status: 404 });
    }
    if (this.draining || this.state.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return new Response(null, { status: 503 });
    }
    const releaseAddress = this.limiter.tryOpen(request.headers.get("cf-connecting-ip") ?? "unknown");
    if (!releaseAddress) return new Response(null, { status: 429 });

    let pair: { 0: WebSocket; 1: DurableObjectSocket };
    try {
      pair = new (pairConstructor())();
      this.addressLeases.set(pair[1], releaseAddress);
      pair[1].serializeAttachment({
        room_id: routeRoomId,
        auth_deadline_ms: this.clock.nowMilliseconds() + AUTH_TIMEOUT_MS,
      } satisfies PendingSocketAttachment);
      this.state.acceptWebSocket(pair[1]);
      this.setHandshakeTimer(pair[1], routeRoomId, AUTH_TIMEOUT_MS);
    } catch {
      releaseAddress();
      return new Response(null, { status: 503 });
    }
    return responseWithWebSocket(pair[0]);
  }

  async webSocketMessage(socket: DurableObjectSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.limiter.allowMessage(socket)) {
      socket.close(HUB_CLOSE_CODES.policy, "message rate exceeded");
      return;
    }
    if (this.processing.has(socket)) {
      socket.close(HUB_CLOSE_CODES.policy, "frame processing overlap");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "text frames required");
      return;
    }
    const bytes = new TextEncoder().encode(message);
    if (bytes.byteLength > MAX_REALTIME_FRAME_BYTES) {
      socket.close(HUB_CLOSE_CODES.tooLarge, "frame too large");
      return;
    }
    let roomId: string | undefined;
    let attachment: unknown;
    try {
      attachment = socket.deserializeAttachment();
      roomId = rawRoomFromAttachment(attachment);
    } catch {
      socket.close(HUB_CLOSE_CODES.internal, "socket state unavailable");
      return;
    }
    if (!roomId) {
      socket.close(HUB_CLOSE_CODES.policy, "room state unavailable");
      return;
    }
    if (!isAuthenticatedAttachment(attachment) && this.clock.nowMilliseconds() >= (attachment as PendingSocketAttachment).auth_deadline_ms) {
      socket.close(HUB_CLOSE_CODES.authTimeout, "ticket required");
      return;
    }

    this.processing.add(socket);
    const peer = new DurableObjectPeer(socket);
    try {
      const core = await this.corePromise;
      const peers = this.state.getWebSockets().map((candidate) =>
        candidate === socket ? peer : new DurableObjectPeer(candidate)
      );
      await core.handleFrame(peer, roomId, bytes, peers);
    } catch {
      peer.close(HUB_CLOSE_CODES.internal, "hub processing failed");
    } finally {
      this.processing.delete(socket);
      if (isAuthenticatedAttachment(safeAttachment(socket))) this.clearHandshakeTimer(socket);
    }
  }

  webSocketClose(socket: DurableObjectSocket): void {
    this.clearHandshakeTimer(socket);
    this.addressLeases.get(socket)?.();
    this.addressLeases.delete(socket);
    this.limiter.removeSocket(socket);
    if (this.draining && this.openSockets().length === 0) this.resolveDrainWait?.();
  }

  webSocketError(socket: DurableObjectSocket): void {
    this.clearHandshakeTimer(socket);
    this.addressLeases.get(socket)?.();
    this.addressLeases.delete(socket);
    this.limiter.removeSocket(socket);
    socket.close(HUB_CLOSE_CODES.internal, "socket error");
  }

  /** Trusted internal RPC: mark this room object draining and bound its wait. */
  drain(windowMilliseconds = DEFAULT_DRAIN_WINDOW_MS): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    for (const socket of this.openSockets()) {
      const roomId = rawRoomFromAttachment(safeAttachment(socket));
      if (roomId) {
        try {
          socket.send(JSON.stringify({ v: 2, message_type: "drain", opaque_room_id: roomId }));
        } catch {
          socket.close(1001, "hub draining");
        }
      }
    }
    this.drainPromise = new Promise<void>((resolve) => {
      this.resolveDrainWait = resolve;
      if (this.openSockets().length === 0) {
        resolve();
        return;
      }
      this.drainTimer = this.clock.setTimeout(resolve, Math.max(0, windowMilliseconds));
    }).then(() => {
      if (this.drainTimer !== undefined) this.clock.clearTimeout(this.drainTimer);
      this.resolveDrainWait = undefined;
      for (const socket of this.openSockets()) socket.close(1001, "hub draining");
    });
    return this.drainPromise;
  }

  private openSockets(): DurableObjectSocket[] {
    return this.state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private restorePendingAuthTimers(): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = safeAttachment(socket);
      if (!attachment || isAuthenticatedAttachment(attachment)) continue;
      const roomId = rawRoomFromAttachment(attachment);
      const deadline = (attachment as PendingSocketAttachment).auth_deadline_ms;
      if (!roomId || !Number.isSafeInteger(deadline)) {
        socket.close(HUB_CLOSE_CODES.internal, "socket state unavailable");
        continue;
      }
      this.setHandshakeTimer(socket, roomId, Math.max(0, deadline - this.clock.nowMilliseconds()));
    }
  }

  private setHandshakeTimer(socket: DurableObjectSocket, _roomId: string, delayMilliseconds: number): void {
    this.clearHandshakeTimer(socket);
    const timer = this.clock.setTimeout(() => {
      if (!isAuthenticatedAttachment(safeAttachment(socket))) {
        socket.close(HUB_CLOSE_CODES.authTimeout, "ticket required");
      }
    }, delayMilliseconds);
    this.handshakeTimers.set(socket, timer);
  }

  private clearHandshakeTimer(socket: DurableObjectSocket): void {
    const timer = this.handshakeTimers.get(socket);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.handshakeTimers.delete(socket);
  }
}

function safeAttachment(socket: DurableObjectSocket): unknown {
  try {
    return socket.deserializeAttachment();
  } catch {
    return undefined;
  }
}

export class HubHealthDurableObject {
  constructor(private readonly state: Pick<DurableObjectContext, "storage">) {
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hub_runtime_control (
        control_key TEXT PRIMARY KEY,
        control_value INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/healthz") return new Response(null, { status: 404 });
    return new Response(null, { status: await this.isDraining() ? 503 : 204 });
  }

  async isDraining(): Promise<boolean> {
    const row = this.state.storage.sql.exec(
      "SELECT COALESCE((SELECT control_value FROM hub_runtime_control WHERE control_key = ?), 0) AS control_value",
      "draining",
    ).one();
    return Number(row?.control_value) === 1;
  }

  async setDraining(draining = true): Promise<void> {
    this.state.storage.sql.exec(
      "INSERT INTO hub_runtime_control (control_key, control_value) VALUES (?, ?) ON CONFLICT(control_key) DO UPDATE SET control_value = excluded.control_value",
      "draining",
      draining ? 1 : 0,
    );
  }
}

const keyringCache = new WeakMap<object, Promise<JwsPinnedKeySets>>();

function pinnedKeysFor(environment: HubKeyBindings): Promise<JwsPinnedKeySets> {
  const cacheKey = environment as object;
  const existing = keyringCache.get(cacheKey);
  if (existing) return existing;
  const pending = importHubPinnedKeys(environment);
  keyringCache.set(cacheKey, pending);
  return pending;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1];
}

export async function routeHubWorkerRequest(
  request: Request,
  environment: HubWorkerEnvironment,
  clock: HubClock = systemHubClock,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response(null, { status: 404 });
  }

  if (url.pathname === "/healthz") {
    if (request.method !== "GET") return new Response(null, { status: 404 });
    const token = bearerToken(request);
    if (!token) return new Response(null, { status: 404 });
    let pinnedKeys: JwsPinnedKeySets;
    try {
      pinnedKeys = await pinnedKeysFor(environment);
    } catch {
      return new Response(null, { status: 404 });
    }
    if (!await verifyHubProbe(token, environment.HUB_ID, pinnedKeys, clock)) {
      return new Response(null, { status: 404 });
    }
    const healthStub = environment.HUB_HEALTH.get(environment.HUB_HEALTH.idFromName(HEALTH_OBJECT_NAME)) as HealthObjectStub;
    const health = await healthStub.fetch(new Request("https://hub-health/healthz"));
    if (!health.ok) return new Response(null, { status: 503 });
    return Response.json({ ok: true, protocol_versions: SUPPORTED_PROTOCOL_VERSIONS }, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  }

  const routeRoomId = roomRoute(url.pathname);
  if (
    !routeRoomId
    || request.method !== "GET"
    || request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return new Response(null, { status: 404 });
  }
  const healthStub = environment.HUB_HEALTH.get(environment.HUB_HEALTH.idFromName(HEALTH_OBJECT_NAME)) as HealthObjectStub;
  if (await healthStub.isDraining()) return new Response(null, { status: 503 });
  const roomStub = environment.ROOM_HUB.get(environment.ROOM_HUB.idFromName(routeRoomId));
  return roomStub.fetch(request);
}

export const HUB_DO_INTERNALS = {
  authTimeoutMilliseconds: AUTH_TIMEOUT_MS,
  drainWindowMilliseconds: DEFAULT_DRAIN_WINDOW_MS,
  replayRetentionSeconds: REPLAY_RETENTION_SECONDS,
};
