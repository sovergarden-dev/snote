import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { base64ToBytes } from "./base64";
import type {
  AwarenessState,
  Encryption,
  SyncEvent,
  YjsProviderLike,
} from "./provider";

type Listener<T> = (value: T) => void;

/**
 * Local-only provider for W1 plain `/slug` before convert-on-write.
 * Never reads or writes `public.notes`.
 */
export class LocalConvertProvider implements YjsProviderLike {
  doc: Y.Doc;
  awareness: Awareness;
  slug: string;
  connected = false;

  private pendingBytes = 0;
  private destroyed = false;
  private persistEnabled = false;
  private persistArmed = false;
  private encryption: Encryption | null = null;
  private awarenessListeners = new Set<Listener<Map<number, AwarenessState>>>();
  private syncListeners = new Set<Listener<SyncEvent>>();
  private readonly onFirstPersist: () => void;

  constructor(slug: string, doc: Y.Doc, onFirstPersist: () => void) {
    this.slug = slug;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.onFirstPersist = onFirstPersist;
    this.doc.on("update", this.handleDocUpdate);
  }

  setEncryption(encryption: Encryption | null) {
    this.encryption = encryption;
  }

  setExpectedEncrypted(_expected: boolean | null) {}

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
    return 0;
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

  flushBeacon() {}

  emitConvertError(message: string) {
    this.emit({ type: "error", message });
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connected = false;
    this.doc.off("update", this.handleDocUpdate);
    this.awareness.destroy();
    this.awarenessListeners.clear();
    this.syncListeners.clear();
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.destroyed || !this.persistEnabled) return;
    if (origin === "remote" || origin === "remote-snapshot") return;
    this.pendingBytes += update.byteLength;
    if (this.persistArmed) return;
    this.persistArmed = true;
    this.onFirstPersist();
  };

  private notifyAwareness() {
    const states = this.awareness.getStates() as Map<number, AwarenessState>;
    for (const listener of this.awarenessListeners) listener(states);
  }

  private emit(event: SyncEvent) {
    for (const listener of this.syncListeners) listener(event);
  }
}
