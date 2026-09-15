import { isUsableSlug } from "@/lib/slug";

export const LEGACY_SECURE_PIN_PREFIX = "snote:legacy-secure:";
export const PLAIN_NOTE_IDB_PREFIX = "note:";

export function legacySecurePinKey(slug: string): string {
  return `${LEGACY_SECURE_PIN_PREFIX}${slug}`;
}

export function plainNoteIndexedDbName(slug: string): string {
  return `${PLAIN_NOTE_IDB_PREFIX}${slug}`;
}

export function hasLegacySecurePin(slug: string): boolean {
  if (!isUsableSlug(slug)) return false;
  try {
    return globalThis.sessionStorage.getItem(legacySecurePinKey(slug)) === "1";
  } catch {
    return false;
  }
}

export function markLegacySecurePin(slug: string): boolean {
  if (!isUsableSlug(slug)) return false;
  try {
    const key = legacySecurePinKey(slug);
    globalThis.sessionStorage.setItem(key, "1");
    return globalThis.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function clearLegacySecurePin(slug: string): boolean {
  if (!isUsableSlug(slug)) return false;
  try {
    const key = legacySecurePinKey(slug);
    globalThis.sessionStorage.removeItem(key);
    return globalThis.sessionStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

/** Drop the bare `/slug` y-indexeddb seed so a later bare tab cannot look Synced from local-only state. */
export function clearPlainNoteIndexedDb(slug: string): void {
  if (!isUsableSlug(slug)) return;
  try {
    globalThis.indexedDB?.deleteDatabase(plainNoteIndexedDbName(slug));
  } catch {
    // Privacy mode / missing IDB. Bare RO chrome does not remount this store.
  }
}
