import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { base64ToBytes, bytesToBase64 } from "./base64";
import { extractTags } from "@/lib/tags";
import { CapabilityApiError } from "@/lib/capability/client";
import { getSnapshotDebounceMs, type AwarenessState, type Encryption, type SyncEvent, type YjsProviderLike } from "./provider";

type Listener<T> = (value: T) => void;

export type PlainUpsertBody = {
  slug: string;
  ydocState: string;
  content: string;
  charCount: number;
  tags: string[];
  isEncrypted: boolean;
  salt: string | null;
  check: string | null;
  iterations: number | null;
};

export type PlainUpsertFn = (body: PlainUpsertBody, keepalive?: boolean) => Promise<unknown>;

/**
 * W2 free-edit persist for bare `/slug`. Snapshots go through Edge
 * `plain-upsert`. Never reads or writes `public.notes` from Vite.
 */
export class PlainUpsertProvider implements YjsProviderLike {
  doc: Y.Doc;
  awareness: Awareness;
  slug: string;
  connected = false;

  private pendingBytes = 0;
  private destroyed = false;
  private persistEnabled = false;
  private encryption: Encryption | null = null;
  private expectedEncrypted: boolean | null = null;
  private snapshotTimer: number | null = null;
  private lastSnapshotAt = 0;
  private localUpdateVersion = 0;
  private awarenessListeners = new Set<Listener<Map<number, AwarenessState>>>();
  private syncListeners = new Set<Listener<SyncEvent>>();
  private readonly upsert: PlainUpsertFn;
  private readonly onManaged: () => void;

  constructor(slug: string, doc: Y.Doc, upsert: PlainUpsertFn, onManaged: () => void) {
    this.slug = slug;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.upsert = upsert;
    this.onManaged = onManaged;
    this.doc.on("update", this.handleDocUpdate);
  }

  setEncryption(encryption: Encryption | null) {
    this.encryption = encryption;
  }

  setExpectedEncrypted(expected: boolean | null) {
    this.expectedEncrypted = expected;
  }

  onAwareness(listener: Listener<Map<number, AwarenessState>>) {
    this.awarenessListeners.add(listener);
    return () => { this.awarenessListeners.delete(listener); };
  }

  onSyncEvent(listener: Listener<SyncEvent>) {
    this.syncListeners.add(listener);
    return () => { this.syncListeners.delete(listener); };
  }

  getPendingBytes() {
    return this.pendingBytes;
  }

  getLastBroadcastAt() {
    return 0;
  }

  getLastSnapshotAt() {
    return this.lastSnapshotAt;
  }

  hasUnflushedLocalChanges() {
    return this.pendingBytes > 0;
  }

  async connect(
    identity: { name: string; color: string },
    options?: { prefetchedYdocState?: string | null; rowExists?: boolean },
  ) {
    if (this.destroyed) return;
    const ydocState = options?.prefetchedYdocState;
    if (ydocState) {
      try {
        let update = base64ToBytes(ydocState);
        if (this.encryption && update.byteLength > 0) {
          update = await this.encryption.decrypt(update);
        }
        if (update.byteLength > 0) Y.applyUpdate(this.doc, update, "remote-snapshot");
      } catch {
        this.emit({ type: "error", message: "snapshot" });
      }
    }
    this.awareness.setLocalState({
      user: { name: identity.name, color: identity.color },
    });
    this.connected = true;
    this.persistEnabled = true;
    this.emit({ type: "online" });
    this.notifyAwareness();
  }

  flushBeacon() {
    if (this.destroyed || !this.persistEnabled || this.hasEncryptionModeMismatch()) return;
    void this.persistSnapshot(true);
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connected = false;
    if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer);
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.destroy();
    this.awarenessListeners.clear();
    this.syncListeners.clear();
  }

  private hasEncryptionModeMismatch() {
    if (this.expectedEncrypted === null) return false;
    return this.expectedEncrypted !== !!this.encryption;
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.destroyed || !this.persistEnabled) return;
    if (origin === "remote" || origin === "remote-snapshot") return;
    this.pendingBytes += update.byteLength;
    this.localUpdateVersion += 1;
    this.scheduleSnapshot();
  };

  private scheduleSnapshot() {
    if (this.destroyed) return;
    if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => {
      void this.persistSnapshot(false);
    }, getSnapshotDebounceMs());
  }

  private async persistSnapshot(keepalive: boolean) {
    this.snapshotTimer = null;
    if (this.destroyed || !this.persistEnabled || this.hasEncryptionModeMismatch()) return;
    if (this.encryption) return;
    const version = this.localUpdateVersion;
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      const content = this.doc.getText("content").toString();
      await this.upsert({
        slug: this.slug,
        ydocState: bytesToBase64(state),
        content,
        charCount: content.length,
        tags: extractTags(content),
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: null,
      }, keepalive);
      if (this.destroyed) return;
      this.lastSnapshotAt = Date.now();
      if (this.localUpdateVersion === version) {
        this.pendingBytes = 0;
        this.emit({ type: "synced-durable" });
      }
    } catch (error) {
      if (error instanceof CapabilityApiError && error.code === "capability_managed") {
        this.onManaged();
        this.emit({ type: "error", message: "capability_managed" });
        return;
      }
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private notifyAwareness() {
    const states = this.awareness.getStates() as Map<number, AwarenessState>;
    for (const listener of this.awarenessListeners) listener(states);
  }

  private emit(event: SyncEvent) {
    for (const listener of this.syncListeners) listener(event);
  }
}
