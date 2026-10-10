import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  MAX_REALTIME_FRAME_BYTES,
} from "../protocol";
import type { HubClock } from "./clock";
import { systemHubClock } from "./clock";
import { verifyHubProbe } from "./health";
import { HUB_CLOSE_CODES, isOpaqueRoomId, RelayCore, type HubRuntimeConfig, type HubSocketAttachment, type HubSocketPeer } from "./relay-core";
import type { ReplayStore } from "./replay-store";
import { openNodeReplayStore } from "./node-sqlite";
import { InMemoryHubRateLimiter, DEFAULT_HUB_RATE_LIMITS, type HubRateLimits } from "./rate-limiter";

const AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_DRAIN_WINDOW_MS = 2_000;
export const MAX_NODE_HUB_DRAIN_WINDOW_MS = 30_000;
const MAX_SOCKETS_PER_ROOM = 128;
const HEALTH_PATH = "/healthz";

export interface NodeHubOptions {
  config: HubRuntimeConfig;
  replayStore: ReplayStore;
  rateLimits?: HubRateLimits;
  drainWindowMilliseconds?: number;
}

interface SocketContext {
  peer: NodeSocketPeer;
  roomId: string;
  authTimer: unknown;
  releaseAddress: () => void;
  processing: boolean;
}

class NodeSocketPeer implements HubSocketPeer {
  private attachment?: HubSocketAttachment;

  constructor(private readonly socket: WebSocket) {}

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  getAttachment(): unknown {
    return this.attachment;
  }

  setAttachment(attachment: HubSocketAttachment): void {
    this.attachment = { ...attachment, permissions: [...attachment.permissions] };
  }

  send(text: string): void {
    this.socket.send(text, { binary: false });
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

export type NodeHubServer = Server & {
  drain(): Promise<void>;
  isDraining(): boolean;
};

export interface NodeHubVolumeOptions extends Omit<NodeHubOptions, "replayStore"> {
  replayDatabasePath: string;
}

export type NodeVolumeHubServer = NodeHubServer & {
  closeStorage(): void;
};

function parseRoomRoute(requestUrl: string | undefined): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(requestUrl ?? "/", "http://hub.local").pathname;
  } catch {
    return undefined;
  }
  const match = /^\/room\/([A-Za-z0-9_-]{1,128})$/u.exec(pathname);
  if (!match || !isOpaqueRoomId(match[1]!)) return undefined;
  return match[1];
}

function bytesFromRawData(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data as Buffer);
}

function sendHttp(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function rejectWebSocketUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  return match?.[1];
}

export function createNodeHubServer(options: NodeHubOptions): NodeHubServer {
  const clock = options.config.clock ?? systemHubClock;
  const config = { ...options.config, clock };
  const replayStore = options.replayStore;
  let replayStoreUnavailable = false;
  const replayStoreReadable = (): boolean => {
    if (replayStoreUnavailable) return false;
    const probe = replayStore as ReplayStore & { checkReadable?: () => boolean };
    try {
      const readable = typeof probe.checkReadable === "function" ? probe.checkReadable() : true;
      if (!readable) replayStoreUnavailable = true;
      return readable;
    } catch {
      replayStoreUnavailable = true;
      return false;
    }
  };
  const healthAwareReplayStore: ReplayStore = {
    async consumeJti(jti, ticketExpSeconds, nowSeconds) {
      if (!replayStoreReadable()) throw new Error("Replay store unavailable");
      try {
        return await replayStore.consumeJti(jti, ticketExpSeconds, nowSeconds);
      } catch {
        replayStoreUnavailable = true;
        throw new Error("Replay store unavailable");
      }
    },
  };
  const core = new RelayCore(config, healthAwareReplayStore);
  const limiter = new InMemoryHubRateLimiter(clock, options.rateLimits ?? DEFAULT_HUB_RATE_LIMITS);
  const contexts = new WeakMap<WebSocket, SocketContext>();
  const pendingLeases = new WeakMap<WebSocket, { roomId: string; releaseAddress: () => void }>();
  const rooms = new Map<string, Set<NodeSocketPeer>>();
  const drainWindow = options.drainWindowMilliseconds ?? DEFAULT_DRAIN_WINDOW_MS;
  if (!Number.isSafeInteger(drainWindow) || drainWindow < 0 || drainWindow > MAX_NODE_HUB_DRAIN_WINDOW_MS) {
    throw new Error("Invalid hub drain window");
  }
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let resolveDrainWait: (() => void) | undefined;
  let drainTimer: unknown;

  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: MAX_REALTIME_FRAME_BYTES,
    perMessageDeflate: false,
  });

  const server = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://hub.local").pathname;
    } catch {
      sendHttp(response, 404, "{\"error\":\"not_found\"}");
      return;
    }
    if (pathname !== HEALTH_PATH || request.method !== "GET") {
      sendHttp(response, 404, "{\"error\":\"not_found\"}");
      return;
    }

    const token = bearerToken(request);
    if (!token) {
      sendHttp(response, 404, "{\"error\":\"not_found\"}");
      return;
    }
    if (!await verifyHubProbe(token, config.hubId, config.pinnedKeys, clock)) {
      sendHttp(response, 404, "{\"error\":\"not_found\"}");
      return;
    }

    if (draining || !replayStoreReadable()) {
      sendHttp(response, 503, "{\"ok\":false}");
      return;
    }
    sendHttp(response, 200, "{\"ok\":true}");
  });
  const trackedSockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    trackedSockets.add(socket);
    socket.once("close", () => trackedSockets.delete(socket));
  });

  function allPeers(roomId: string): HubSocketPeer[] {
    return [...(rooms.get(roomId) ?? [])];
  }

  function removePeer(context: SocketContext): void {
    clock.clearTimeout(context.authTimer);
    context.releaseAddress();
    limiter.removeSocket(context.peer);
    const peers = rooms.get(context.roomId);
    peers?.delete(context.peer);
    if (peers?.size === 0) rooms.delete(context.roomId);
    if (draining && activePeerCount() === 0) resolveDrainWait?.();
  }

  function activePeerCount(): number {
    let count = 0;
    for (const peers of rooms.values()) count += peers.size;
    return count;
  }

  function attachSocket(socket: WebSocket): void {
    const pending = pendingLeases.get(socket);
    if (!pending) {
      socket.close(HUB_CLOSE_CODES.internal, "connection state unavailable");
      return;
    }
    const peer = new NodeSocketPeer(socket);
    const context: SocketContext = {
      peer,
      roomId: pending.roomId,
      releaseAddress: pending.releaseAddress,
      authTimer: clock.setTimeout(() => {
        if (!peer.getAttachment()) peer.close(HUB_CLOSE_CODES.authTimeout, "ticket required");
      }, AUTH_TIMEOUT_MS),
      processing: false,
    };
    contexts.set(socket, context);
    const roomPeers = rooms.get(context.roomId) ?? new Set<NodeSocketPeer>();
    roomPeers.add(peer);
    rooms.set(context.roomId, roomPeers);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!limiter.allowMessage(peer)) {
        peer.close(HUB_CLOSE_CODES.policy, "message rate exceeded");
        return;
      }
      if (context.processing) {
        peer.close(HUB_CLOSE_CODES.policy, "frame processing overlap");
        return;
      }
      if (isBinary) {
        peer.close(1003, "text frames required");
        return;
      }
      context.processing = true;
      let bytes: Uint8Array;
      try {
        bytes = bytesFromRawData(data);
      } catch {
        peer.close(HUB_CLOSE_CODES.policy, "invalid frame");
        context.processing = false;
        return;
      }
      void core.handleFrame(peer, context.roomId, bytes, allPeers(context.roomId))
        .catch(() => peer.close(HUB_CLOSE_CODES.internal, "hub processing failed"))
        .finally(() => {
          context.processing = false;
          if (peer.getAttachment()) clock.clearTimeout(context.authTimer);
        });
    });
    socket.once("close", () => removePeer(context));
    socket.on("error", () => peer.close(HUB_CLOSE_CODES.internal, "socket error"));
  }

  websocketServer.on("connection", (socket) => attachSocket(socket));
  server.on("upgrade", (request, socket, head) => {
    const roomId = parseRoomRoute(request.url);
    if (!roomId || request.headers.upgrade?.toLowerCase() !== "websocket") {
      rejectWebSocketUpgrade(socket, 404, "Not Found");
      return;
    }
    if (draining || !replayStoreReadable()) {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if ((rooms.get(roomId)?.size ?? 0) >= MAX_SOCKETS_PER_ROOM) {
      rejectWebSocketUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const releaseAddress = limiter.tryOpen(request.socket.remoteAddress ?? "unknown");
    if (!releaseAddress) {
      rejectWebSocketUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      pendingLeases.set(websocket, { roomId, releaseAddress });
      websocketServer.emit("connection", websocket, request);
    });
  });

  function closeWebSocketServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      websocketServer.close((error) => error ? reject(error) : resolve());
    });
  }

  function closeHttpServer(): void {
    if (server.listening) server.close();
    for (const socket of trackedSockets) socket.destroy();
  }

  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    draining = true;
    for (const peers of rooms.values()) {
      for (const peer of peers) {
        const attachment = peer.getAttachment() as HubSocketAttachment | undefined;
        const roomId = attachment?.room_id ?? [...rooms.entries()].find(([, set]) => set.has(peer))?.[0];
        if (roomId && peer.isOpen()) {
          try {
            peer.send(JSON.stringify({ v: 2, message_type: "drain", opaque_room_id: roomId }));
          } catch {
            peer.close(1001, "hub draining");
          }
        }
      }
    }
    drainPromise = new Promise<void>((resolve) => {
      resolveDrainWait = resolve;
      if (activePeerCount() === 0) {
        resolve();
        return;
      }
      drainTimer = clock.setTimeout(() => resolve(), drainWindow);
    }).then(async () => {
      if (drainTimer !== undefined) clock.clearTimeout(drainTimer);
      resolveDrainWait = undefined;
      for (const peers of rooms.values()) {
        for (const peer of peers) {
          peer.close(1001, "hub draining");
          (peer as NodeSocketPeer).terminate();
        }
      }
      try {
        await closeWebSocketServer();
      } finally {
        closeHttpServer();
      }
    });
    return drainPromise;
  };

  const hubServer = Object.assign(server, { drain, isDraining: () => draining }) as NodeHubServer;
  return hubServer;
}

export function installNodeSigtermDrain(
  server: NodeHubServer,
  onDrained?: (error?: unknown) => void,
): () => void {
  let started = false;
  const handler = () => {
    if (started) return;
    started = true;
    void server.drain().then(
      () => onDrained?.(),
      (error: unknown) => onDrained?.(error),
    );
  };
  process.on("SIGTERM", handler);
  return () => process.off("SIGTERM", handler);
}

/** Creates a Node hub backed by a persistent SQLite file on the operator's volume. */
export async function createNodeHubServerWithVolume(options: NodeHubVolumeOptions): Promise<NodeVolumeHubServer> {
  const opened = await openNodeReplayStore(options.replayDatabasePath);
  try {
    const server = createNodeHubServer({
      config: options.config,
      replayStore: opened.store,
      rateLimits: options.rateLimits,
      drainWindowMilliseconds: options.drainWindowMilliseconds,
    });
    const baseDrain = server.drain.bind(server);
    let storageClosed = false;
    const closeStorage = () => {
      if (storageClosed) return;
      storageClosed = true;
      opened.close();
    };
    server.drain = async () => {
      try {
        await baseDrain();
      } finally {
        closeStorage();
      }
    };
    return Object.assign(server, { closeStorage }) as NodeVolumeHubServer;
  } catch {
    try {
      opened.close();
    } catch {
      // Preserve the safe startup error at the entrypoint boundary.
    }
    throw new Error("Unable to create rt1 hub server");
  }
}
