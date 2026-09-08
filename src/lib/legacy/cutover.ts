import * as Y from "yjs";
import { CAPABILITY_TOKEN_RE, buildCapabilityUrl } from "@/lib/capability/url";
import { capabilityPayloadId, encodeCapabilityPayload, newOwnerCandidate } from "@/lib/capability/encoding";
import { isUsableSlug } from "@/lib/slug";
import type { Encryption } from "@/lib/yjs/provider";

export type LegacyNote = {
  slug: string;
  content: string;
  ydocState: string;
  isEncrypted: boolean;
  salt: string | null;
  check: string | null;
  iterations: number | null;
};

type LegacyApiOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
};

const LEGACY_NOTE_OPEN = "legacy-note-open";

function endpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/functions/v1/${LEGACY_NOTE_OPEN}`;
}

function assertSlug(slug: unknown) {
  if (typeof slug !== "string" || !isUsableSlug(slug)) throw new Error("invalid slug");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object") {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : `request failed (${response.status})`;
    throw new Error(message);
  }
  return data as Record<string, unknown>;
}

export function createLegacyNoteApi(options: LegacyApiOptions = {}) {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_SUPABASE_URL;
  const fetcher = options.fetcher ?? fetch;
  if (!baseUrl) throw new Error("legacy note API unavailable");

  const post = async (action: "exists" | "open", slug: string, signal?: AbortSignal) => {
    assertSlug(slug);
    const response = await fetcher(endpoint(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, slug }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    return readJson(response);
  };

  return {
    async exists(slug: string, signal?: AbortSignal): Promise<boolean> {
      const data = await post("exists", slug, signal);
      if (typeof data.exists !== "boolean") throw new Error("invalid legacy response");
      return data.exists;
    },

    async open(slug: string, signal?: AbortSignal): Promise<LegacyNote | null> {
      const data = await post("open", slug, signal);
      if (data.exists === false) return null;
      const note = data.note;
      if (!note || typeof note !== "object") throw new Error("invalid legacy response");
      const row = note as Record<string, unknown>;
      if (
        row.slug !== slug
        || typeof row.content !== "string"
        || typeof row.ydocState !== "string"
        || typeof row.isEncrypted !== "boolean"
        || !(row.salt === null || typeof row.salt === "string")
        || !(row.check === null || typeof row.check === "string")
        || !(row.iterations === null || Number.isSafeInteger(row.iterations))
        || (row.isEncrypted && (!row.salt || !row.check || !row.iterations))
      ) throw new Error("invalid legacy response");
      return row as LegacyNote;
    },
  };
}

type DuplicateApi = {
  importLegacyNote: (body: {
    slug: string;
    checkpointId: string;
    payload: string;
    isEncrypted: boolean;
    salt: string | null;
    check: string | null;
    iterations: number | null;
  }, ownerCandidate: string) => Promise<{
    capabilities: { owner: string; edit?: string; view?: string };
  }>;
};

export type LegacyImportRecovery = {
  sourceSlug: string;
  sourceFingerprint: string;
  owner: string;
  checkpointId: string;
  payload: string;
  isEncrypted: boolean;
  salt: string | null;
  check: string | null;
  iterations: number | null;
};

export type LegacyImportRecoveryStore = {
  load: (slug: string) => unknown;
  save: (slug: string, recovery: LegacyImportRecovery) => void;
  clear: (slug: string) => void;
};

const RECOVERY_PREFIX = "snote:legacy-import:";
const HASH_RE = /^[a-f0-9]{64}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;

function isRecovery(value: unknown): value is LegacyImportRecovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyImportRecovery>;
  return typeof candidate.sourceSlug === "string" && isUsableSlug(candidate.sourceSlug)
    && HASH_RE.test(candidate.sourceFingerprint ?? "")
    && CAPABILITY_TOKEN_RE.test(candidate.owner ?? "")
    && HASH_RE.test(candidate.checkpointId ?? "")
    && PAYLOAD_RE.test(candidate.payload ?? "")
    && typeof candidate.isEncrypted === "boolean"
    && (candidate.salt === null || typeof candidate.salt === "string")
    && (candidate.check === null || typeof candidate.check === "string")
    && (candidate.iterations === null || Number.isSafeInteger(candidate.iterations));
}

function browserRecoveryStore(): LegacyImportRecoveryStore {
  if (typeof window === "undefined") throw new Error("secure duplicate recovery unavailable");
  const storage = window.localStorage;
  return {
    load(slug) {
      const raw = storage.getItem(`${RECOVERY_PREFIX}${slug}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    save(slug, recovery) {
      const key = `${RECOVERY_PREFIX}${slug}`;
      const serialized = JSON.stringify(recovery);
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new Error("secure duplicate recovery unavailable");
    },
    clear(slug) {
      storage.removeItem(`${RECOVERY_PREFIX}${slug}`);
    },
  };
}

async function legacySourceFingerprint(source: LegacyNote): Promise<string> {
  const canonicalSource = JSON.stringify([
    source.slug,
    source.content,
    source.ydocState,
    source.isEncrypted,
    source.salt,
    source.check,
    source.iterations,
  ]);
  return capabilityPayloadId(new TextEncoder().encode(canonicalSource));
}

function recoveryMatchesSource(
  recovery: LegacyImportRecovery,
  source: LegacyNote,
  sourceFingerprint: string,
): boolean {
  return recovery.sourceSlug === source.slug
    && recovery.sourceFingerprint === sourceFingerprint
    && recovery.isEncrypted === source.isEncrypted
    && recovery.salt === (source.isEncrypted ? source.salt : null)
    && recovery.check === (source.isEncrypted ? source.check : null)
    && recovery.iterations === (source.isEncrypted ? source.iterations : null);
}

export function clearLegacyImportRecovery(slug: string, owner: string): void {
  try {
    const store = browserRecoveryStore();
    const recovery = store.load(slug);
    if (isRecovery(recovery) && recovery.owner === owner) store.clear(slug);
  } catch {
    // The owner capability is already in the fragment; storage cleanup is
    // best-effort and must never block opening the recovered secure note.
  }
}

export async function duplicateLegacyNote(input: {
  api: DuplicateApi;
  source: LegacyNote;
  doc: Y.Doc;
  targetSlug: string;
  encryption?: Encryption | null;
  encryptionSecret?: string;
  recoveryStore?: LegacyImportRecoveryStore;
}): Promise<string> {
  assertSlug(input.targetSlug);
  if (input.source.isEncrypted) {
    if (
      !input.source.salt
      || !input.source.check
      || !input.source.iterations
      || !input.encryptionSecret
    ) throw new Error("unlock the legacy note before duplicating it");
  }

  const store = input.recoveryStore ?? browserRecoveryStore();
  const storedRecovery = store.load(input.targetSlug);
  const sourceFingerprint = await legacySourceFingerprint(input.source);
  let recovery: LegacyImportRecovery;
  if (storedRecovery !== null && storedRecovery !== undefined) {
    if (!isRecovery(storedRecovery)) throw new Error("secure duplicate recovery invalid");
    if (!recoveryMatchesSource(storedRecovery, input.source, sourceFingerprint)) {
      throw new Error("secure duplicate recovery conflict");
    }
    recovery = storedRecovery;
  } else {
    const state = Y.encodeStateAsUpdate(input.doc);
    if (input.source.isEncrypted && !input.encryption) {
      throw new Error("unlock the legacy note before duplicating it");
    }
    const storedState = input.source.isEncrypted
      ? await input.encryption!.encrypt(state)
      : state;
    recovery = {
      sourceSlug: input.source.slug,
      sourceFingerprint,
      owner: newOwnerCandidate(),
      checkpointId: await capabilityPayloadId(storedState),
      payload: encodeCapabilityPayload(storedState),
      isEncrypted: input.source.isEncrypted,
      salt: input.source.isEncrypted ? input.source.salt : null,
      check: input.source.isEncrypted ? input.source.check : null,
      iterations: input.source.isEncrypted ? input.source.iterations : null,
    };
    // Persistence must succeed before the database can reserve the slug.
    store.save(input.targetSlug, recovery);
  }

  const created = await input.api.importLegacyNote({
    slug: input.targetSlug,
    checkpointId: recovery.checkpointId,
    payload: recovery.payload,
    isEncrypted: recovery.isEncrypted,
    salt: recovery.salt,
    check: recovery.check,
    iterations: recovery.iterations,
  }, recovery.owner);
  const owner = created.capabilities.owner;
  if (owner !== recovery.owner) throw new Error("invalid recovered owner capability");

  return buildCapabilityUrl(
    "owner",
    owner,
    input.targetSlug,
    input.source.isEncrypted ? input.encryptionSecret : undefined,
  );
}

const DUPLICATE_SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Fresh locator for a secure copy. Never reuses the legacy slug. */
export function allocateDuplicateSlug(): string {
  let slug = "";
  for (let i = 0; i < 8; i++) {
    slug += DUPLICATE_SLUG_CHARS[Math.floor(Math.random() * DUPLICATE_SLUG_CHARS.length)];
  }
  return slug;
}

export type DuplicateFailureKind = "network" | "permission" | "retry" | "slug_unavailable";

export function mapDuplicateFailure(error: unknown): DuplicateFailureKind {
  if (!error || typeof error !== "object") return "network";
  const candidate = error as { status?: unknown; code?: unknown };
  const status = typeof candidate.status === "number" && Number.isSafeInteger(candidate.status)
    ? candidate.status
    : null;
  const code = typeof candidate.code === "string" && /^[a-z][a-z_]{0,63}$/.test(candidate.code)
    ? candidate.code
    : null;
  if (code === "slug_unavailable") return "slug_unavailable";
  if (code === "unauthorized" || status === 401 || status === 403) return "permission";
  if (status === null) return "network";
  return "retry";
}
