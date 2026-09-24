// Tab-scoped note-host registry (Pixel AC H1–H4).
//
// Exactly one host per note-identity in this JS realm (one browser tab):
// Y.Doc + provider + Awareness + IDB-equivalent + capability session live on
// the host. Split panes acquire/retain/release; the host is disposed only when
// retain count hits 0. Pane-level EditorViews bind to the shared host.
//
// Do not lift SplitView's historical same-slug ban without this registry
// (commit 2e692472 / provider+presence double-mount).

export type NoteHostEncPhase = "loading" | "needs-key" | "blocked" | "error" | "ready";

export type NoteHostEncMeta = {
  isEncrypted: boolean;
  salt: string | null;
  check: string | null;
  iterations: number | null;
  ydocState: string | null;
  rowExists: boolean;
};

export type NoteHostEncTarget = {
  slug: string;
  metaVersion: number;
};

export type NoteHostConvertError = "network" | "permission" | "retry" | "converted";

export type NoteHostGate = {
  metaVersion: number;
  observedHash: string;
  encPhase: NoteHostEncPhase;
  encMeta: NoteHostEncMeta;
  encryption: unknown;
  resolvedEncTarget: NoteHostEncTarget | null;
  providerEpoch: number;
  capabilityAdmission: unknown;
  plainProviderCtor: unknown;
  convertError: NoteHostConvertError | null;
};

export type NoteHostResources<TProvider extends { destroy: () => unknown } = { destroy: () => unknown }> = {
  doc: unknown;
  provider: TProvider;
  dispose: () => void;
};

const EMPTY_ENC_META: NoteHostEncMeta = {
  isEncrypted: false,
  salt: null,
  check: null,
  iterations: null,
  ydocState: null,
  rowExists: false,
};

export const DEFAULT_NOTE_HOST_GATE: NoteHostGate = Object.freeze({
  metaVersion: 0,
  observedHash: "",
  encPhase: "loading",
  encMeta: EMPTY_ENC_META,
  encryption: null,
  resolvedEncTarget: null,
  providerEpoch: 0,
  capabilityAdmission: null,
  plainProviderCtor: null,
  convertError: null,
});

export function noteHostKey(input: { slug: string; capabilityToken?: string | null }): string {
  const token = input.capabilityToken;
  return token ? `cap:${input.slug}:${token}` : `note:${input.slug}`;
}

function createGate(): NoteHostGate {
  return {
    metaVersion: 0,
    observedHash: typeof window !== "undefined" ? window.location.hash : "",
    encPhase: "loading",
    encMeta: { ...EMPTY_ENC_META },
    encryption: null,
    resolvedEncTarget: null,
    providerEpoch: 0,
    capabilityAdmission: null,
    plainProviderCtor: null,
    convertError: null,
  };
}

const hosts = new Map<string, NoteHost>();
let installedWindowListeners = 0;

export class NoteHost {
  readonly key: string;
  retainCount = 0;
  legacySource: unknown = null;

  private listeners = new Set<() => void>();
  private gate: NoteHostGate = createGate();
  private eventHandlers = new Set<() => void>();
  private fanout: (() => void) | null = null;
  private installedTypes: string[] = [];
  private openCache = new Map<string, Promise<unknown>>();
  private resources: NoteHostResources | null = null;
  private resourceGeneration: string | null = null;
  private resourceBinds = 0;
  private syncStop: (() => void) | null = null;
  private syncGeneration: string | null = null;
  private syncBinds = 0;

  constructor(key: string) {
    this.key = key;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getGate = (): NoteHostGate => this.gate;

  setGate(partial: Partial<NoteHostGate>): void {
    this.gate = { ...this.gate, ...partial };
    this.emit();
  }

  observeHash(nextHash: string): void {
    if (this.gate.observedHash === nextHash) return;
    this.gate = {
      ...this.gate,
      observedHash: nextHash,
      metaVersion: this.gate.metaVersion + 1,
    };
    this.emit();
  }

  /** Record the live hash without bumping metaVersion (manual unlock adopt). */
  adoptHash(nextHash: string): void {
    if (this.gate.observedHash === nextHash) return;
    this.gate = { ...this.gate, observedHash: nextHash };
    this.emit();
  }

  bumpMeta(): void {
    this.gate = { ...this.gate, metaVersion: this.gate.metaVersion + 1 };
    this.emit();
  }

  /**
   * One real window listener per event type for this host. Additional panes
   * register handlers that the same listener fans out to (F2).
   */
  ownWindowEvents = (types: readonly string[], handler: () => void): () => void => {
    this.eventHandlers.add(handler);
    if (this.eventHandlers.size === 1) {
      this.fanout = () => {
        for (const registered of [...this.eventHandlers]) registered();
      };
      this.installedTypes = [...types];
      if (typeof window !== "undefined") {
        for (const type of this.installedTypes) {
          window.addEventListener(type, this.fanout);
          installedWindowListeners += 1;
        }
      }
    }
    return () => {
      this.eventHandlers.delete(handler);
      if (this.eventHandlers.size === 0) this.uninstallWindowEvents();
    };
  }

  openOnce<T>(taskId: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.openCache.get(taskId);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve(factory()).catch((error) => {
      this.openCache.delete(taskId);
      throw error;
    });
    this.openCache.set(taskId, promise);
    return promise as Promise<T>;
  }

  bindResources<TProvider extends { destroy: () => unknown }>(
    generation: string,
    factory: () => NoteHostResources<TProvider>,
  ): NoteHostResources<TProvider> {
    if (this.resources && this.resourceGeneration === generation) {
      this.resourceBinds += 1;
      return this.resources as NoteHostResources<TProvider>;
    }
    if (this.resources && this.resourceBinds > 0) {
      // H3: another pane still holds the live host. Never construct a
      // parallel provider even if this pane's generation token changed.
      this.resourceBinds += 1;
      return this.resources as NoteHostResources<TProvider>;
    }
    if (this.resources) this.destroyResources();
    const created = factory();
    this.resources = created;
    this.resourceGeneration = generation;
    this.resourceBinds = 1;
    return created;
  }

  unbindResources(_generation?: string): void {
    if (this.resourceBinds <= 0) return;
    this.resourceBinds -= 1;
    if (this.resourceBinds <= 0) {
      this.resourceBinds = 0;
      this.destroyResources();
    }
  }

  startSync(generation: string, start: () => () => void): () => void {
    if (this.syncStop && (this.syncGeneration === generation || this.syncBinds > 0)) {
      this.syncBinds += 1;
      return () => this.stopSync();
    }
    if (this.syncStop) {
      this.syncStop();
      this.syncStop = null;
      this.syncGeneration = null;
    }
    this.syncStop = start();
    this.syncGeneration = generation;
    this.syncBinds = 1;
    return () => this.stopSync();
  }

  hasResources(generation: string): boolean {
    return this.resources !== null && this.resourceGeneration === generation;
  }

  dispose(): void {
    this.uninstallWindowEvents();
    this.eventHandlers.clear();
    this.openCache.clear();
    this.destroyResources();
    this.listeners.clear();
  }

  private stopSync(): void {
    if (this.syncBinds <= 0) return;
    this.syncBinds -= 1;
    if (this.syncBinds <= 0) {
      this.syncBinds = 0;
      this.syncStop?.();
      this.syncStop = null;
      this.syncGeneration = null;
    }
  }

  private destroyResources(): void {
    if (this.syncStop) {
      this.syncStop();
      this.syncStop = null;
      this.syncBinds = 0;
      this.syncGeneration = null;
    }
    if (this.resources) {
      try {
        this.resources.dispose();
      } catch {
        /* ignore */
      }
      this.resources = null;
      this.resourceGeneration = null;
      this.resourceBinds = 0;
    }
  }

  private uninstallWindowEvents(): void {
    if (!this.fanout) {
      this.installedTypes = [];
      return;
    }
    if (typeof window !== "undefined") {
      for (const type of this.installedTypes) {
        window.removeEventListener(type, this.fanout);
        installedWindowListeners = Math.max(0, installedWindowListeners - 1);
      }
    }
    this.installedTypes = [];
    this.fanout = null;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function acquireNoteHost(key: string): NoteHost {
  let host = hosts.get(key);
  if (!host) {
    host = new NoteHost(key);
    hosts.set(key, host);
  }
  host.retainCount += 1;
  return host;
}

export function releaseNoteHost(key: string): void {
  const host = hosts.get(key);
  if (!host) return;
  host.retainCount -= 1;
  if (host.retainCount > 0) return;
  hosts.delete(key);
  host.dispose();
}

export function getNoteHost(key: string): NoteHost | null {
  return hosts.get(key) ?? null;
}

export const __noteHostInternals = {
  reset() {
    for (const host of [...hosts.values()]) host.dispose();
    hosts.clear();
    installedWindowListeners = 0;
  },
  size() {
    return hosts.size;
  },
  retainCount(key: string) {
    return hosts.get(key)?.retainCount ?? 0;
  },
  windowListenerCount() {
    return installedWindowListeners;
  },
  get(key: string) {
    return hosts.get(key) ?? null;
  },
};
