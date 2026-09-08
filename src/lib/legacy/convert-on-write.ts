import * as Y from "yjs";
import { mintCapabilityNote, type PendingOwnerStore } from "@/lib/capability/owner-candidate";
import type { Encryption } from "@/lib/yjs/provider";
import {
  duplicateLegacyNote,
  type LegacyImportRecoveryStore,
  type LegacyNote,
} from "./cutover";

export type ConvertOnWriteApi = {
  importLegacyNote: (body: {
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

const inflight = new Map<string, Promise<string>>();
const seeds = new Map<string, Uint8Array>();

function capabilityUrlToPath(urlOrPath: string): string {
  if (urlOrPath.startsWith("/")) return urlOrPath;
  const url = new URL(urlOrPath);
  return `${url.pathname}${url.search}${url.hash}`;
}

function stashConvertSeed(slug: string, doc: Y.Doc): void {
  seeds.set(slug, Y.encodeStateAsUpdate(doc));
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

export function convertPlainNoteOnWrite(input: {
  slug: string;
  doc: Y.Doc;
  source: LegacyNote | null;
  api: ConvertOnWriteApi;
  encryption?: Encryption | null;
  encryptionSecret?: string;
  recoveryStore?: LegacyImportRecoveryStore;
  pendingOwnerStore?: PendingOwnerStore;
}): Promise<string> {
  const existing = inflight.get(input.slug);
  if (existing) return existing;

  const run = (async () => {
    try {
      if (input.source) {
        const url = await duplicateLegacyNote({
          api: input.api,
          source: input.source,
          doc: input.doc,
          targetSlug: input.slug,
          encryption: input.encryption,
          encryptionSecret: input.encryptionSecret,
          recoveryStore: input.recoveryStore,
        });
        stashConvertSeed(input.slug, input.doc);
        return capabilityUrlToPath(url);
      }
      const minted = await mintCapabilityNote(
        input.slug,
        (slug, owner) => input.api.createNote(slug, owner),
        { store: input.pendingOwnerStore },
      );
      stashConvertSeed(input.slug, input.doc);
      return minted.path;
    } finally {
      inflight.delete(input.slug);
    }
  })();

  inflight.set(input.slug, run);
  return run;
}
