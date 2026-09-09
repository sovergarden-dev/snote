import * as Y from "yjs";
import {
  loadPendingOwnerCandidate,
  mapMintFailure,
  mintCapabilityNote,
  persistPendingOwnerCandidate,
  type PendingOwnerStore,
} from "@/lib/capability/owner-candidate";
import { capabilityPayloadId, encodeCapabilityPayload } from "@/lib/capability/encoding";
import { buildCapabilityUrl, parseCapabilityLocation } from "@/lib/capability/url";
import type { Encryption } from "@/lib/yjs/provider";
import {
  duplicateLegacyNote,
  loadLegacyImportRecovery,
  type LegacyImportRecovery,
  type LegacyImportRecoveryStore,
  type LegacyNote,
} from "./cutover";

export type ConvertOnWriteApi = {
  convertLegacyNote: (body: {
    slug: string;
    checkpointId: string;
    payload: string;
    isEncrypted: boolean;
    salt: string | null;
    check: string | null;
    iterations: number | null;
  }, ownerCandidate: string) => Promise<{
    capabilities: { owner: string };
  }>;
  createNote: (slug: string, ownerCandidate: string) => Promise<{
    capabilities: { owner: string };
  }>;
};

const CONVERT_RECOVERY_PREFIX = "snote:convert-recover:";
const inflight = new Map<string, Promise<string>>();
const seeds = new Map<string, Uint8Array>();

export class ConvertedSlugUnrecoverableError extends Error {
  readonly code = "converted_slug_unrecoverable";
  readonly status = 409;

  constructor() {
    super("converted slug unrecoverable");
    this.name = "ConvertedSlugUnrecoverableError";
  }
}

function capabilityUrlToPath(urlOrPath: string): string {
  if (urlOrPath.startsWith("/")) return urlOrPath;
  const url = new URL(urlOrPath);
  return `${url.pathname}${url.search}${url.hash}`;
}

function ownerFromCapabilityPath(path: string): string | null {
  const url = path.startsWith("/")
    ? new URL(path, "https://snote.local")
    : new URL(path);
  const parsed = parseCapabilityLocation(url);
  return parsed?.scope === "owner" ? parsed.token : null;
}

function stashConvertSeed(slug: string, doc: Y.Doc): void {
  seeds.set(slug, Y.encodeStateAsUpdate(doc));
}

function browserConvertRecoveryStore(): LegacyImportRecoveryStore {
  if (typeof sessionStorage === "undefined") throw new Error("convert recovery unavailable");
  const storage = sessionStorage;
  return {
    load(slug) {
      const raw = storage.getItem(`${CONVERT_RECOVERY_PREFIX}${slug}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    save(slug, recovery) {
      const key = `${CONVERT_RECOVERY_PREFIX}${slug}`;
      const serialized = JSON.stringify(recovery);
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new Error("convert recovery unavailable");
    },
    clear(slug) {
      storage.removeItem(`${CONVERT_RECOVERY_PREFIX}${slug}`);
    },
  };
}

function convertRecoveryStoreFor(
  store?: LegacyImportRecoveryStore,
): LegacyImportRecoveryStore | undefined {
  if (store) return store;
  try {
    return browserConvertRecoveryStore();
  } catch {
    return undefined;
  }
}

function loadStoredConvertRecovery(
  slug: string,
  recoveryStore?: LegacyImportRecoveryStore,
  convertRecoveryStore?: LegacyImportRecoveryStore,
): LegacyImportRecovery | null {
  return loadLegacyImportRecovery(slug, convertRecoveryStoreFor(convertRecoveryStore))
    ?? loadLegacyImportRecovery(slug, recoveryStore);
}

function rememberConvertRecovery(
  slug: string,
  recovery: LegacyImportRecovery | null,
  pendingOwnerStore?: PendingOwnerStore,
  convertRecoveryStore?: LegacyImportRecoveryStore,
): void {
  const owner = recovery?.owner;
  if (owner) {
    try {
      persistPendingOwnerCandidate(slug, owner, pendingOwnerStore);
    } catch {
      // The owner is already in the returned fragment.
    }
  }
  if (!recovery) return;
  try {
    convertRecoveryStoreFor(convertRecoveryStore)?.save(slug, recovery);
  } catch {
    // Session copy is best-effort; reopen can still use pending owner.
  }
}

function isLegacyNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.code === "not_found" || candidate.status === 404;
}

export function consumeConvertSeed(slug: string): Uint8Array | null {
  const seed = seeds.get(slug) ?? null;
  seeds.delete(slug);
  return seed;
}

export function resetConvertOnWriteForTests(): void {
  inflight.clear();
  seeds.clear();
}

export function hasStoredConvertRecovery(
  slug: string,
  stores?: {
    recoveryStore?: LegacyImportRecoveryStore;
    convertRecoveryStore?: LegacyImportRecoveryStore;
  },
): boolean {
  return loadStoredConvertRecovery(slug, stores?.recoveryStore, stores?.convertRecoveryStore) !== null;
}

async function convertFromRecovery(input: {
  slug: string;
  doc: Y.Doc;
  recovery: LegacyImportRecovery;
  api: ConvertOnWriteApi;
  encryptionSecret?: string;
  pendingOwnerStore?: PendingOwnerStore;
  convertRecoveryStore?: LegacyImportRecoveryStore;
}): Promise<string> {
  const created = await input.api.convertLegacyNote({
    slug: input.slug,
    checkpointId: input.recovery.checkpointId,
    payload: input.recovery.payload,
    isEncrypted: input.recovery.isEncrypted,
    salt: input.recovery.salt,
    check: input.recovery.check,
    iterations: input.recovery.iterations,
  }, input.recovery.owner);
  if (created.capabilities.owner !== input.recovery.owner) {
    throw new Error("invalid recovered owner capability");
  }
  rememberConvertRecovery(
    input.slug,
    input.recovery,
    input.pendingOwnerStore,
    input.convertRecoveryStore,
  );
  stashConvertSeed(input.slug, input.doc);
  return capabilityUrlToPath(buildCapabilityUrl(
    "owner",
    input.recovery.owner,
    input.slug,
    input.recovery.isEncrypted ? input.encryptionSecret : undefined,
  ));
}

async function convertFromOwnerCandidate(input: {
  slug: string;
  doc: Y.Doc;
  owner: string;
  api: ConvertOnWriteApi;
  encryption?: Encryption | null;
  pendingOwnerStore?: PendingOwnerStore;
}): Promise<string> {
  if (input.encryption) throw new ConvertedSlugUnrecoverableError();
  const state = Y.encodeStateAsUpdate(input.doc);
  const checkpointId = await capabilityPayloadId(state);
  const payload = encodeCapabilityPayload(state);
  const created = await input.api.convertLegacyNote({
    slug: input.slug,
    checkpointId,
    payload,
    isEncrypted: false,
    salt: null,
    check: null,
    iterations: null,
  }, input.owner);
  if (created.capabilities.owner !== input.owner) throw new Error("invalid recovered owner capability");
  try {
    persistPendingOwnerCandidate(input.slug, input.owner, input.pendingOwnerStore);
  } catch {
    // The owner is already in the returned fragment.
  }
  stashConvertSeed(input.slug, input.doc);
  return capabilityUrlToPath(buildCapabilityUrl("owner", input.owner, input.slug));
}

export function convertPlainNoteOnWrite(input: {
  slug: string;
  doc: Y.Doc;
  source: LegacyNote | null;
  api: ConvertOnWriteApi;
  encryption?: Encryption | null;
  encryptionSecret?: string;
  recoveryStore?: LegacyImportRecoveryStore;
  pendingOwnerStore?: PendingOwnerStore;
  convertRecoveryStore?: LegacyImportRecoveryStore;
}): Promise<string> {
  const existing = inflight.get(input.slug);
  if (existing) return existing;

  const run = (async () => {
    try {
      if (input.source) {
        const url = await duplicateLegacyNote({
          api: { importLegacyNote: input.api.convertLegacyNote },
          source: input.source,
          doc: input.doc,
          targetSlug: input.slug,
          encryption: input.encryption,
          encryptionSecret: input.encryptionSecret,
          recoveryStore: input.recoveryStore,
        });
        const path = capabilityUrlToPath(url);
        rememberConvertRecovery(
          input.slug,
          loadLegacyImportRecovery(input.slug, input.recoveryStore),
          input.pendingOwnerStore,
          input.convertRecoveryStore,
        );
        const owner = ownerFromCapabilityPath(path);
        if (owner && !loadPendingOwnerCandidate(input.slug, input.pendingOwnerStore)) {
          try {
            persistPendingOwnerCandidate(input.slug, owner, input.pendingOwnerStore);
          } catch {
            // Fragment already carries the owner.
          }
        }
        stashConvertSeed(input.slug, input.doc);
        return path;
      }

      const stored = loadStoredConvertRecovery(
        input.slug,
        input.recoveryStore,
        input.convertRecoveryStore,
      );
      if (stored) {
        try {
          return await convertFromRecovery({
            slug: input.slug,
            doc: input.doc,
            recovery: stored,
            api: input.api,
            encryptionSecret: input.encryptionSecret,
            pendingOwnerStore: input.pendingOwnerStore,
            convertRecoveryStore: input.convertRecoveryStore,
          });
        } catch (error) {
          if (mapMintFailure(error).kind === "slug_unavailable") {
            throw new ConvertedSlugUnrecoverableError();
          }
          if (!isLegacyNotFound(error)) throw error;
        }
      }

      const ownerBefore = loadPendingOwnerCandidate(input.slug, input.pendingOwnerStore);
      if (ownerBefore && !input.encryption) {
        try {
          return await convertFromOwnerCandidate({
            slug: input.slug,
            doc: input.doc,
            owner: ownerBefore,
            api: input.api,
            pendingOwnerStore: input.pendingOwnerStore,
          });
        } catch (error) {
          if (
            mapMintFailure(error).kind !== "slug_unavailable"
            && !isLegacyNotFound(error)
          ) throw error;
        }
      }

      try {
        const minted = await mintCapabilityNote(
          input.slug,
          (slug, owner) => input.api.createNote(slug, owner),
          { store: input.pendingOwnerStore },
        );
        stashConvertSeed(input.slug, input.doc);
        return minted.path;
      } catch (error) {
        if (mapMintFailure(error).kind !== "slug_unavailable") throw error;
        throw new ConvertedSlugUnrecoverableError();
      }
    } finally {
      inflight.delete(input.slug);
    }
  })();

  inflight.set(input.slug, run);
  return run;
}
