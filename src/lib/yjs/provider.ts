import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { supabase } from "@/integrations/supabase/client";
import { bytesToBase64, base64ToBytes } from "./base64";
import { extractTags } from "@/lib/tags";
import { getEncryptionPinState } from "@/lib/encryption-pin";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * Sync lifecycle events emitted by the provider. UI surfaces (SyncIndicator)
 * consume these to show wire/persistence state.
 *
 *   - "pending"        Local edit produced bytes that have not yet been
 *                       acknowledged by either the broadcast peer fan-out OR
 *                       the durable Postgres snapshot. `bytes` is the running
 *                       total of un-flushed update payload size.
 *   - "synced-peer"    A local update was sent on the broadcast channel.
 *                       Peers in the same room will apply it within ~1 RTT.
 *                       (Does NOT mean durable yet.)
 *   - "synced-durable" Postgres `notes.ydoc_state` was successfully upserted.
 *                       From this moment forward, a fresh client opening the
 *                       slug will see the edit.
 *   - "recovered"      On reconnect, the DB snapshot contained state our
 *                       local doc didn't have, and we merged it in. `bytes`
 *                       is the size delta in the state vector.
 *   - "offline"        Channel dropped / network lost.
 *   - "online"         Channel re-subscribed.
 */
export type SyncEvent =
  | { type: "synced-durable" }
  | { type: "recovered"; bytes: number }
  | { type: "conflict"; bytes: number }
  | { type: "error"; message: string }
  | { type: "offline" }
  | { type: "online" };

type Listener<T> = (v: T) => void;

/**
 * Optional encryption hooks. When provided, all bytes that hit the network
 * (broadcast updates AND the Postgres snapshot in `ydoc_state`) are passed
 * through `encrypt`, and incoming bytes through `decrypt`. The server stays
 * zero-knowledge; only clients holding the key can read.
 */
export type Encryption = {
  encrypt: (bytes: Uint8Array) => Promise<Uint8Array>;
  decrypt: (bytes: Uint8Array) => Promise<Uint8Array>;
};

type SnapshotDraft = {
  state: Uint8Array;
  text: string;
  encryption: Encryption | null;
  localUpdateVersion: number;
};

/** Small provider surface consumed by the editor UI in legacy and capability mode. */
export interface YjsProviderLike {
  doc: Y.Doc;
  awareness: Awareness;
  slug: string;
  connected: boolean;
  setEncryption: (encryption: Encryption | null) => void;
  setExpectedEncrypted: (expected: boolean | null) => void;
  onAwareness: (listener: Listener<Map<number, AwarenessState>>) => () => void;
  onSyncEvent: (listener: Listener<SyncEvent>) => () => void;
  getPendingBytes: () => number;
  getLastBroadcastAt: () => number;
  getLastSnapshotAt: () => number;
  hasUnflushedLocalChanges: () => boolean;
  connect: (
    identity: { name: string; color: string },
    options?: { prefetchedYdocState?: string | null; rowExists?: boolean },
  ) => Promise<void>;
  flushBeacon: () => void;
  destroy: () => Promise<void>;
}

/**
 * Slugs marked as "abandoned" (e.g. renamed away). Any provider whose slug
 * is in this set will silently drop pending snapshot writes and skip the
 * final flush on destroy — this prevents the just-deleted row from being
 * resurrected by a debounced upsert or beacon after rename.
 */
const abandonedSlugs = new Set<string>();
const activeProvidersBySlug = new Map<string, Set<SupabaseYjsProvider>>();
const abandonedSlugCleanups = new Map<string, Set<() => void | Promise<void>>>();
const snapshotWriteTailsBySlug = new Map<string, Promise<void>>();
const ABANDONED_SLUG_STORAGE_PREFIX = "syrin:abandoned-slug:";
const ABANDONED_SLUG_TTL_MS = 5 * 60_000;
// Keep inbound messages below the smallest documented Supabase Broadcast
// payload ceiling (256 KiB, including the JSON envelope). Full-state recovery
// still has the durable Postgres snapshot path when a note is larger.
const MAX_REALTIME_UPDATE_BYTES = 180 * 1024;
const MAX_REALTIME_AWARENESS_BYTES = 32 * 1024;
const REQUEST_STATE_THROTTLE_MS = 1_000;

function enqueueSnapshotWrite(slug: string, write: () => Promise<void>): Promise<void> {
  const previous = snapshotWriteTailsBySlug.get(slug) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(write);
  const settledTail = queued.catch(() => {});
  snapshotWriteTailsBySlug.set(slug, settledTail);
  void settledTail.then(() => {
    if (snapshotWriteTailsBySlug.get(slug) === settledTail) {
      snapshotWriteTailsBySlug.delete(slug);
    }
  });
  return queued;
}

function decodeBoundedBroadcastBytes(payload: unknown, maxBytes: number): Uint8Array | null {
  if (!payload || typeof payload !== "object") return null;
  const encoded = (payload as { update?: unknown }).update;
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  if (encoded.length > maxEncodedChars) return null;
  const bytes = base64ToBytes(encoded);
  return bytes.byteLength > 0 && bytes.byteLength <= maxBytes ? bytes : null;
}

function isRealtimeClientId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

function isSlugAbandoned(slug: string) {
  if (abandonedSlugs.has(slug)) return true;
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(`${ABANDONED_SLUG_STORAGE_PREFIX}${slug}`);
      const ts = raw ? Number(raw) : NaN;
      if (Number.isFinite(ts) && Date.now() - ts < ABANDONED_SLUG_TTL_MS) return true;
      if (raw) localStorage.removeItem(`${ABANDONED_SLUG_STORAGE_PREFIX}${slug}`);
    } catch {
      /* storage unavailable */
    }
  }
  return abandonedSlugs.has(slug);
}

function runAbandonedSlugCleanups(slug: string) {
  abandonedSlugCleanups.get(slug)?.forEach((cleanup) => {
    try {
      void Promise.resolve(cleanup()).catch(() => {});
    } catch {
      /* best-effort local cache cleanup */
    }
  });
}

function markSlugAbandoned(slug: string, persistAcrossTabs: boolean) {
  abandonedSlugs.add(slug);
  activeProvidersBySlug.get(slug)?.forEach((provider) => {
    provider.markAbandoned();
  });
  runAbandonedSlugCleanups(slug);
  // Auto-expire the global slug block so a legitimate later reuse can create
  // a fresh empty row. Providers that were active at rename time stay marked
  // abandoned on the instance and can never resurrect the old content.
  setTimeout(() => abandonedSlugs.delete(slug), ABANDONED_SLUG_TTL_MS);
  if (persistAcrossTabs && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(`${ABANDONED_SLUG_STORAGE_PREFIX}${slug}`, String(Date.now()));
    } catch {
      /* storage unavailable */
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(ABANDONED_SLUG_STORAGE_PREFIX)) return;
    const slug = event.key.slice(ABANDONED_SLUG_STORAGE_PREFIX.length);
    if (slug) markSlugAbandoned(slug, false);
  });
}

/**
 * Snapshot debounce window (ms). Override via VITE_YJS_SNAPSHOT_DEBOUNCE_MS
 * (Vite/browser) or YJS_SNAPSHOT_DEBOUNCE_MS (Node/test env) so rename-race
 * tests can tune this reliably across CI and local machines. Default: 800.
 */
export function getSnapshotDebounceMs(): number {
  let fromRuntime: string | undefined;
  if (typeof localStorage !== "undefined") {
    try {
      fromRuntime = localStorage.getItem("syrin:yjs-snapshot-debounce-ms") ?? undefined;
    } catch {
      fromRuntime = undefined;
    }
  }
  const fromVite =
    typeof import.meta !== "undefined" && import.meta.env
      ? (import.meta.env.VITE_YJS_SNAPSHOT_DEBOUNCE_MS as string | undefined)
      : undefined;
  const fromNode =
    typeof process !== "undefined" && process.env
      ? process.env.YJS_SNAPSHOT_DEBOUNCE_MS
      : undefined;
  const raw = fromRuntime ?? fromVite ?? fromNode;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 800;
}

/** Mark a slug so its still-mounted provider will not write to Postgres. */
function abandonProviderForSlug(slug: string) {
  markSlugAbandoned(slug, true);
}

function unabandonProviderForSlug(slug: string) {
  abandonedSlugs.delete(slug);
  try {
    localStorage.removeItem(`${ABANDONED_SLUG_STORAGE_PREFIX}${slug}`);
  } catch {
    /* storage unavailable */
  }
}

// Retained for local same-origin cleanup; no code path currently calls these
// helpers since Rename/Duplicate were removed.
void abandonProviderForSlug;
void unabandonProviderForSlug;

export type AwarenessState = {
  user?: { name: string; color: string };
} & Record<string, unknown>;

/**
 * SupabaseYjsProvider
 * - Loads initial Y.Doc snapshot from public.notes
 * - Sends/receives Y.update binary patches via Supabase Realtime broadcast
 * - Syncs awareness (presence + cursor) over the same channel
 * - Periodically snapshots the doc back to Postgres (debounced)
 */
export class SupabaseYjsProvider {
  doc: Y.Doc;
  awareness: Awareness;
  slug: string;
  channel: RealtimeChannel | null = null;
  connected = false;
  encryption: Encryption | null = null;
  /**
   * Expected encryption mode of the persisted note row, as most recently
   * observed via the enc-meta fetch. Every content-bearing path is rejected
   * unless this value, the active crypto key, and the durable local pin all
   * agree. `null` is unknown and therefore fails closed.
   */
  private expectedEncrypted: boolean | null = null;

  private snapshotTimer: number | null = null;
  private lastSnapshotAt = 0;
  private lastBroadcastAt = 0;
  private lastStateRequestResponseAt = Number.NEGATIVE_INFINITY;
  private awarenessListeners = new Set<Listener<Map<number, AwarenessState>>>();
  private syncListeners = new Set<Listener<SyncEvent>>();
  private clientId = Math.floor(Math.random() * 0xffffffff);
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  private connectWork: Promise<void> | null = null;
  private abandoned = false;
  // Bytes of local updates that have not yet been durably saved to Postgres.
  // Reset to 0 after each successful `saveSnapshot`. Read via
  // `getPendingBytes()` / `hasUnflushedLocalChanges()`.
  private pendingBytes = 0;
  private localUpdateVersion = 0;
  // The Realtime `subscribe` callback fires `SUBSCRIBED` once on the initial
  // join and again on every auto-reconnect. We treat reconnects specially:
  // peer broadcasts that happened while we were offline are NOT replayed by
  // Supabase Realtime, so we re-read the DB snapshot to pick up anything
  // other clients persisted in the meantime — otherwise our next
  // `saveSnapshot` would overwrite their work.
  private hasSubscribedOnce = false;
  // Phase 2.5 — broadcast batching. Local updates accumulate here and are
  // merged via Y.mergeUpdates then flushed once per animation frame. This
  // collapses 30+ keystrokes/s into ≤60 broadcast messages/s without
  // affecting durability (snapshot debounce is unchanged).
  private pendingUpdates: Uint8Array[] = [];
  private flushScheduled = false;
  // Safety valve — if rAF is starved (background tab) and the queue grows
  // beyond this, flush eagerly to avoid unbounded memory.
  private static readonly MAX_PENDING_UPDATES = 50;
  // Dev-only counters for verifying batching behavior. Tree-shaken in prod
  // (gated reads via `import.meta.env.DEV`). Always incremented so unit
  // tests under vitest can assert without env tweaks.
  private broadcastCount = 0;
  private updateCount = 0;

  /** Dev-only: number of times `flushBroadcasts` has sent on the wire. */
  getBroadcastCount() { return this.broadcastCount; }
  /** Dev-only: number of local doc updates observed by `handleDocUpdate`. */
  getUpdateCount() { return this.updateCount; }

  constructor(slug: string, doc: Y.Doc, encryption?: Encryption) {
    this.slug = slug;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.awareness.clientID = this.clientId;
    this.encryption = encryption ?? null;
    // Track edits synchronously from construction. `connect()` may await an
    // encrypted snapshot before opening Realtime; the editor can already be
    // mounted during that wait, and those edits still need teardown durability.
    this.doc.on("update", this.handleDocUpdate);
    // Bug A fix — listen to native online/offline events so the indicator
    // flips to "offline" instantly instead of waiting ~13–20s for the
    // Realtime channel to time out. We only act on "offline" here; the
    // "online" event is left to the channel SUBSCRIBED callback so we don't
    // emit a false-positive "online" before the WebSocket actually
    // reconnects.
    if (typeof window !== "undefined") {
      window.addEventListener("offline", this.handleNativeOffline);
      // Dev-only: expose for DevTools verification (Phase 2.5 batching audit).
      if (import.meta.env.DEV) {
        (window as unknown as { __provider?: SupabaseYjsProvider }).__provider = this;
      }
    }
    let activeForSlug = activeProvidersBySlug.get(slug);
    if (!activeForSlug) {
      activeForSlug = new Set();
      activeProvidersBySlug.set(slug, activeForSlug);
    }
    activeForSlug.add(this);
  }

  cancelPendingSnapshot() {
    if (this.snapshotTimer) {
      window.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  markAbandoned() {
    this.abandoned = true;
    this.cancelPendingSnapshot();
    this.pendingUpdates = [];
  }

  private isAbandoned() {
    return this.abandoned || isSlugAbandoned(this.slug);
  }

  private handleNativeOffline = () => {
    if (this.destroyed) return;
    if (!this.connected) return;
    this.connected = false;
    this.emitSync({ type: "offline" });
  };

  setEncryption(enc: Encryption | null) {
    this.encryption = enc;
  }

  /** Record the persisted note's encryption mode so writes can be guarded. */
  setExpectedEncrypted(v: boolean | null) {
    this.expectedEncrypted = v;
  }

  /**
   * True unless both independent mode signals authorize this provider.
   *
   * `expectedEncrypted` is the last mode read from Postgres. The durable pin
   * is re-read on every content write so a lock/unlock in another tab
   * immediately disables a provider created under the old mode. Storage
   * denial and an unknown DB mode fail closed.
   */
  private hasEncryptionModeMismatch() {
    const providerEncrypted = !!this.encryption;
    const pinState = getEncryptionPinState(this.slug);
    return this.expectedEncrypted === null
      || this.expectedEncrypted !== providerEncrypted
      || (providerEncrypted ? pinState !== "pinned" : pinState !== "clear");
  }


  onAwareness(cb: Listener<Map<number, AwarenessState>>) {
    this.awarenessListeners.add(cb);
    cb(this.awareness.getStates() as Map<number, AwarenessState>);
    return () => this.awarenessListeners.delete(cb);
  }

  /**
   * Subscribe to sync lifecycle events. See `SyncEvent` for semantics.
   * Returns an unsubscribe function.
   */
  onSyncEvent(cb: Listener<SyncEvent>) {
    this.syncListeners.add(cb);
    return () => this.syncListeners.delete(cb);
  }

  /** Running byte count of local updates not yet durably saved to Postgres. */
  getPendingBytes() {
    return this.pendingBytes;
  }

  /** Timestamp (ms) of last successful broadcast send; 0 if never. */
  getLastBroadcastAt() {
    return this.lastBroadcastAt;
  }

  /** Timestamp (ms) of last successful Postgres snapshot; 0 if never. */
  getLastSnapshotAt() {
    return this.lastSnapshotAt;
  }

  /** True iff there are local edits that haven't been persisted to the DB. */
  hasUnflushedLocalChanges() {
    return this.pendingBytes > 0;
  }

  private emitSync(ev: SyncEvent) {
    this.syncListeners.forEach((cb) => {
      try {
        cb(ev);
      } catch {
        console.warn("sync listener threw");
      }
    });
  }

  /**
   * Connect with an optional pre-fetched snapshot. When the caller already
   * has the `ydoc_state` (e.g. from a single combined query in NotePage), we
   * skip the extra round-trip.
   *
   * Re-entry while connecting or already connected is a no-op (F1): a second
   * pane or remount must not open another Realtime channel or Awareness self.
   */
  async connect(
    identity: { name: string; color: string },
    options?: { prefetchedYdocState?: string | null; rowExists?: boolean },
  ) {
    if (this.destroyed || this.isAbandoned()) return;
    if (this.connectWork) return this.connectWork;
    this.connectWork = this.connectOnce(identity, options);
    return this.connectWork;
  }

  private async connectOnce(
    identity: { name: string; color: string },
    options?: { prefetchedYdocState?: string | null; rowExists?: boolean },
  ) {
    if (this.destroyed || this.isAbandoned()) return;
    // 0) Try the prefetched snapshot stashed by Home page hover/touch.
    // Skip prefetched snapshot when encrypted, since the prefetch path doesn't
    // know the key and the bytes would not be Y.update format yet.
    if (!this.encryption) {
      try {
        const prefetched = sessionStorage.getItem(`note-snapshot:${this.slug}`);
        if (prefetched) {
          sessionStorage.removeItem(`note-snapshot:${this.slug}`);
          try {
            const update = base64ToBytes(prefetched);
            if (update.byteLength > 0) Y.applyUpdate(this.doc, update, "remote-snapshot");
          } catch {
            console.warn("Bad prefetched snapshot");
          }
        }
      } catch {
        // sessionStorage unavailable — ignore.
      }
    }

    // 1) Apply pre-fetched ydoc_state if caller passed one; else fetch now.
    let ydocState = options?.prefetchedYdocState ?? null;
    let rowExists = options?.rowExists ?? null;
    if (ydocState === null && rowExists === null) {
      const { data, error } = await supabase
        .from("notes")
        .select("ydoc_state")
        .eq("slug", this.slug)
        .maybeSingle();
      if (!error) {
        ydocState = data?.ydoc_state ?? null;
        rowExists = !!data;
      }
    }

    if (ydocState) {
      try {
        let update = base64ToBytes(ydocState);
        if (this.encryption && update.byteLength > 0) {
          update = await this.encryption.decrypt(update);
        }
        if (update.byteLength > 0) Y.applyUpdate(this.doc, update, "remote-snapshot");
      } catch {
        console.warn("Failed to apply snapshot");
      }
    } else if (rowExists === false && !this.isAbandoned()) {
      // Create empty row so multiple clients can find the slug immediately.
      void supabase.from("notes").upsert({ slug: this.slug }, { onConflict: "slug" });
    }

    if (this.destroyed || this.isAbandoned()) return;

    // 2) Set local awareness identity.
    this.awareness.setLocalState({
      user: { name: identity.name, color: identity.color },
    });

    // 3) Open broadcast channel.
    this.channel = supabase.channel(`note:${this.slug}`, {
      config: { broadcast: { self: false, ack: false } },
    });

    this.channel.on("broadcast", { event: "y-update" }, async ({ payload }) => {
      try {
        let bytes = decodeBoundedBroadcastBytes(payload, MAX_REALTIME_UPDATE_BYTES);
        if (!bytes) return;
        if (this.encryption) bytes = await this.encryption.decrypt(bytes);
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_REALTIME_UPDATE_BYTES) return;
        Y.applyUpdate(this.doc, bytes, "remote");
      } catch {
        console.warn("Bad remote update");
      }
    });

    this.channel.on("broadcast", { event: "awareness" }, ({ payload }) => {
      try {
        const bytes = decodeBoundedBroadcastBytes(payload, MAX_REALTIME_AWARENESS_BYTES);
        if (!bytes) return;
        applyAwarenessUpdate(this.awareness, bytes, "remote");
      } catch {
        console.warn("Bad awareness");
      }
    });

    // When a new client joins, request the full state from peers.
    this.channel.on("broadcast", { event: "request-state" }, ({ payload }) => {
      const from = payload?.from;
      if (!isRealtimeClientId(from) || from === this.clientId) return;
      const now = Date.now();
      if (now - this.lastStateRequestResponseAt < REQUEST_STATE_THROTTLE_MS) return;
      this.lastStateRequestResponseAt = now;
      const update = Y.encodeStateAsUpdate(this.doc);
      void this.broadcastUpdate(update);
    });

    await this.channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        const wasOffline = !this.connected && this.hasSubscribedOnce;
        this.connected = true;
        if (this.hasSubscribedOnce) {
          // Reconnect path: another client may have snapshotted to Postgres
          // while we were offline. Merge that state in BEFORE we ask peers
          // for updates so a subsequent `saveSnapshot` doesn't clobber it.
          await this.refetchDbSnapshot();
        }
        this.hasSubscribedOnce = true;
        if (wasOffline) {
          this.emitSync({ type: "online" });
          // Bug B fix — flush any pending local edits that piled up while
          // offline. Without this, `pendingBytes` stays > 0 and the stale
          // `lastError` (e.g. "Failed to fetch") never clears until the
          // user types again. A successful saveSnapshot emits
          // `synced-durable`, which the hook uses to clear the error.
          if (!this.isAbandoned() && this.hasUnflushedLocalChanges()) {
            if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer);
            this.snapshotTimer = window.setTimeout(() => this.saveSnapshot(), 0);
          }
        }
        // Ask peers for any newer state.
        await this.channel?.send({
          type: "broadcast",
          event: "request-state",
          payload: { from: this.clientId },
        });
        this.broadcastAwareness();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) this.emitSync({ type: "offline" });
      }
    });

    // 4) Wire up awareness changes after the channel is ready. Document
    // updates are observed from construction so edits cannot fall into the
    // async connection gap above.
    this.awareness.on("update", this.handleAwarenessUpdate);

    // Heartbeat awareness so peers know we are alive.
    const pingId = window.setInterval(() => {
      if (this.destroyed) return;
      // Re-set local state with same data to bump clock.
      const cur = this.awareness.getLocalState();
      if (cur) this.awareness.setLocalState({ ...cur });
    }, 15000);
    this.cleanupFns.push(() => window.clearInterval(pingId));
  }

  private cleanupFns: Array<() => void> = [];

  /**
   * Fetch the latest `ydoc_state` from Postgres and merge it into the local
   * doc. Used on reconnect; `Y.applyUpdate` is merge-safe so this never
   * loses local edits, only adds whatever the DB has that we don't.
   */
  private async refetchDbSnapshot() {
    if (this.destroyed) return;
    try {
      const { data, error } = await supabase
        .from("notes")
        .select("ydoc_state")
        .eq("slug", this.slug)
        .maybeSingle();
      if (error || !data?.ydoc_state) return;
      let update = base64ToBytes(data.ydoc_state);
      if (this.encryption && update.byteLength > 0) {
        update = await this.encryption.decrypt(update);
      }
      if (update.byteLength === 0) return;
      // Compare state vector pre/post-merge so we only emit `recovered` when
      // the DB actually had something we didn't. Without this guard every
      // reconnect would spam a "synced from cloud" toast even if our local
      // doc was already up-to-date.
      // Capture pending state BEFORE merge so we can distinguish:
      //   - recovered: remote had updates we didn't, no local pending
      //   - conflict:  remote had updates we didn't, AND we have local pending
      // (Yjs merges both safely; we just want to surface the right UI affordance.)
      const hadLocal = this.hasUnflushedLocalChanges();
      const before = Y.encodeStateVector(this.doc);
      Y.applyUpdate(this.doc, update, "remote-snapshot");
      const after = Y.encodeStateVector(this.doc);
      // Cheap byte-wise compare — state vectors are deterministic per state.
      let changed = before.byteLength !== after.byteLength;
      if (!changed) {
        for (let i = 0; i < before.byteLength; i++) {
          if (before[i] !== after[i]) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        const bytes = Math.abs(after.byteLength - before.byteLength);
        this.emitSync(
          hadLocal ? { type: "conflict", bytes } : { type: "recovered", bytes },
        );
      }
    } catch {
      console.warn("Refetch snapshot failed");
    }
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.destroyed || this.isAbandoned()) return;
    if (origin === "remote" || origin === "remote-snapshot") return;
    this.updateCount++;
    this.localUpdateVersion++;
    // Counter only — no event emit. UI polls `getPendingBytes()` (Phase 2.2)
    // to avoid render storms when typing fast (~30 keystrokes/s).
    this.pendingBytes += update.byteLength;
    this.queueBroadcast(update);
    this.scheduleSnapshot();
  };

  private queueBroadcast(update: Uint8Array) {
    if (this.destroyed || this.isAbandoned()) return;
    this.pendingUpdates.push(update);
    // Eager flush if rAF starved (background tab) — bounds memory.
    if (this.pendingUpdates.length >= SupabaseYjsProvider.MAX_PENDING_UPDATES) {
      this.flushBroadcasts();
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => this.flushBroadcasts());
    } else {
      setTimeout(() => this.flushBroadcasts(), 16);
    }
  }

  private flushBroadcasts() {
    this.flushScheduled = false;
    if (this.destroyed || this.isAbandoned()) {
      this.pendingUpdates = [];
      return;
    }
    if (this.pendingUpdates.length === 0) return;
    const queue = this.pendingUpdates;
    this.pendingUpdates = [];
    const merged = queue.length === 1 ? queue[0] : Y.mergeUpdates(queue);
    this.broadcastCount++;
    void this.broadcastUpdate(merged);
  }

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    // Notify listeners.
    this.awarenessListeners.forEach((cb) => cb(this.awareness.getStates() as Map<number, AwarenessState>));
    if (origin === "remote") return;
    const changed = added.concat(updated).concat(removed);
    if (changed.length === 0) return;
    this.broadcastAwareness(changed);
  };

  private async broadcastUpdate(update: Uint8Array) {
    if (this.destroyed || this.isAbandoned()) return;
    if (this.hasEncryptionModeMismatch()) return;
    if (!this.channel || !this.connected) return;
    let bytes = update;
    if (this.encryption) {
      try {
        bytes = await this.encryption.encrypt(update);
      } catch {
        console.warn("Encrypt update failed");
        return;
      }
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REALTIME_UPDATE_BYTES) return;
    if (this.destroyed || this.isAbandoned()) return;
    // Encryption can be asynchronous. Re-read the durable pin immediately
    // before sending so a concurrent lock/unlock cannot leak stale-mode bytes.
    if (this.hasEncryptionModeMismatch()) return;
    this.channel.send({
      type: "broadcast",
      event: "y-update",
      payload: { update: bytesToBase64(bytes) },
    });
    // Counter only — no event emit. UI polls `getLastBroadcastAt()`.
    this.lastBroadcastAt = Date.now();
  }

  private broadcastAwareness(clients?: number[]) {
    if (!this.channel || !this.connected) return;
    const update = encodeAwarenessUpdate(
      this.awareness,
      clients ?? Array.from(this.awareness.getStates().keys())
    );
    if (update.byteLength === 0 || update.byteLength > MAX_REALTIME_AWARENESS_BYTES) return;
    this.channel.send({
      type: "broadcast",
      event: "awareness",
      payload: { update: bytesToBase64(update) },
    });
  }

  private scheduleSnapshot() {
    if (this.destroyed || this.isAbandoned()) return;
    if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => this.saveSnapshot(), getSnapshotDebounceMs());
  }

  saveSnapshot(): Promise<void> {
    this.snapshotTimer = null;
    if (this.destroyed || this.isAbandoned()) return Promise.resolve();
    if (this.hasEncryptionModeMismatch()) {
      console.warn("saveSnapshot skipped: encryption mode mismatch", {
        locatorLength: this.slug.length,
        expectedEncrypted: this.expectedEncrypted,
        haveKey: !!this.encryption,
      });
      return Promise.resolve();
    }

    let draft: SnapshotDraft;
    try {
      draft = {
        state: Y.encodeStateAsUpdate(this.doc),
        text: this.doc.getText("content").toString(),
        encryption: this.encryption,
        localUpdateVersion: this.localUpdateVersion,
      };
    } catch (e) {
      console.warn("Snapshot exception");
      this.emitSync({ type: "error", message: e instanceof Error ? e.message : String(e) });
      return Promise.resolve();
    }

    // Preserve request order across every provider for this slug. React can
    // remount a cached Y.Doc before the previous provider finishes teardown;
    // a per-instance queue would let that older write finish last.
    return enqueueSnapshotWrite(this.slug, () => this.persistSnapshot(draft));
  }

  private async persistSnapshot(draft: SnapshotDraft) {
    if (this.destroyed || this.isAbandoned()) return;
    if (this.encryption !== draft.encryption || this.hasEncryptionModeMismatch()) return;
    try {
      let stateBytes = draft.state;
      let storedContent = draft.text;
      let storedCount = draft.text.length;
      // Tags are derived from plaintext, so for encrypted notes we leave them
      // empty (server stays zero-knowledge).
      let storedTags: string[] = draft.encryption ? [] : extractTags(draft.text);
      if (draft.encryption) {
        try {
          stateBytes = await draft.encryption.encrypt(draft.state);
          // Server is zero-knowledge — never expose plaintext or true length.
          storedContent = "";
          storedCount = 0;
          storedTags = [];
        } catch {
          console.warn("Encrypt snapshot failed");
          return;
        }
      }
      if (this.destroyed || this.isAbandoned()) return;
      // Re-check after asynchronous encryption and immediately before the
      // upsert. A mode transition in another tab must stop this stale write.
      if (this.encryption !== draft.encryption || this.hasEncryptionModeMismatch()) return;
      const { error } = await supabase.from("notes").upsert(
        {
          slug: this.slug,
          ydoc_state: bytesToBase64(stateBytes),
          content: storedContent,
          char_count: storedCount,
          tags: storedTags,
          // Keep the row flag in lockstep with the bytes we just wrote so a
          // stale `is_encrypted` can never disagree with `ydoc_state`.
          is_encrypted: !!draft.encryption,
        },
        { onConflict: "slug" }
      );
      if (error) {
        console.warn("Snapshot save failed");
        this.emitSync({ type: "error", message: error.message ?? String(error) });
      } else {
        this.lastSnapshotAt = Date.now();
        // An older in-flight save is not proof that a newer keystroke is
        // durable. Only the snapshot containing the latest local version may
        // clear the pending marker and report fully synced state.
        if (this.localUpdateVersion === draft.localUpdateVersion) {
          this.pendingBytes = 0;
          this.emitSync({ type: "synced-durable" });
        }
      }
    } catch (e) {
      console.warn("Snapshot exception");
      this.emitSync({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Best-effort synchronous-ish flush for `beforeunload` / `pagehide`. Uses
   * `navigator.sendBeacon` against the Supabase REST endpoint so the browser
   * doesn't kill the request as it tears the page down. Falls back to the
   * normal saveSnapshot path when sendBeacon isn't usable.
   */
  flushBeacon() {
    if (this.destroyed) return;
    if (this.isAbandoned()) return;
    if (this.hasEncryptionModeMismatch()) {
      // Would overwrite the row in the wrong mode (e.g. plaintext over a
      // freshly-encrypted note during lock/unlock). Skip entirely.
      return;
    }
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      const text = this.doc.getText("content").toString();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/notes?on_conflict=slug`;
      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      // Encrypted notes: skip beacon (the encrypt call is async and we can't
      // wait here). The server already has the most recent debounced save
      // and IDB persists locally regardless.
      if (this.encryption) return;
      const body = JSON.stringify([
        {
          slug: this.slug,
          ydoc_state: bytesToBase64(state),
          content: text,
          char_count: text.length,
          tags: extractTags(text),
          // Beacon path is plaintext-only (guarded above); pin the flag so
          // the row can never end up with encrypted bytes + is_encrypted=false.
          is_encrypted: false,
        },
      ]);
      const headers = {
        type: "application/json",
      };
      const blob = new Blob([body], headers);
      // sendBeacon doesn't let us set custom headers; the Supabase REST API
      // requires apikey + Prefer headers, so we fall through to fetch with
      // keepalive when beacon isn't viable.
      if (this.hasEncryptionModeMismatch()) return;
      const ok = navigator.sendBeacon
        ? navigator.sendBeacon(`${url}&apikey=${encodeURIComponent(apikey)}`, blob)
        : false;
      if (!ok) {
        // Another browser context can change the durable pin while this
        // context evaluates the beacon attempt. Re-check before fallback.
        if (this.hasEncryptionModeMismatch()) return;
        void fetch(`${url}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey,
            Authorization: `Bearer ${apikey}`,
            Prefer: "resolution=merge-duplicates",
          },
          body,
          keepalive: true,
        });
      }
    } catch {
      console.warn("flushBeacon failed");
    }
  }

  destroy() {
    if (!this.destroyPromise) {
      this.destroyPromise = this.destroyInternal();
    }
    return this.destroyPromise;
  }

  private async destroyInternal() {
    // Stop accepting new local work first, but keep the provider writable
    // long enough to durably persist edits still inside the debounce window.
    // `destroyed` is deliberately set only after this final save because
    // saveSnapshot fails closed once that flag is true.
    this.cancelPendingSnapshot();
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.pendingUpdates = [];

    if (!this.isAbandoned() && this.hasUnflushedLocalChanges()) {
      await this.saveSnapshot();
    }

    this.destroyed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("offline", this.handleNativeOffline);
    }
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
    if (this.channel) {
      try {
        await this.channel.unsubscribe();
      } catch {
        // ignore
      }
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
    const activeForSlug = activeProvidersBySlug.get(this.slug);
    activeForSlug?.delete(this);
    if (activeForSlug?.size === 0) activeProvidersBySlug.delete(this.slug);
  }
}
