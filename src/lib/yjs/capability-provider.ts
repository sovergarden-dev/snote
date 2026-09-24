import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { createClient } from "@supabase/supabase-js";
import type { CapabilityAccess } from "@/lib/capability/url";
import {
  createCapabilityApi,
  CapabilityApiError,
  type CapabilityApi,
  type NoteSession,
  type PendingUpdate,
  type PrivateRealtimeNoteSession,
} from "@/lib/capability/client";
import {
  CapabilityOutbox,
  type OutboxUpdate,
  type WritableCapabilityScope,
} from "./capability-outbox";
import {
  CapabilityPollingController,
  type CapabilityPollingControllerOptions,
  nextDelay,
} from "./capability-polling";
import type { AwarenessState, Encryption, SyncEvent, YjsProviderLike } from "./provider";
import {
  capabilityPayloadId,
  decodeCapabilityPayload,
  encodeCapabilityPayload,
} from "@/lib/capability/encoding";

type Listener<T> = (value: T) => void;

type RealtimeChannelLike = {
  on: (
    type: string,
    filter: { event?: string },
    handler: (message: { payload: unknown }) => void | Promise<void>,
  ) => RealtimeChannelLike;
  subscribe: (handler: (status: string) => void | Promise<void>) => unknown;
  send: (message: { type: string; event: string; payload: unknown }) => unknown;
  unsubscribe: () => unknown;
};

export type CapabilityRealtimeHandle = {
  channel: RealtimeChannelLike;
  setAuth: (token: string) => void | Promise<void>;
  dispose: () => void | Promise<void>;
};

export type CapabilityRealtimeFactory = (
  session: PrivateRealtimeNoteSession,
) => Promise<CapabilityRealtimeHandle>;

type ProviderPollingDependencies = Omit<
  CapabilityPollingControllerOptions,
  "run" | "isHidden"
> & {
  isHidden?: () => boolean;
};

type ProviderDependencies = {
  api?: CapabilityApi;
  outbox?: CapabilityOutbox;
  realtimeFactory?: CapabilityRealtimeFactory;
  pollingOnly?: boolean;
  polling?: ProviderPollingDependencies;
  timers?: Pick<CapabilityPollingControllerOptions, "setTimer" | "clearTimer">;
  now?: () => number;
  compactionThresholdUpdates?: number;
};

type FlushResult =
  | { ok: true }
  | { ok: false; error: unknown };

type FlushPermissions = {
  allowWhileClosing?: boolean;
  allowWhileWriteFenced?: boolean;
};

const MAX_REALTIME_UPDATE_BYTES = 180 * 1024;
const MAX_AWARENESS_BYTES = 32 * 1024;
const MAX_KEEPALIVE_BATCH_BYTES = 48 * 1024;
const DEFAULT_COMPACTION_THRESHOLD_UPDATES = 200;

type ProviderTimerSetter = (handler: () => void, timeout?: number) => number;
type ProviderTimerClearer = (timer?: number) => void;

const defaultSetTimer: ProviderTimerSetter = (handler, timeout) =>
  (typeof window === "undefined"
    ? globalThis.setTimeout(handler, timeout)
    : window.setTimeout(handler, timeout)) as unknown as number;
const defaultClearTimer: ProviderTimerClearer = (timer) => {
  if (typeof window === "undefined") {
    globalThis.clearTimeout(timer as unknown as ReturnType<typeof globalThis.setTimeout>);
  } else {
    window.clearTimeout(timer);
  }
};

function withoutPrivateRealtime(session: NoteSession): NoteSession {
  if (session.syncTransport === "polling") return session;
  return {
    ...session,
    syncTransport: "polling",
    realtimeToken: null,
    realtimeExpiresAt: null,
  };
}

function isSyncFencingCapabilityFailure(error: unknown) {
  if (!(error instanceof CapabilityApiError)) return false;
  // A CAS conflict is the one safe 4xx retry path. All other client-visible
  // capability rejections are fail-closed: preserve the durable outbox, but
  // stop sending the same invalid or revoked authority indefinitely.
  return error.code === "quota_exceeded"
    || error.status === 400
    || error.status === 401
    || (error.status === 409 && error.code !== "checkpoint_version_conflict");
}

function isCheckpointVersionConflict(error: unknown) {
  return error instanceof CapabilityApiError
    && error.status === 409
    && error.code === "checkpoint_version_conflict";
}

function isRetryableCapabilityFailure(error: unknown) {
  if (!(error instanceof CapabilityApiError)) return true;
  return error.status === 429 || error.status >= 500;
}

function retryAfterMs(error: unknown) {
  return error instanceof CapabilityApiError ? error.retryAfterMs : null;
}

function isBroadcastUpdate(value: unknown): value is PendingUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Partial<PendingUpdate>;
  return typeof update.updateId === "string"
    && /^[a-f0-9]{64}$/.test(update.updateId)
    && typeof update.payload === "string"
    && Number.isSafeInteger(update.encryptionVersion);
}

async function defaultRealtimeFactory(
  session: PrivateRealtimeNoteSession,
): Promise<CapabilityRealtimeHandle> {
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  if (!url || !key) throw new Error("Realtime unavailable");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await client.realtime.setAuth(session.realtimeToken);
  const channel = client.channel(session.realtimeTopic, {
    config: {
      private: true,
      broadcast: { self: false, ack: true },
    },
  }) as unknown as RealtimeChannelLike;
  return {
    channel,
    setAuth: (token) => client.realtime.setAuth(token),
    dispose: async () => {
      await channel.unsubscribe();
      client.removeChannel(channel as never);
    },
  };
}

export class CapabilityYjsProvider implements YjsProviderLike {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  slug: string;
  connected = false;

  private session: NoteSession;
  private encryption: Encryption | null;
  private readonly api: CapabilityApi;
  private readonly outbox: CapabilityOutbox;
  private readonly realtimeFactory: CapabilityRealtimeFactory;
  private readonly pollingOnly: boolean;
  private readonly pollingOptions: ProviderPollingDependencies;
  private readonly now: () => number;
  private readonly setTimer: ProviderTimerSetter;
  private readonly clearTimer: ProviderTimerClearer;
  private readonly compactionThresholdUpdates: number;
  private realtime: CapabilityRealtimeHandle | null = null;
  private polling: CapabilityPollingController | null = null;
  private realtimeStartEpoch = 0;
  // A private channel is not authoritative until Supabase confirms
  // SUBSCRIBED. Keep polling available during that handshake so a stalled
  // factory or WebSocket cannot hold durable sync hostage.
  private privateRealtimeAttempt: { epoch: number; token: string } | null = null;
  private syncListeners = new Set<Listener<SyncEvent>>();
  private awarenessListeners = new Set<Listener<Map<number, AwarenessState>>>();
  private pendingPersistence: Promise<void> = Promise.resolve();
  private persistenceEpoch = 0;
  private flushedPersistenceEpoch = 0;
  // Session responses carry both durable state and a short-lived Realtime
  // credential. Keep their network/apply/reconcile lifecycles ordered so a
  // slower response cannot install an older transport after a newer one.
  private sessionOperation: Promise<void> | null = null;
  private flushPromise: Promise<FlushResult> | null = null;
  private pollPromise: Promise<void> | null = null;
  private compactionPromise: Promise<void> | null = null;
  private pendingBytes = 0;
  private lastBroadcastAt = 0;
  private lastSnapshotAt = 0;
  private closing = false;
  private destroyed = false;
  private connectWork: Promise<void> | null = null;
  private refreshTimer: number | null = null;
  private writeFenced = false;
  private terminalSyncFenced = false;
  private terminalSyncError: unknown = null;
  private durableRetryError: unknown = null;
  private durableRetryFailures = 0;
  private durableRetryNotBefore = 0;
  private durableRetryTimer: number | null = null;
  private durableRetryEpoch = 0;
  private durableRetryNeedsSessionRefresh = false;
  private pollingFallback = false;
  private realtimePromotionFailures = 0;
  private realtimePromotionNotBefore = 0;
  private transitionDirty = false;
  private transitionFlushRequested = false;
  private finalFlushRequested = false;
  private sessionApplyEpoch = 0;
  private writeFenceListeners = new Set<Listener<boolean>>();

  constructor(
    readonly access: CapabilityAccess,
    session: NoteSession,
    doc: Y.Doc,
    dependencies: ProviderDependencies = {},
    encryption?: Encryption | null,
  ) {
    if (access.scope !== session.scope) throw new Error("capability scope changed");
    if (access.slug !== null && access.slug !== session.slug) throw new Error("capability locator mismatch");
    this.slug = session.slug;
    this.pollingOnly = dependencies.pollingOnly ?? false;
    this.session = this.pollingOnly ? withoutPrivateRealtime(session) : session;
    this.doc = doc;
    this.encryption = encryption ?? null;
    this.api = dependencies.api ?? createCapabilityApi();
    this.outbox = dependencies.outbox ?? new CapabilityOutbox();
    this.realtimeFactory = dependencies.realtimeFactory ?? defaultRealtimeFactory;
    this.pollingOptions = dependencies.polling ?? {};
    this.now = dependencies.now ?? dependencies.polling?.now ?? Date.now;
    this.setTimer = dependencies.timers?.setTimer
      ? (handler, timeout) => dependencies.timers!.setTimer!(handler, timeout)
      : defaultSetTimer;
    this.clearTimer = dependencies.timers?.clearTimer
      ? (timer) => dependencies.timers!.clearTimer!(timer)
      : defaultClearTimer;
    this.compactionThresholdUpdates = Math.max(
      1,
      Math.floor(dependencies.compactionThresholdUpdates ?? DEFAULT_COMPACTION_THRESHOLD_UPDATES),
    );
    this.awareness = new Awareness(doc);
  }

  setEncryption(encryption: Encryption | null) {
    if (this.encryption !== encryption) this.sessionApplyEpoch += 1;
    this.encryption = encryption;
  }

  setExpectedEncrypted(expected: boolean | null) {
    if (expected !== null && expected !== this.session.encryption.enabled) {
      this.emitSync({ type: "error", message: "encryption mode changed" });
    }
  }

  getSession() {
    return this.session;
  }

  getPendingBytes() { return this.pendingBytes; }
  getLastBroadcastAt() { return this.lastBroadcastAt; }
  getLastSnapshotAt() { return this.lastSnapshotAt; }
  hasUnflushedLocalChanges() { return this.pendingBytes > 0; }

  onWriteFence(listener: Listener<boolean>) {
    this.writeFenceListeners.add(listener);
    listener(this.writeFenced);
    return () => this.writeFenceListeners.delete(listener);
  }

  private setWriteFence(value: boolean) {
    this.writeFenced = value;
    for (const listener of this.writeFenceListeners) {
      try { listener(value); } catch { /* isolate UI listeners */ }
    }
  }

  private canContinueSessionTransition() {
    return !this.destroyed
      && !this.closing
      && !this.writeFenced
      && !this.terminalSyncFenced;
  }

  private assertSyncRequestAllowed(
    allowWhileClosing = false,
    allowWhileWriteFenced = false,
  ) {
    if (
      this.destroyed
      || (!allowWhileClosing && this.closing)
      || (!allowWhileWriteFenced && this.writeFenced)
      || this.terminalSyncFenced
    ) {
      throw this.terminalSyncError ?? new Error("capability writes are fenced");
    }
  }

  private isCurrentPrivateStart(
    startEpoch: number,
    session: PrivateRealtimeNoteSession,
    allowWhileWriteFenced = false,
  ) {
    return !this.destroyed
      && !this.closing
      && (!this.writeFenced || allowWhileWriteFenced)
      && this.realtimeStartEpoch === startEpoch
      && this.session.syncTransport === "private-realtime"
      && this.session.realtimeToken === session.realtimeToken;
  }

  private isCurrentPrivateHandle(
    realtime: CapabilityRealtimeHandle,
    startEpoch: number,
    allowWhileWriteFenced = false,
  ) {
    // Session credentials are installed before setAuth resolves. A channel
    // error in that small window still belongs to this handle; lifecycle epoch
    // and handle identity, not the old token string, determine authority.
    return !this.destroyed
      && !this.closing
      && (!this.writeFenced || allowWhileWriteFenced)
      && this.realtimeStartEpoch === startEpoch
      && this.session.syncTransport === "private-realtime"
      && this.realtime === realtime;
  }

  private isCurrentPrivateAttempt(
    startEpoch: number,
    session: PrivateRealtimeNoteSession,
    allowWhileWriteFenced = false,
  ) {
    return this.isCurrentPrivateStart(startEpoch, session, allowWhileWriteFenced)
      && this.privateRealtimeAttempt?.epoch === startEpoch
      && this.privateRealtimeAttempt.token === session.realtimeToken;
  }

  private canPoll() {
    return this.canContinueSessionTransition()
      && (
        this.session.syncTransport === "polling"
        || this.pollingFallback
        || this.privateRealtimeAttempt !== null
      );
  }

  private isDurableRetryCoolingDown() {
    return this.durableRetryNotBefore > this.now();
  }

  private clearDurableRetryTimer() {
    if (this.durableRetryTimer === null) return;
    this.clearTimer(this.durableRetryTimer);
    this.durableRetryTimer = null;
  }

  private clearDurableRetry(epoch?: number) {
    if (epoch !== undefined && epoch !== this.durableRetryEpoch) return;
    this.clearDurableRetryTimer();
    this.durableRetryError = null;
    this.durableRetryFailures = 0;
    this.durableRetryNotBefore = 0;
    this.durableRetryNeedsSessionRefresh = false;
  }

  private reportPollingCooldown() {
    const remaining = this.durableRetryNotBefore - this.now();
    if (remaining > 0) this.polling?.reportExternalFailure({ retryAfterMs: remaining });
  }

  private scheduleDurableRetry() {
    this.clearDurableRetryTimer();
    if (
      this.destroyed
      || this.closing
      || this.writeFenced
      || this.terminalSyncFenced
      || !this.isDurableRetryCoolingDown()
      // A polling controller owns the actual retry wake-up for its transport.
      || this.polling
    ) return;
    const delay = Math.min(
      Math.max(0, this.durableRetryNotBefore - this.now()),
      2_147_000_000,
    );
    this.durableRetryTimer = this.setTimer(() => {
      this.durableRetryTimer = null;
      void this.resumeDurableRetry().catch(() => {});
    }, delay);
  }

  private async resumeDurableRetry() {
    if (this.destroyed || this.closing || this.writeFenced || this.terminalSyncFenced) return;
    if (this.isDurableRetryCoolingDown()) {
      this.scheduleDurableRetry();
      return;
    }
    if (
      this.durableRetryNeedsSessionRefresh
      && this.session.syncTransport === "private-realtime"
      && !this.pollingFallback
    ) {
      await this.refreshNow(true);
      return;
    }
    if (this.canPoll()) {
      await this.pollNow();
      return;
    }
    await this.flushNow();
  }

  private recordDurableRetry(
    error: unknown,
    needsSessionRefresh = false,
    notifyPolling = true,
  ) {
    if (
      this.destroyed
      || this.closing
      || this.terminalSyncFenced
      || !isRetryableCapabilityFailure(error)
    ) return;
    this.durableRetryEpoch += 1;
    this.durableRetryFailures = Math.min(this.durableRetryFailures + 1, 30);
    const localDelay = nextDelay({
      hidden: this.pollingOptions.isHidden?.()
        ?? (typeof document !== "undefined" && document.visibilityState === "hidden"),
      failures: this.durableRetryFailures,
      random: this.pollingOptions.random,
    });
    const serverDelay = retryAfterMs(error) ?? 0;
    this.durableRetryNotBefore = Math.max(
      this.durableRetryNotBefore,
      this.now() + Math.max(localDelay, serverDelay),
    );
    this.durableRetryError = error;
    this.durableRetryNeedsSessionRefresh ||= needsSessionRefresh;
    if (notifyPolling) this.polling?.reportExternalFailure(error);
    this.scheduleDurableRetry();
  }

  private recordRealtimePromotionFailure() {
    this.realtimePromotionFailures = Math.min(this.realtimePromotionFailures + 1, 30);
    const delay = nextDelay({
      hidden: this.pollingOptions.isHidden?.()
        ?? (typeof document !== "undefined" && document.visibilityState === "hidden"),
      failures: this.realtimePromotionFailures,
      random: this.pollingOptions.random,
    });
    this.realtimePromotionNotBefore = Math.max(this.realtimePromotionNotBefore, this.now() + delay);
  }

  private canAttemptRealtimePromotion() {
    return this.realtimePromotionNotBefore <= this.now();
  }

  private clearRealtimePromotionBackoff() {
    this.realtimePromotionFailures = 0;
    this.realtimePromotionNotBefore = 0;
  }

  private async fallbackToPolling(error: unknown) {
    if (!this.canContinueSessionTransition()) return;
    this.recordRealtimePromotionFailure();
    this.stopPrivateRealtime();
    if (!this.canContinueSessionTransition()) return;
    this.pollingFallback = true;
    this.emitSync({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    this.startPolling();
  }

  private async fenceTerminalSync(error: unknown) {
    if (this.terminalSyncFenced) return;
    this.sessionApplyEpoch += 1;
    this.terminalSyncFenced = true;
    this.terminalSyncError = error;
    this.setWriteFence(true);
    this.doc.off("update", this.handleDocUpdate);
    this.doc.off("update", this.handleTransitionDocUpdate);
    this.stopPolling();
    this.clearDurableRetryTimer();
    this.stopPrivateRealtime();
  }

  private async handleSyncFailure(error: unknown) {
    if (isSyncFencingCapabilityFailure(error)) await this.fenceTerminalSync(error);
    this.emitSync({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private writableAuthority(): {
    scope: WritableCapabilityScope;
    generation: number;
  } {
    if (this.access.scope === "view") throw new Error("view capability is read only");
    return { scope: this.access.scope, generation: this.session.generation };
  }

  onSyncEvent(listener: Listener<SyncEvent>) {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  onAwareness(listener: Listener<Map<number, AwarenessState>>) {
    this.awarenessListeners.add(listener);
    listener(this.awareness.getStates() as Map<number, AwarenessState>);
    return () => this.awarenessListeners.delete(listener);
  }

  private emitSync(event: SyncEvent) {
    for (const listener of this.syncListeners) {
      try { listener(event); } catch { /* isolate UI listeners */ }
    }
  }

  private trackPersistence(work: () => Promise<void>) {
    this.persistenceEpoch += 1;
    this.pendingPersistence = this.pendingPersistence.then(work, work);
    return this.pendingPersistence;
  }

  private serializeSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    let result: Promise<T>;
    if (this.sessionOperation) {
      result = this.sessionOperation.then(operation, operation);
    } else {
      try {
        // Preserve the immediate request start that callers use for lifecycle
        // fencing, while still serializing every later response behind it.
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    }
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.sessionOperation = tail;
    void tail.then(() => {
      if (this.sessionOperation === tail) this.sessionOperation = null;
    });
    return result;
  }

  async whenLocalUpdatesPersisted() {
    await this.pendingPersistence;
  }

  private async decodeStoredUpdateForSession(
    update: PendingUpdate,
    session: NoteSession,
    encryption: Encryption | null,
  ): Promise<Uint8Array> {
    const stored = decodeCapabilityPayload(update.payload);
    if (stored.byteLength === 0 || stored.byteLength > session.payloadLimitBytes) {
      throw new Error("update payload outside audited limit");
    }
    if (await capabilityPayloadId(stored) !== update.updateId) throw new Error("update hash mismatch");
    if (update.encryptionVersion !== session.encryption.version) {
      throw new Error("update encryption version mismatch");
    }
    if (!session.encryption.enabled) return stored;
    if (!encryption) throw new Error("encrypted note is locked");
    return encryption.decrypt(stored);
  }

  private decodeStoredUpdate(update: PendingUpdate): Promise<Uint8Array> {
    return this.decodeStoredUpdateForSession(update, this.session, this.encryption);
  }

  private canApplyDurableSession(epoch: number, allowWhileWriteFenced: boolean) {
    return !this.destroyed
      && !this.closing
      && !this.terminalSyncFenced
      && (allowWhileWriteFenced || !this.writeFenced)
      && this.sessionApplyEpoch === epoch;
  }

  private async applyDurableSession(
    next: NoteSession,
    { allowWhileWriteFenced = false }: { allowWhileWriteFenced?: boolean } = {},
  ): Promise<boolean> {
    if (this.access.slug !== null && next.slug !== this.access.slug) {
      throw new Error("capability locator mismatch");
    }
    if (
      next.noteId !== this.session.noteId
      || next.scope !== this.access.scope
      || next.generation !== this.session.generation
    ) {
      throw new Error("note session changed");
    }
    const epoch = ++this.sessionApplyEpoch;
    const encryption = this.encryption;
    const staged: Uint8Array[] = [];
    if (next.checkpointPayload) {
      const checkpoint = {
        updateId: await capabilityPayloadId(decodeCapabilityPayload(next.checkpointPayload)),
        payload: next.checkpointPayload,
        encryptionVersion: next.checkpointEncryptionVersion ?? next.encryption.version,
      };
      if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
      staged.push(await this.decodeStoredUpdateForSession(checkpoint, next, encryption));
      if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
    }
    const ordered = [...next.missingUpdates].sort((a, b) => a.sequence - b.sequence);
    for (const update of ordered) {
      staged.push(await this.decodeStoredUpdateForSession(update, next, encryption));
      if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
    }
    if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
    for (const bytes of staged) {
      if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
      Y.applyUpdate(this.doc, bytes, "capability-session");
    }
    if (!this.canApplyDurableSession(epoch, allowWhileWriteFenced)) return false;
    this.session = this.pollingOnly ? withoutPrivateRealtime(next) : next;
    if (this.session.syncTransport === "polling") this.pollingFallback = false;
    if (next.syncStatus === "read_only_quarantine" && this.access.scope !== "view") {
      await this.fenceTerminalSync(new Error("note is read only"));
    }
    return true;
  }

  private async applyPendingOutbox() {
    if (this.access.scope === "view") {
      this.pendingBytes = 0;
      return;
    }
    const epoch = this.sessionApplyEpoch;
    const authority = this.writableAuthority();
    const pending = await this.outbox.list(
      this.session.noteId,
      authority.scope,
      authority.generation,
      Number.MAX_SAFE_INTEGER,
    );
    if (!this.canApplyDurableSession(epoch, false)) return;
    this.pendingBytes = pending.reduce((sum, row) => sum + decodeCapabilityPayload(row.payload).byteLength, 0);
    for (const update of pending) {
      const bytes = await this.decodeStoredUpdate(update);
      if (!this.canApplyDurableSession(epoch, false)) return;
      Y.applyUpdate(this.doc, bytes, "capability-outbox");
    }
  }

  async connect(identity: { name: string; color: string }) {
    if (this.destroyed || this.closing) return;
    if (this.connectWork) return this.connectWork;
    this.connectWork = this.connectOnce(identity);
    return this.connectWork;
  }

  private async connectOnce(identity: { name: string; color: string }) {
    if (this.destroyed || this.closing) return;
    if (!await this.applyDurableSession(this.session)) return;
    if (this.destroyed || this.closing) return;
    await this.applyPendingOutbox();
    if (this.destroyed || this.closing) return;
    this.awareness.setLocalState({ user: identity });
    if (this.access.scope !== "view") this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);

    if (this.session.syncTransport === "private-realtime") {
      this.startPrivateRealtime(this.session);
    } else {
      this.stopPrivateRealtime();
      this.startPolling();
    }
    void this.flushNow();
  }

  private startPolling() {
    if (!this.canPoll() || this.polling) return;
    const { isHidden, ...options } = this.pollingOptions;
    this.polling = new CapabilityPollingController({
      ...options,
      run: () => this.pollNow(),
      isHidden: isHidden ?? (() =>
        typeof document !== "undefined" && document.visibilityState === "hidden"),
    });
    this.polling.start();
    if (this.isDurableRetryCoolingDown()) this.reportPollingCooldown();
  }

  private stopPolling() {
    const polling = this.polling;
    this.polling = null;
    polling?.stop();
  }

  private pollNow(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = (async () => {
      let failureAlreadyReported = false;
      const durableRetryEpoch = this.durableRetryEpoch;
      try {
        if (this.isDurableRetryCoolingDown()) {
          this.reportPollingCooldown();
          return;
        }
        if (!this.canPoll()) return;
        if (this.access.scope !== "view") {
          const flushed = await this.flushNow(false, false);
          if (flushed.ok === false) {
            failureAlreadyReported = true;
            throw flushed.error;
          }
        }
        if (!this.canPoll()) return;
        await this.serializeSessionOperation(async () => {
          if (!this.canPoll()) return;
          const previous = this.session;
          const next = await this.api.openSession(this.access.token, this.session.currentSequence);
          if (!this.canPoll()) return;
          if (!await this.applyDurableSession(next)) return;
          if (!this.canContinueSessionTransition()) return;
          await this.reconcileTransport(previous, next);
        });
        this.clearDurableRetry(durableRetryEpoch);
        if (this.canPoll() && !this.connected) {
          this.connected = true;
          this.emitSync({ type: "online" });
        }
      } catch (error) {
        if (!failureAlreadyReported && !this.destroyed && !this.closing) {
          await this.handleSyncFailure(error);
          this.recordDurableRetry(error, true, false);
        }
        if (!this.destroyed && !this.closing && this.connected) {
          this.connected = false;
          this.emitSync({ type: "offline" });
        }
        throw error;
      }
    })().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  private startPrivateRealtime(
    session: PrivateRealtimeNoteSession,
    allowWhileWriteFenced = false,
  ): void {
    if (this.destroyed || this.closing || (this.writeFenced && !allowWhileWriteFenced)) return;
    this.stopPrivateRealtime();
    const startEpoch = ++this.realtimeStartEpoch;
    this.privateRealtimeAttempt = { epoch: startEpoch, token: session.realtimeToken };
    this.startPolling();
    void this.finishPrivateRealtimeStart(startEpoch, session, allowWhileWriteFenced);
  }

  private async finishPrivateRealtimeStart(
    startEpoch: number,
    session: PrivateRealtimeNoteSession,
    allowWhileWriteFenced = false,
  ): Promise<void> {
    try {
      const realtime = await this.realtimeFactory(session);
      if (!this.isCurrentPrivateAttempt(startEpoch, session, allowWhileWriteFenced)) {
        void Promise.resolve().then(() => realtime.dispose()).catch(() => {});
        return;
      }

      this.realtime = realtime;
      const channel = realtime.channel;
      channel.on("broadcast", { event: "y-update" }, async ({ payload }) => {
        if (
          !isBroadcastUpdate(payload)
          || !this.canReceivePrivateRealtimeUpdate(realtime)
        ) return;
        try {
          const stored = decodeCapabilityPayload(payload.payload);
          const transport: PendingUpdate = {
            updateId: payload.updateId,
            payload: encodeCapabilityPayload(stored),
            encryptionVersion: payload.encryptionVersion,
          };
          if (this.access.scope === "view") {
            const bytes = await this.decodeStoredUpdate(transport);
            if (!this.canReceivePrivateRealtimeUpdate(realtime)) return;
            Y.applyUpdate(this.doc, bytes, "capability-remote");
            return;
          }
          const canonical: OutboxUpdate = {
            noteId: this.session.noteId,
            scope: this.writableAuthority().scope,
            generation: this.session.generation,
            ...transport,
            createdAt: this.now(),
          };
          await this.trackPersistence(async () => {
            await this.outbox.enqueue(canonical);
            this.pendingBytes += stored.byteLength;
          });
          if (!this.canReceivePrivateRealtimeUpdate(realtime)) return;
          const bytes = await this.decodeStoredUpdate(canonical);
          if (!this.canReceivePrivateRealtimeUpdate(realtime)) return;
          Y.applyUpdate(this.doc, bytes, "capability-remote");
          if (this.canReceivePrivateRealtimeUpdate(realtime)) void this.flushNow();
        } catch {
          if (this.canReceivePrivateRealtimeUpdate(realtime)) {
            this.emitSync({ type: "error", message: "invalid peer update" });
          }
        }
      });
      channel.on("broadcast", { event: "awareness" }, ({ payload }) => {
        if (!this.canReceivePrivateRealtimeUpdate(realtime)) return;
        try {
          if (!payload || typeof payload !== "object") return;
          const encoded = (payload as { update?: unknown }).update;
          if (typeof encoded !== "string") return;
          const bytes = decodeCapabilityPayload(encoded);
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_AWARENESS_BYTES) return;
          applyAwarenessUpdate(this.awareness, bytes, "capability-remote");
        } catch { /* discard malformed awareness */ }
      });
      await channel.subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          if (
            !this.isCurrentPrivateAttempt(startEpoch, session, allowWhileWriteFenced)
            || this.realtime !== realtime
          ) return;
          this.privateRealtimeAttempt = null;
          this.pollingFallback = false;
          this.clearRealtimePromotionBackoff();
          this.stopPolling();
          const wasOffline = !this.connected;
          this.connected = true;
          if (wasOffline) this.emitSync({ type: "online" });
          this.broadcastAwareness();
          this.schedulePrivateRefresh();
          void this.flushNow();
        } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
          if (
            !this.isCurrentPrivateAttempt(startEpoch, session, allowWhileWriteFenced)
            && !this.isCurrentPrivateHandle(realtime, startEpoch, allowWhileWriteFenced)
          ) return;
          if (this.connected) this.emitSync({ type: "offline" });
          this.connected = false;
          await this.fallbackToPolling(new Error("private Realtime unavailable"));
        }
      });
    } catch (error) {
      if (this.isCurrentPrivateAttempt(startEpoch, session, allowWhileWriteFenced)) {
        await this.fallbackToPolling(error);
      }
    }
  }

  private canReceivePrivateRealtimeUpdate(realtime: CapabilityRealtimeHandle) {
    return !this.destroyed
      && !this.closing
      && !this.writeFenced
      && this.realtime === realtime
      && this.privateRealtimeAttempt === null;
  }

  private stopPrivateRealtime(): void {
    // Invalidate any factory call that has not resolved before detaching the
    // active handle. A subsequent start receives its own fresh epoch.
    this.privateRealtimeAttempt = null;
    this.realtimeStartEpoch += 1;
    if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    const realtime = this.realtime;
    this.realtime = null;
    this.connected = false;
    if (!realtime) return;
    // Removing a Supabase channel can wait for a network timeout. Detach all
    // local authority synchronously, then let transport cleanup finish alone.
    void Promise.resolve().then(() => realtime.dispose()).catch(() => {});
  }

  private async reconcileTransport(
    previous: NoteSession,
    next: NoteSession,
    allowWhileWriteFenced = false,
  ): Promise<void> {
    if (this.writeFenced && !allowWhileWriteFenced) {
      this.stopPolling();
      this.stopPrivateRealtime();
      return;
    }

    if (this.pollingOnly) {
      this.pollingFallback = false;
      this.clearRealtimePromotionBackoff();
      this.stopPrivateRealtime();
      this.startPolling();
      return;
    }

    if (next.syncTransport === "polling") {
      this.pollingFallback = false;
      this.clearRealtimePromotionBackoff();
      this.stopPrivateRealtime();
      this.startPolling();
      return;
    }

    if (this.pollingFallback && !this.canAttemptRealtimePromotion()) {
      this.startPolling();
      return;
    }

    // A factory/subscribe attempt is deliberately nonblocking so durable
    // polling can progress. Reuse a same-token attempt; supersede only when a
    // newer session authorizes a different Realtime credential.
    if (this.privateRealtimeAttempt) {
      if (this.privateRealtimeAttempt.token === next.realtimeToken) {
        this.startPolling();
        return;
      }
      this.startPrivateRealtime(next, allowWhileWriteFenced);
      return;
    }

    if (previous.syncTransport === "private-realtime" && this.realtime) {
      const realtime = this.realtime;
      const realtimeEpoch = this.realtimeStartEpoch;
      this.stopPolling();
      try {
        await realtime.setAuth(next.realtimeToken);
        // A channel error can detach this exact handle while platform Auth is
        // refreshing. Do not let the late setAuth resolution disable the
        // already-started polling fallback.
        if (
          this.destroyed
          || this.closing
          || this.writeFenced
          || this.realtime !== realtime
          || this.realtimeStartEpoch !== realtimeEpoch
          || this.session.syncTransport !== "private-realtime"
          || this.session.realtimeToken !== next.realtimeToken
        ) {
          this.startPolling();
          return;
        }
        this.pollingFallback = false;
        this.clearRealtimePromotionBackoff();
        this.schedulePrivateRefresh();
      } catch (error) {
        if (this.isCurrentPrivateHandle(realtime, realtimeEpoch, allowWhileWriteFenced)) {
          await this.fallbackToPolling(error);
        }
        return;
      }
    } else {
      this.startPrivateRealtime(next, allowWhileWriteFenced);
    }
  }

  private isLocallyWritableUpdate(origin: unknown) {
    return !this.destroyed
      && !this.closing
      && !this.terminalSyncFenced
      && this.access.scope !== "view"
      && origin !== "capability-session"
      && origin !== "capability-remote"
      && origin !== "capability-outbox";
  }

  private async persistWritableUpdate(update: Uint8Array) {
    let stored = update;
    if (this.session.encryption.enabled) {
      if (!this.encryption) throw new Error("encrypted note is locked");
      stored = await this.encryption.encrypt(update);
    }
    if (stored.byteLength === 0 || stored.byteLength > this.session.payloadLimitBytes) {
      throw new Error("update payload outside audited limit");
    }
    const pending: OutboxUpdate = {
      noteId: this.session.noteId,
      scope: this.writableAuthority().scope,
      generation: this.session.generation,
      updateId: await capabilityPayloadId(stored),
      payload: encodeCapabilityPayload(stored),
      encryptionVersion: this.session.encryption.version,
      createdAt: this.now(),
    };
    await this.outbox.enqueue(pending);
    this.pendingBytes += stored.byteLength;
    this.broadcastStoredUpdate(pending);
  }

  private emitPersistenceError(error: unknown) {
    this.emitSync({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.writeFenced || !this.isLocallyWritableUpdate(origin)) return;
    void this.trackPersistence(() => this.persistWritableUpdate(update))
      .then(() => this.flushNow())
      .catch((error) => this.emitPersistenceError(error));
  };

  private broadcastStoredUpdate(update: PendingUpdate) {
    if (
      this.writeFenced
      || !this.connected
      || !this.realtime
      || this.privateRealtimeAttempt !== null
      || decodeCapabilityPayload(update.payload).byteLength > MAX_REALTIME_UPDATE_BYTES
    ) return;
    void this.realtime.channel.send({
      type: "broadcast",
      event: "y-update",
      payload: update,
    });
    this.lastBroadcastAt = this.now();
  }

  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const states = this.awareness.getStates() as Map<number, AwarenessState>;
    this.awarenessListeners.forEach((listener) => listener(states));
    if (origin === "capability-remote") return;
    this.broadcastAwareness([...changes.added, ...changes.updated, ...changes.removed]);
  };

  private broadcastAwareness(clients?: number[]) {
    if (!this.connected || !this.realtime || this.privateRealtimeAttempt !== null) return;
    const bytes = encodeAwarenessUpdate(
      this.awareness,
      clients ?? Array.from(this.awareness.getStates().keys()),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AWARENESS_BYTES) return;
    void this.realtime.channel.send({
      type: "broadcast",
      event: "awareness",
      payload: { update: encodeCapabilityPayload(bytes) },
    });
  }

  private compactIfNeeded(): Promise<void> {
    if (
      this.destroyed
      || this.closing
      || this.writeFenced
      || this.access.scope === "view"
      || this.session.currentSequence - this.session.checkpointSequence < this.compactionThresholdUpdates
    ) return Promise.resolve();
    if (this.compactionPromise) return this.compactionPromise;

    this.compactionPromise = (async () => {
      const throughSequence = this.session.currentSequence;
      const expectedCheckpointVersion = this.session.checkpointVersion ?? 0;
      const expectedEncryptionVersion = this.session.encryption.version;
      let stored = Y.encodeStateAsUpdate(this.doc);
      if (this.session.encryption.enabled) {
        if (!this.encryption) throw new Error("encrypted note is locked");
        stored = await this.encryption.encrypt(stored);
      }
      if (stored.byteLength === 0 || stored.byteLength > this.session.payloadLimitBytes) {
        throw new Error("checkpoint payload outside audited limit");
      }
      const response = await this.serializeSessionOperation(async () => {
        this.assertSyncRequestAllowed();
        const previous = this.session;
        const response = await this.api.sync(this.access.token, {
          updates: [],
          expectedEncryptionVersion,
          afterSequence: throughSequence,
          checkpoint: {
            checkpointId: await capabilityPayloadId(stored),
            payload: encodeCapabilityPayload(stored),
            throughSequence,
            expectedCheckpointVersion,
          },
        });
        this.assertSyncRequestAllowed();
        if (!await this.applyDurableSession(response.session)) {
          throw new Error("session application superseded");
        }
        await this.reconcileTransport(previous, response.session);
        return response;
      });
      if (response.session.checkpointSequence < throughSequence) {
        throw new Error("server did not advance checkpoint");
      }
    })().catch(async (error) => {
      if (!isCheckpointVersionConflict(error)) throw error;
      // Another writer can legitimately win checkpoint CAS. Refresh the
      // checkpoint cursor without re-entering flushNow so future compactions
      // use the winning version instead of retrying stale state forever.
      await this.serializeSessionOperation(async () => {
        if (!this.canContinueSessionTransition()) return;
        const previous = this.session;
        const next = await this.api.openSession(this.access.token, this.session.currentSequence);
        if (!this.canContinueSessionTransition()) return;
        if (!await this.applyDurableSession(next)) return;
        if (!this.canContinueSessionTransition()) return;
        await this.reconcileTransport(previous, next);
      });
      this.emitSync({ type: "error", message: error.message });
    }).finally(() => {
      this.compactionPromise = null;
    });
    return this.compactionPromise;
  }

  flushNow(
    keepalive = false,
    notifyPolling = true,
    permissions: FlushPermissions = {},
  ): Promise<FlushResult> {
    const requiredPersistenceEpoch = this.persistenceEpoch;
    if (this.destroyed || this.access.scope === "view") return Promise.resolve({ ok: true });
    if (this.terminalSyncFenced) {
      return Promise.resolve({
        ok: false,
        error: this.terminalSyncError ?? new Error("capability writes are fenced"),
      });
    }
    if (this.isDurableRetryCoolingDown()) {
      return Promise.resolve({
        ok: false,
        error: this.durableRetryError ?? new Error("durable sync is cooling down"),
      });
    }
    if (this.flushPromise) {
      return this.flushPromise.then((result) => {
        if (
          !result.ok
          || this.destroyed
          || this.terminalSyncFenced
          || this.flushedPersistenceEpoch >= requiredPersistenceEpoch
        ) return result;
        return this.flushNow(keepalive, notifyPolling, permissions);
      });
    }
    this.flushPromise = (async () => {
      const durableRetryEpoch = this.durableRetryEpoch;
      try {
        await this.pendingPersistence;
        const authority = this.writableAuthority();
        while (!this.destroyed && !this.terminalSyncFenced) {
        // Capture before inspecting IndexedDB. A local update can be queued
        // between list() and the later pendingPersistence await; that empty
        // read must not satisfy a caller's durability barrier.
        const persistenceEpoch = this.persistenceEpoch;
        const rows = await this.outbox.list(
          this.session.noteId,
          authority.scope,
          authority.generation,
          100,
        );
        if (rows.length === 0) {
          this.pendingBytes = 0;
          if (!keepalive) {
            try {
              await this.compactIfNeeded();
            } catch (error) {
              if (!this.destroyed && !this.closing) {
                await this.handleSyncFailure(error);
                this.recordDurableRetry(error, false, notifyPolling);
              }
              return { ok: false, error } as const;
            }
          }
          await this.pendingPersistence;
          if (this.persistenceEpoch !== persistenceEpoch) continue;
          this.flushedPersistenceEpoch = Math.max(this.flushedPersistenceEpoch, persistenceEpoch);
          this.clearDurableRetry(durableRetryEpoch);
          return { ok: true } as const;
        }
        const selected: OutboxUpdate[] = [];
        let bytes = 0;
        for (const row of rows) {
          const size = decodeCapabilityPayload(row.payload).byteLength;
          if (keepalive && selected.length > 0 && bytes + size > MAX_KEEPALIVE_BATCH_BYTES) break;
          selected.push(row);
          bytes += size;
        }
        try {
          const response = await this.serializeSessionOperation(async () => {
            const allowWhileClosing = permissions.allowWhileClosing || this.finalFlushRequested;
            const allowWhileWriteFenced = permissions.allowWhileWriteFenced
              || this.transitionFlushRequested;
            this.assertSyncRequestAllowed(allowWhileClosing, allowWhileWriteFenced);
            const previous = this.session;
            const response = await this.api.sync(this.access.token, {
              updates: selected.map(({ updateId, payload, encryptionVersion }) => ({
                updateId,
                payload,
                encryptionVersion,
              })),
              expectedEncryptionVersion: this.session.encryption.version,
              afterSequence: this.session.currentSequence,
            }, keepalive);
            if (!this.closing) {
              this.assertSyncRequestAllowed(false, allowWhileWriteFenced);
              if (!await this.applyDurableSession(response.session, { allowWhileWriteFenced })) {
                throw new Error("session application superseded");
              }
              await this.reconcileTransport(previous, response.session, allowWhileWriteFenced);
            }
            return response;
          });
          const acknowledged = new Set(response.acknowledgements.map((item) => item.updateId));
          const expected = selected.map((item) => item.updateId).filter((id) => acknowledged.has(id));
          if (expected.length === 0) throw new Error("server did not acknowledge update batch");
          await this.outbox.acknowledge(
            this.session.noteId,
            authority.scope,
            authority.generation,
            expected,
          );
          const remaining = await this.outbox.list(
            this.session.noteId,
            authority.scope,
            authority.generation,
            Number.MAX_SAFE_INTEGER,
          );
          this.pendingBytes = remaining.reduce((sum, row) => sum + decodeCapabilityPayload(row.payload).byteLength, 0);
          this.lastSnapshotAt = this.now();
          this.emitSync({ type: "synced-durable" });
          this.clearDurableRetry(durableRetryEpoch);
        } catch (error) {
          if (!this.destroyed && !this.closing) {
            await this.handleSyncFailure(error);
            this.recordDurableRetry(error, false, notifyPolling);
          }
          return { ok: false, error } as const;
        }
      }
        if (this.terminalSyncFenced) {
          return {
            ok: false,
            error: this.terminalSyncError ?? new Error("capability writes are fenced"),
          } as const;
        }
        return { ok: true } as const;
      } catch (error) {
        if (!this.destroyed && !this.closing) {
          await this.handleSyncFailure(error);
          this.recordDurableRetry(error, false, notifyPolling);
        }
        return { ok: false, error } as const;
      }
    })().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  flushBeacon() {
    void this.flushNow(true);
  }

  private schedulePrivateRefresh(retryInMs?: number) {
    if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    if (
      this.destroyed
      || this.closing
      || this.writeFenced
      || this.session.syncTransport !== "private-realtime"
      || this.pollingFallback
    ) return;
    if (this.isDurableRetryCoolingDown()) {
      this.scheduleDurableRetry();
      return;
    }
    const expiry = Date.parse(this.session.realtimeExpiresAt);
    if (retryInMs === undefined && !Number.isFinite(expiry)) return;
    const delay = retryInMs ?? Math.max(1_000, expiry - this.now() - 60_000);
    this.refreshTimer = this.setTimer(() => {
      // A timer captured for an old private session must not resurrect a
      // channel after another response has selected polling.
      void this.refreshNow(true).catch(() => {});
    }, Math.min(delay, 2_147_000_000));
  }

  async refreshNow(privateOnly = false) {
    if (
      this.destroyed
      || this.closing
      || this.writeFenced
      || (privateOnly && this.session.syncTransport !== "private-realtime")
    ) return;
    if (this.isDurableRetryCoolingDown()) {
      this.scheduleDurableRetry();
      return;
    }
    const durableRetryEpoch = this.durableRetryEpoch;
    try {
      const refreshed = await this.serializeSessionOperation(async () => {
        if (
          this.destroyed
          || this.closing
          || this.writeFenced
          || (privateOnly && this.session.syncTransport !== "private-realtime")
        ) return false;
        const previous = this.session;
        const next = await this.api.openSession(this.access.token, this.session.currentSequence);
        if (
          this.destroyed
          || this.closing
          || this.writeFenced
        ) return false;
        if (!await this.applyDurableSession(next)) return false;
        if (
          this.destroyed
          || this.closing
          || this.writeFenced
        ) return false;
        await this.reconcileTransport(previous, next);
        return true;
      });
      if (refreshed) {
        this.clearDurableRetry(durableRetryEpoch);
        void this.flushNow();
      }
    } catch (error) {
      if (!this.destroyed && !this.closing) {
        await this.handleSyncFailure(error);
        this.recordDurableRetry(error, true);
        if (!this.terminalSyncFenced) this.schedulePrivateRefresh();
      }
      throw error;
    }
  }

  private handleTransitionDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (!this.isLocallyWritableUpdate(origin)) return;
    this.transitionDirty = true;
    // A browser input task can race React's read-only reconfiguration. Save it
    // under the still-current encryption version before aborting/reloading.
    void this.trackPersistence(() => this.persistWritableUpdate(update))
      .catch((error) => this.emitPersistenceError(error));
  };

  private async openSessionForEncryptionTransition(afterSequence: number) {
    try {
      return await this.api.openSession(this.access.token, afterSequence);
    } catch (error) {
      await this.handleSyncFailure(error);
      throw error;
    }
  }

  /**
   * Terminal fence for an encryption mode transition. The caller must reload
   * after either success or failure so no stale-mode provider can resume.
   */
  async prepareEncryptionTransition(): Promise<NoteSession> {
    if (this.access.scope !== "owner") throw new Error("owner capability required");
    if (this.destroyed || this.closing) throw new Error("provider unavailable");
    if (this.writeFenced) throw new Error("encryption transition already active");

    // Synchronous before the first await: React can make CodeMirror read-only
    // before another browser input task runs, while this observer detects any
    // programmatic mutation that still races the UI commit.
    this.transitionDirty = false;
    this.setWriteFence(true);
    this.transitionFlushRequested = true;
    this.sessionApplyEpoch += 1;
    this.stopPolling();
    this.doc.off("update", this.handleDocUpdate);
    this.doc.on("update", this.handleTransitionDocUpdate);

    await this.pendingPersistence;
    await this.flushNow(false, true, { allowWhileWriteFenced: true });
    if (this.hasUnflushedLocalChanges()) throw new Error("pending updates are not durable");

    this.stopPrivateRealtime();

    // Detach first, then read the durable cursor twice. Any remote writer that
    // wins before the backend row lock advances currentSequence and is merged;
    // a later writer is serialized by the backend encryption-version CAS.
    const first = await this.serializeSessionOperation(async () => {
      const next = await this.openSessionForEncryptionTransition(this.session.currentSequence);
      if (!await this.applyDurableSession(next, { allowWhileWriteFenced: true })) {
        throw new Error("session application superseded");
      }
      return next;
    });
    await this.pendingPersistence;
    await this.flushNow(false, true, { allowWhileWriteFenced: true });
    const second = await this.serializeSessionOperation(async () => {
      const next = await this.openSessionForEncryptionTransition(this.session.currentSequence);
      if (!await this.applyDurableSession(next, { allowWhileWriteFenced: true })) {
        throw new Error("session application superseded");
      }
      return next;
    });
    await this.pendingPersistence;
    await this.flushNow(false, true, { allowWhileWriteFenced: true });
    if (this.hasUnflushedLocalChanges()) throw new Error("pending updates are not durable");
    this.assertEncryptionTransitionStable();
    await this.reconcileTransport(first, second, true);
    return this.session;
  }

  assertEncryptionTransitionStable() {
    if (!this.writeFenced) throw new Error("encryption transition is not fenced");
    if (this.transitionDirty) throw new Error("document changed during encryption transition");
  }

  async destroy() {
    if (this.destroyed || this.closing) return;
    this.finalFlushRequested = true;
    this.closing = true;
    this.sessionApplyEpoch += 1;
    this.clearDurableRetryTimer();
    this.stopPolling();
    this.doc.off("update", this.handleDocUpdate);
    this.doc.off("update", this.handleTransitionDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    try {
      await this.pendingPersistence.catch(() => {});
      if (!this.terminalSyncFenced) {
        await this.flushNow(true, true, { allowWhileClosing: true });
      }
    } finally {
      this.finalFlushRequested = false;
      this.destroyed = true;
      this.stopPrivateRealtime();
      this.outbox.close();
    }
  }
}
