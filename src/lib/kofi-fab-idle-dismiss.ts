/** SPA-only idle Ko-fi FAB dismiss. Do not reuse `pwa-fab-snooze`. */
export const KOFI_FAB_IDLE_DISMISS_KEY = "kofi-fab-idle-dismiss-until";
export const KOFI_FAB_IDLE_DISMISS_MS = 24 * 60 * 60 * 1000;

export function isIdleDismissed(until: number | null, now = Date.now()): boolean {
  return until != null && now < until;
}

export function readIdleDismissUntil(): number | null {
  try {
    const raw = localStorage.getItem(KOFI_FAB_IDLE_DISMISS_KEY);
    if (raw == null || raw.trim() === "") return null;
    const until = Number(raw);
    if (!Number.isFinite(until)) return null;
    return until;
  } catch {
    return null;
  }
}

export function writeIdleDismissUntil(until: number): boolean {
  try {
    localStorage.setItem(KOFI_FAB_IDLE_DISMISS_KEY, String(until));
    return true;
  } catch {
    return false;
  }
}

/** Persist now+24h. Write failure still returns `until` for in-memory hide. */
export function dismissIdleFab(now = Date.now()): { until: number; persisted: boolean } {
  const until = now + KOFI_FAB_IDLE_DISMISS_MS;
  return { until, persisted: writeIdleDismissUntil(until) };
}
