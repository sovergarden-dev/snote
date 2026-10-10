import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import {
  buildCasSaveMacInput,
  decodeBase64Url,
  encodeBase64Url,
  encodeRealtimeFrame,
  decodeRealtimeFrame,
  MAX_REALTIME_FRAME_BYTES,
  CURRENT_PROTOCOL_VERSION,
  computeHmacSha256,
  type RealtimeFrame,
} from "@/lib/realtime/protocol";
import {
  decryptRealtimePayload,
  encryptRealtimePayload,
  importRelayKey,
  verifySavedAck,
  type RealtimeCipherPayload,
} from "@/lib/realtime/client-crypto";
import {
  createRealtimeEdgeApi,
  createRealtimeSessionId,
  isEd25519Unsupported,
  realtimeHubConfigForTicket,
  RealtimeEdgeApiError,
  verifyRealtimeTicket,
  type RealtimeEdgeApi,
  type RealtimePrelude,
} from "@/lib/realtime/client-sync";
import type { RealtimeOutboxUpdate } from "./realtime-outbox";
import { RealtimeOutbox } from "./realtime-outbox";
import { base64ToBytes, bytesToBase64 } from "./base64";
import type { AwarenessState, Encryption, SyncEvent, YjsProviderLike } from "./provider";

const OUTBOX_DB = "snote-realtime-outbox";
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const SAVE_FALLBACK_MS = 90_000;
const MAX_CAS_RETRIES = 3;
const MAX_CAS_REBASES = 2;
const MAX_PENDING_UPDATES = 512;
const MAX_TEXT_BYTES = MAX_REALTIME_FRAME_BYTES - 2_048;
const ORIGIN_HUB = "syrin-realtime-hub";
const textEncoder = new TextEncoder();

export type RealtimeHubProviderOptions = {
  prelude: RealtimePrelude;
  api?: RealtimeEdgeApi;
  outbox?: RealtimeOutbox;
  socketFactory?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
};

type PendingCas = {
  updateIds: string[];
  stateVector: Uint8Array;
  permissionEpoch: number;
  roomId: string;
  generation: number;
};

type OutboxMessage =
  | { kind: "y-update"; slug: string; generation: number; updateId: string; payload: RealtimeCipherPayload }
  | { kind: "presence"; slug: string; generation: number; payload: RealtimeCipherPayload };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomUpdateId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(18)));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function extractCipherPayload(value: unknown): RealtimeCipherPayload | null {
  if (!isRecord(value)) return null;
  const payload = value as Partial<RealtimeCipherPayload>;
  if (
    typeof payload.sender_id !== "string"
    || typeof payload.session_id !== "string"
    || !Number.isSafeInteger(payload.counter)
    || typeof payload.nonce !== "string"
    || typeof payload.ciphertext !== "string"
  ) return null;
  return payload as RealtimeCipherPayload;
}

function decodeSocketFrame(eventData: unknown): RealtimeFrame | null {
  try {
    if (typeof eventData === "string") return decodeRealtimeFrame(textEncoder.encode(eventData));
    if (eventData instanceof ArrayBuffer) return decodeRealtimeFrame(new Uint8Array(eventData));
    if (ArrayBuffer.isView(eventData)) {
      return decodeRealtimeFrame(new Uint8Array(eventData.buffer, eventData.byteOffset, eventData.byteLength));
    }
  } catch {
    return null;
  }
  return null;
}

function isSameGenerationTicket(prelude: RealtimePrelude, next: RealtimePrelude): boolean {
  return next.ticket.generation === prelude.ticket.generation
    && next.ticket.roomId === prelude.ticket.roomId
    && next.ticket.noteId === prelude.ticket.noteId
    && next.ticket.permissionEpoch === prelude.ticket.permissionEpoch;
}

function isRevisionConflict(error: unknown): boolean {
  if (!(error instanceof RealtimeEdgeApiError) || error.status !== 409) return false;
  return ["version_conflict", "stale_revision", "revision_conflict"].includes((error.code ?? "").toLowerCase());
}

export class RealtimeYjsProvider implements YjsProviderLike {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly slug: string;
  readonly generation: number;
  connected = false;

  private prelude: RealtimePrelude;
  private readonly api: RealtimeEdgeApi;
  private readonly outbox: RealtimeOutbox;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly syncListeners = new Set<(event: SyncEvent) => void>();
  private readonly awarenessListeners = new Set<(states: Map<number, AwarenessState>) => void>();
  private readonly replayCounters = new Map<string, number>();
  private readonly sentUpdateIds = new Set<string>();
  private readonly pendingCas = new Map<string, PendingCas>();
  private channel: BroadcastChannel | null = null;
  private socket: WebSocket | null = null;
  private socketOpening = false;
  private destroyed = false;
  private writeExpected: boolean | null = null;
  private encryption: Encryption | null = null;
  private senderId: string | null = null;
  private counter = 0;
  private renewalCounter = 0;
  private renewalWaitingFor: number | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private casRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private casRetries = 0;
  private casInFlight = false;
  private persistTail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private lastBroadcastAt = 0;
  private lastSnapshotAt = 0;
  private localAwarenessClientId = 0;

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.destroyed || origin === this || !this.prelude) return;
    const row: RealtimeOutboxUpdate = {
      slug: this.slug,
      generation: this.generation,
      updateId: randomUpdateId(),
      update: Uint8Array.from(update),
      createdAt: this.now(),
    };
    this.pendingBytes += row.update.byteLength;
    this.persistTail = this.persistTail.then(async () => {
      await this.outbox.enqueue(row);
      this.scheduleCasFallback();
      await this.broadcastLocalUpdate(row);
      void this.sendPendingUpdates();
    }).catch(() => {
      this.emit({ type: "error", message: "Không thể lưu bản sửa vào hàng đợi realtime." });
      this.scheduleCasFallback();
    });
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (this.destroyed || origin === this || !this.prelude) return;
    const affected = [...change.added, ...change.updated, ...change.removed];
    if (!affected.includes(this.localAwarenessClientId)) return;
    void this.sendPresence();
  };

  constructor(slug: string, doc: Y.Doc, options: RealtimeHubProviderOptions) {
    if (options.prelude.slug !== slug) throw new Error("realtime prelude slug mismatch");
    this.slug = slug;
    this.doc = doc;
    this.prelude = options.prelude;
    this.generation = options.prelude.ticket.generation;
    this.api = options.api ?? createRealtimeEdgeApi();
    this.outbox = options.outbox ?? new RealtimeOutbox(OUTBOX_DB);
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.awareness = new Awareness(doc);
    this.localAwarenessClientId = this.awareness.clientID;

    // This snapshot was verified against the Edge ticket before this doc was
    // acquired. NotePage keys both Y.Doc and IndexedDB by this generation.
    const snapshotText = options.prelude.ticket.ydocState;
    if (snapshotText) Y.applyUpdate(doc, base64ToBytes(snapshotText), ORIGIN_HUB);

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.openChannel();
    window.addEventListener("online", this.onNetworkAvailable);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  setEncryption(encryption: Encryption | null): void {
    this.encryption = encryption;
    if (encryption) this.emit({ type: "error", message: "Realtime hub chỉ áp dụng cho note thường không mã hóa." });
  }

  setExpectedEncrypted(expected: boolean | null): void {
    this.writeExpected = expected;
    if (expected === true) this.closeSocket("encrypted note is not eligible for hub sync");
  }

  onAwareness(listener: (states: Map<number, AwarenessState>) => void): () => void {
    this.awarenessListeners.add(listener);
    return () => this.awarenessListeners.delete(listener);
  }

  onSyncEvent(listener: (event: SyncEvent) => void): () => void {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  getPendingBytes(): number {
    return this.pendingBytes;
  }

  getLastBroadcastAt(): number {
    return this.lastBroadcastAt;
  }

  getLastSnapshotAt(): number {
    return this.lastSnapshotAt;
  }

  hasUnflushedLocalChanges(): boolean {
    return this.pendingBytes > 0;
  }

  async connect(
    identity: { name: string; color: string },
    _options?: { prefetchedYdocState?: string | null; rowExists?: boolean },
  ): Promise<void> {
    if (this.destroyed || this.writeExpected === true || this.encryption) return;
    this.awareness.setLocalStateField("user", identity);
    try {
      const rows = await this.outbox.list(this.slug, this.generation, MAX_PENDING_UPDATES);
      this.pendingBytes = rows.reduce((sum, row) => sum + row.update.byteLength, 0);
      if (rows.length > 0) this.scheduleCasFallback();
      await this.openSocket(false);
    } catch {
      this.emit({ type: "offline" });
      this.emit({ type: "error", message: "Realtime chưa sẵn sàng; bản sửa được giữ cục bộ." });
      this.scheduleCasFallback();
    }
  }

  flushBeacon(): void {
    void this.flushCasFallback();
  }

  async whenOutboxPersisted(): Promise<void> {
    await this.persistTail;
  }

  private async preludeForTicket(
    ticket: RealtimePrelude["ticket"],
    sessionId: string,
  ): Promise<RealtimePrelude> {
    const config = realtimeHubConfigForTicket(this.prelude.config, ticket.hub_id);
    const claims = await verifyRealtimeTicket(
      ticket,
      sessionId,
      config,
      this.prelude.pinnedKeys,
    );
    const writeMacKey = await crypto.subtle.importKey(
      "raw",
      decodeBase64Url(ticket.write_mac_key) as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    const relayKey = await importRelayKey(decodeBase64Url(ticket.relay_key));
    return { ...this.prelude, sessionId, ticket, claims, config, writeMacKey, relayKey };
  }

  async flushCasFallback(): Promise<void> {
    if (this.destroyed || this.casInFlight) return;
    this.casInFlight = true;
    try {
      await this.persistTail;
      const rows = await this.outbox.list(this.slug, this.generation, MAX_PENDING_UPDATES);
      if (rows.length === 0) {
        this.pendingBytes = 0;
        return;
      }
      let response: Awaited<ReturnType<RealtimeEdgeApi["casSave"]>> | null = null;
      let committedStateVector: Uint8Array | null = null;
      for (let attempt = 0; attempt <= MAX_CAS_REBASES; attempt += 1) {
        const update = Y.encodeStateAsUpdate(this.doc);
        const stateVector = Y.encodeStateVector(this.doc);
        const expectedRevision = this.prelude.ticket.revision;
        const permissionEpoch = this.prelude.ticket.permissionEpoch;
        const macInput = await buildCasSaveMacInput({
          opaqueRoomId: this.prelude.ticket.roomId,
          generation: this.generation,
          expectedRevision,
          payload: update,
          permissionEpoch,
          stateVector,
        });
        const mac = encodeBase64Url(await computeHmacSha256(this.prelude.writeMacKey, macInput));
        try {
          response = await this.api.casSave({
            slug: this.slug,
            expectedRevision,
            generation: this.generation,
            permissionEpoch,
            ydocState: bytesToBase64(update),
            stateVector: encodeBase64Url(stateVector),
            mac,
            isEncrypted: false,
            salt: null,
            check: null,
            iterations: null,
          });
          committedStateVector = stateVector;
          break;
        } catch (error) {
          if (!isRevisionConflict(error) || attempt === MAX_CAS_REBASES) throw error;
          const latestTicket = await this.api.issueTicket(this.slug, this.prelude.sessionId);
          const latestPrelude = await this.preludeForTicket(latestTicket, this.prelude.sessionId);
          if (!isSameGenerationTicket(this.prelude, latestPrelude)) {
            throw new Error("realtime CAS authority changed during revision rebase");
          }
          const before = Y.encodeStateVector(this.doc);
          if (latestTicket.ydocState) {
            Y.applyUpdate(this.doc, base64ToBytes(latestTicket.ydocState), this);
          }
          const after = Y.encodeStateVector(this.doc);
          if (!bytesEqual(before, after)) this.emit({ type: "recovered", bytes: after.byteLength });
          this.prelude = latestPrelude;
        }
      }
      if (!response || !committedStateVector) throw new Error("CAS retry budget exhausted");
      // An idempotent save may leave the revision unchanged; the signed ACK
      // below must still bind this exact state vector before any row is removed.
      if (
        response.roomId !== this.prelude.ticket.roomId
        || response.generation !== this.generation
        || response.revision < this.prelude.ticket.revision
      ) throw new Error("CAS response authority mismatch");
      const validAck = await verifySavedAck(response.savedAck, {
        roomId: this.prelude.ticket.roomId,
        generation: this.generation,
        permissionEpoch: this.prelude.ticket.permissionEpoch,
        revision: response.revision,
        stateVector: committedStateVector,
      }, this.prelude.pinnedKeys);
      if (!validAck) {
        this.emit({ type: "error", message: "ACK realtime không hợp lệ; hàng đợi vẫn được giữ." });
        return;
      }

      await this.outbox.acknowledge(this.slug, this.generation, rows.map((row) => row.updateId));
      this.pendingBytes = (await this.outbox.list(this.slug, this.generation, MAX_PENDING_UPDATES))
        .reduce((sum, row) => sum + row.update.byteLength, 0);
      this.prelude = {
        ...this.prelude,
        ticket: { ...this.prelude.ticket, revision: response.revision },
      };
      this.lastSnapshotAt = this.now();
      this.casRetries = 0;
      this.emit({ type: "synced-durable" });
      if (this.pendingBytes > 0) this.scheduleCasFallback();
    } catch (error) {
      this.emit({ type: "error", message: isEd25519Unsupported(error)
        ? "Trình duyệt không hỗ trợ xác minh Ed25519; hàng đợi vẫn được giữ."
        : "CAS chưa xác nhận được bản sửa; hàng đợi vẫn được giữ." });
      this.scheduleCasRetry();
    } finally {
      this.casInFlight = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    this.channel?.close();
    this.channel = null;
    window.removeEventListener("online", this.onNetworkAvailable);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.clearTimer("renewalTimer");
    this.clearTimer("renewalTimeout");
    this.clearTimer("reconnectTimer");
    this.clearTimer("fallbackTimer");
    this.clearTimer("casRetryTimer");
    this.closeSocket("provider destroyed");
    await this.persistTail.catch(() => {});
    this.outbox.close();
    this.syncListeners.clear();
    this.awarenessListeners.clear();
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.syncListeners) listener(event);
  }

  private emitAwareness(): void {
    const states = this.awareness.getStates() as Map<number, AwarenessState>;
    for (const listener of this.awarenessListeners) listener(states);
  }

  private openChannel(): void {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      this.channel = new BroadcastChannel(`syrin-realtime-v1:${this.slug}:${this.generation}`);
      this.channel.onmessage = (event: MessageEvent<unknown>) => {
        void this.receiveBroadcast(event.data);
      };
    } catch {
      this.channel = null;
    }
  }

  private async broadcastLocalUpdate(row: RealtimeOutboxUpdate): Promise<void> {
    if (!this.channel || !this.senderId || !this.connected) return;
    try {
      const payload = await this.encrypt(row.update, "y-update");
      this.channel.postMessage({
        kind: "y-update",
        slug: this.slug,
        generation: this.generation,
        updateId: row.updateId,
        payload,
      } satisfies OutboxMessage);
    } catch {
      this.emit({ type: "error", message: "Không thể mã hóa bản sửa realtime; hàng đợi vẫn được giữ." });
    }
  }

  private async receiveBroadcast(value: unknown): Promise<void> {
    if (!isRecord(value) || value.slug !== this.slug || value.generation !== this.generation) return;
    if (value.kind === "y-update") {
      const payload = extractCipherPayload(value.payload);
      if (!payload || payload.sender_id === this.senderId) return;
      await this.applyEncryptedUpdate(payload);
      return;
    }
    if (value.kind === "presence") {
      const payload = extractCipherPayload(value.payload);
      if (!payload || payload.sender_id === this.senderId) return;
      await this.applyEncryptedPresence(payload);
    }
  }

  private async openSocket(reconnecting: boolean): Promise<void> {
    if (this.destroyed || this.socketOpening || this.connected) return;
    if (this.writeExpected === true || this.encryption) return;
    this.socketOpening = true;
    let prelude = this.prelude;
    let socketOpened = false;
    let hubReportPromise: Promise<void> | null = null;
    const reportUnreachable = (): Promise<void> => {
      if (socketOpened || !prelude.ticket.hub_id || !this.api.reportHubUnreachable) {
        return Promise.resolve();
      }
      if (!hubReportPromise) {
        hubReportPromise = this.api.reportHubUnreachable(
          this.slug,
          prelude.sessionId,
          prelude.ticket.ticket,
        ).then(() => undefined).catch(() => undefined);
      }
      return hubReportPromise;
    };
    try {
      if (reconnecting) {
        const sessionId = createRealtimeSessionId();
        const ticket = await this.api.issueTicket(this.slug, sessionId);
        const next = await this.preludeForTicket(ticket, sessionId);
        if (!isSameGenerationTicket(this.prelude, next)) {
          this.emit({ type: "conflict", bytes: this.pendingBytes });
          this.emit({ type: "error", message: "Generation của note đã đổi; bản sửa cũ được giữ riêng, không merge." });
          this.socketOpening = false;
          return;
        }
        const before = Y.encodeStateVector(this.doc);
        if (ticket.ydocState) Y.applyUpdate(this.doc, base64ToBytes(ticket.ydocState), this);
        const after = Y.encodeStateVector(this.doc);
        if (!bytesEqual(before, after)) this.emit({ type: "recovered", bytes: after.byteLength });
        prelude = next;
        this.prelude = next;
      }
      const url = new URL(`/room/${encodeURIComponent(prelude.ticket.roomId)}`, prelude.config.hubUrl);
      const socket = this.socketFactory(url.toString());
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (this.destroyed || socket !== this.socket) return;
        socketOpened = true;
        try {
          socket.send(new TextDecoder().decode(encodeRealtimeFrame({
            v: CURRENT_PROTOCOL_VERSION,
            message_type: "hub-auth",
            opaque_room_id: prelude.ticket.roomId,
            payload: { ticket: prelude.ticket.ticket, session_id: prelude.sessionId },
          })));
        } catch {
          socket.close(1008, "invalid auth frame");
        }
      });
      socket.addEventListener("message", (event) => {
        if (socket !== this.socket) return;
        void this.handleSocketMessage(event.data);
      });
      socket.addEventListener("close", () => {
        if (socket !== this.socket || this.destroyed) return;
        this.socket = null;
        this.socketOpening = false;
        this.connected = false;
        this.senderId = null;
        this.sentUpdateIds.clear();
        this.emit({ type: "offline" });
        void (async () => {
          await Promise.race([
            reportUnreachable(),
            new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
          ]);
          if (!this.destroyed) this.scheduleReconnect();
        })();
      });
      socket.addEventListener("error", () => {
        if (socket === this.socket) {
          this.emit({ type: "offline" });
          if (!socketOpened) void reportUnreachable();
        }
      });
    } catch (error) {
      this.socketOpening = false;
      this.connected = false;
      this.emit({ type: "offline" });
      this.emit({ type: "error", message: isEd25519Unsupported(error)
        ? "Trình duyệt không hỗ trợ Ed25519; dùng đồng bộ dự phòng và giữ outbox."
        : "Không thể kết nối hub; bản sửa vẫn ở outbox." });
      this.scheduleReconnect();
      this.scheduleCasFallback();
    }
  }

  private async handleSocketMessage(eventData: unknown): Promise<void> {
    const frame = decodeSocketFrame(eventData);
    if (!frame || frame.opaque_room_id !== this.prelude.ticket.roomId) return;
    if (frame.message_type === "hub-ready") {
      const senderId = isRecord(frame.payload) ? frame.payload.sender_id : null;
      if (typeof senderId !== "string" || senderId.length < 8 || senderId.length > 128) {
        this.closeSocket("hub did not bind a sender ID");
        return;
      }
      this.senderId = senderId;
      this.connected = true;
      this.socketOpening = false;
      this.reconnectAttempts = 0;
      this.emit({ type: "online" });
      this.scheduleRenewal();
      await this.sendPendingUpdates();
      await this.sendPresence();
      return;
    }
    if (frame.message_type === "ticket-renewed") {
      const counter = isRecord(frame.payload) ? frame.payload.counter : null;
      if (counter !== this.renewalWaitingFor) return;
      this.renewalCounter = counter as number;
      this.renewalWaitingFor = null;
      this.clearTimer("renewalTimeout");
      this.prelude = { ...this.prelude, ticket: { ...this.prelude.ticket, revision: this.pendingRenewalRevision ?? this.prelude.ticket.revision } };
      this.pendingRenewalRevision = null;
      this.scheduleRenewal();
      return;
    }
    if (frame.message_type === "y-update" || frame.message_type === "presence") {
      const payload = extractCipherPayload(frame.payload);
      if (!payload || payload.sender_id === this.senderId) return;
      if (frame.message_type === "y-update") await this.applyEncryptedUpdate(payload);
      else await this.applyEncryptedPresence(payload);
      return;
    }
    if (frame.message_type === "saved-ack") {
      // Relay ACKs are not authority by themselves. The outbox is acknowledged
      // only by a signed Edge CAS response matched to a captured state vector.
      return;
    }
    if (frame.message_type === "drain" || frame.message_type === "hub-change") {
      this.closeSocket("hub transition requires safe fallback");
      this.reconnectAttempts = 0;
      this.clearTimer("reconnectTimer");
      void this.openSocket(true);
      return;
    }
    if (frame.message_type === "permission-revoked") {
      this.closeSocket("permission revoked");
      this.emit({ type: "error", message: "Quyền ghi đã thay đổi; bản sửa chưa được ACK vẫn được giữ." });
    }
  }

  private async sendPendingUpdates(): Promise<void> {
    if (!this.connected || !this.senderId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    await this.persistTail;
    const rows = await this.outbox.list(this.slug, this.generation, MAX_PENDING_UPDATES);
    for (const row of rows) {
      if (this.sentUpdateIds.has(row.updateId)) continue;
      try {
        const payload = await this.encrypt(row.update, "y-update");
        this.sendFrame("y-update", payload);
        this.sentUpdateIds.add(row.updateId);
        this.lastBroadcastAt = this.now();
        if (this.channel) {
          this.channel.postMessage({
            kind: "y-update",
            slug: this.slug,
            generation: this.generation,
            updateId: row.updateId,
            payload,
          } satisfies OutboxMessage);
        }
      } catch {
        // A large or malformed patch stays in the durable outbox for CAS.
        this.emit({ type: "error", message: "Bản sửa vượt giới hạn hub hoặc không thể mã hóa; sẽ dùng CAS." });
      }
    }
    if (rows.length > 0) this.scheduleCasFallback();
  }

  private async sendPresence(): Promise<void> {
    if (!this.connected || !this.senderId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      const awarenessUpdate = encodeAwarenessUpdate(this.awareness, [this.localAwarenessClientId]);
      if (awarenessUpdate.byteLength > 32 * 1024) return;
      const payload = await this.encrypt(awarenessUpdate, "presence");
      this.sendFrame("presence", payload);
      if (this.channel) {
        this.channel.postMessage({
          kind: "presence",
          slug: this.slug,
          generation: this.generation,
          payload,
        } satisfies OutboxMessage);
      }
    } catch {
      // Presence is ephemeral; never block durable note changes on it.
    }
  }

  private async encrypt(bytes: Uint8Array, messageType: "y-update" | "presence"): Promise<RealtimeCipherPayload> {
    if (!this.senderId) throw new Error("hub sender is not authenticated");
    this.counter += 1;
    return encryptRealtimePayload(bytes, {
      roomId: this.prelude.ticket.roomId,
      generation: this.generation,
      messageType,
      senderId: this.senderId,
      sessionId: this.prelude.sessionId,
      counter: this.counter,
    }, this.prelude.relayKey, this.prelude.writeMacKey);
  }

  private sendFrame(messageType: string, payload: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const frame = encodeRealtimeFrame({
      v: CURRENT_PROTOCOL_VERSION,
      message_type: messageType,
      opaque_room_id: this.prelude.ticket.roomId,
      payload,
    });
    if (frame.byteLength > MAX_TEXT_BYTES) throw new Error("realtime frame too large");
    this.socket.send(new TextDecoder().decode(frame));
  }

  private async applyEncryptedUpdate(payload: RealtimeCipherPayload): Promise<void> {
    const replayKey = `${payload.sender_id}:${payload.session_id}`;
    try {
      const decrypted = await decryptRealtimePayload(payload, {
        roomId: this.prelude.ticket.roomId,
        generation: this.generation,
        messageType: "y-update",
      }, this.prelude.relayKey, this.prelude.writeMacKey, this.replayCounters.get(replayKey) ?? 0);
      Y.applyUpdate(this.doc, decrypted.plaintext, this);
      this.replayCounters.set(replayKey, payload.counter);
      this.lastBroadcastAt = this.now();
    } catch {
      // Invalid MAC/tag/generation/replay is ignored; never mutate the Y.Doc.
    }
  }

  private async applyEncryptedPresence(payload: RealtimeCipherPayload): Promise<void> {
    const replayKey = `${payload.sender_id}:${payload.session_id}`;
    try {
      const decrypted = await decryptRealtimePayload(payload, {
        roomId: this.prelude.ticket.roomId,
        generation: this.generation,
        messageType: "presence",
      }, this.prelude.relayKey, this.prelude.writeMacKey, this.replayCounters.get(replayKey) ?? 0);
      applyAwarenessUpdate(this.awareness, decrypted.plaintext, this);
      this.replayCounters.set(replayKey, payload.counter);
      this.emitAwareness();
    } catch {
      // Invalid or replayed awareness data has no effect.
    }
  }

  private scheduleRenewal(): void {
    this.clearTimer("renewalTimer");
    this.renewalTimer = setTimeout(() => void this.renewTicketOverSocket(), 240_000);
  }

  private async renewTicketOverSocket(): Promise<void> {
    if (this.destroyed || !this.connected || this.renewalWaitingFor !== null) return;
    try {
      const ticket = await this.api.issueTicket(this.slug, this.prelude.sessionId);
      const nextPrelude = await this.preludeForTicket(ticket, this.prelude.sessionId);
      if (!isSameGenerationTicket(this.prelude, nextPrelude)) {
        this.emit({ type: "conflict", bytes: this.pendingBytes });
        this.emit({ type: "error", message: "Generation của note đã đổi; không merge qua generation." });
        this.closeSocket("generation changed");
        return;
      }
      const before = Y.encodeStateVector(this.doc);
      if (ticket.ydocState) Y.applyUpdate(this.doc, base64ToBytes(ticket.ydocState), this);
      const after = Y.encodeStateVector(this.doc);
      if (!bytesEqual(before, after)) this.emit({ type: "recovered", bytes: after.byteLength });
      const nextCounter = this.renewalCounter + 1;
      this.renewalWaitingFor = nextCounter;
      this.pendingRenewalRevision = ticket.revision;
      this.sendFrame("ticket-renewal", {
        ticket: ticket.ticket,
        session_id: this.prelude.sessionId,
        counter: nextCounter,
      });
      this.renewalTimeout = setTimeout(() => {
        if (this.renewalWaitingFor !== null) this.closeSocket("ticket renewal timed out");
      }, 5_000);
    } catch (error) {
      this.emit({ type: "error", message: isEd25519Unsupported(error)
        ? "Không xác minh được vé gia hạn Ed25519; outbox vẫn được giữ."
        : "Gia hạn hub thất bại; outbox vẫn được giữ." });
      this.closeSocket("ticket renewal failed");
    }
  }

  private pendingRenewalRevision: number | null = null;

  private scheduleCasFallback(): void {
    if (this.destroyed || this.fallbackTimer || this.pendingBytes <= 0) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      void this.flushCasFallback();
    }, SAVE_FALLBACK_MS);
  }

  private scheduleCasRetry(): void {
    if (this.destroyed || this.casRetryTimer || this.casRetries >= MAX_CAS_RETRIES) return;
    this.casRetries += 1;
    const delay = Math.min(1_000 * 2 ** (this.casRetries - 1), 4_000);
    this.casRetryTimer = setTimeout(() => {
      this.casRetryTimer = null;
      void this.flushCasFallback();
    }, delay);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    const cap = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    const delay = Math.floor(this.random() * cap);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(true);
    }, delay);
  }

  private readonly onNetworkAvailable = () => {
    if (this.destroyed || this.connected) return;
    this.reconnectAttempts = 0;
    this.clearTimer("reconnectTimer");
    void this.openSocket(true);
    if (this.pendingBytes > 0) void this.flushCasFallback();
  };

  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || this.destroyed) return;
    if (!this.connected) {
      this.reconnectAttempts = 0;
      this.clearTimer("reconnectTimer");
      void this.openSocket(true);
    }
    if (this.pendingBytes > 0) void this.flushCasFallback();
  };

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpening = false;
    this.connected = false;
    this.senderId = null;
    this.sentUpdateIds.clear();
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, reason.slice(0, 100)); } catch { /* ignore */ }
    }
    this.emit({ type: "offline" });
  }

  private clearTimer(name: "renewalTimer" | "renewalTimeout" | "reconnectTimer" | "fallbackTimer" | "casRetryTimer"): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }
}
