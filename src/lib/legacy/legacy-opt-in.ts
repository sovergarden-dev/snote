/** Query-param force for Legacy RO (`CutoverNotePage` → LNO), including `#owner=` opt-in. */

export const LEGACY_RO_PARAM = "legacyRo";
export const LEGACY_RO_VALUE = "1";

const CONFIRM_PREFIX = "snote:legacy-opt-in-confirmed:";

function searchParamsFrom(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

export function isLegacyRoSearch(search: string): boolean {
  return searchParamsFrom(search).get(LEGACY_RO_PARAM) === LEGACY_RO_VALUE;
}

/** Build a same-note href that adds or removes `?legacyRo=1` without touching the fragment. */
export function buildLegacyOptInLocation(
  pathname: string,
  search: string,
  hash: string,
  enabled: boolean,
): string {
  const params = searchParamsFrom(search);
  if (enabled) params.set(LEGACY_RO_PARAM, LEGACY_RO_VALUE);
  else params.delete(LEGACY_RO_PARAM);
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}

export function legacyOptInConfirmStorageKey(slug: string): string {
  return `${CONFIRM_PREFIX}${encodeURIComponent(slug)}`;
}

export function hasConfirmedLegacyOptIn(slug: string): boolean {
  if (!slug) return false;
  try {
    return globalThis.localStorage.getItem(legacyOptInConfirmStorageKey(slug)) === "1";
  } catch {
    return false;
  }
}

export function markLegacyOptInConfirmed(slug: string): void {
  if (!slug) return;
  try {
    globalThis.localStorage.setItem(legacyOptInConfirmStorageKey(slug), "1");
  } catch {
    // Convenience only: skip the long first-time copy after one confirm.
  }
}

/** Duplicate securely stays off until SQL 240 ships import-legacy. */
export const DUPLICATE_SECURELY_AVAILABLE = false;
