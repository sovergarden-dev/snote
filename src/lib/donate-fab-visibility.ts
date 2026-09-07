/**
 * Routes where the Ko-fi FAB is suppressed. Shared by DonateButton and the
 * PWA update presenter so the Sonner toast fallback uses the same hide rules.
 *  - `/note` — admin panel
 *  - `*.md`  — raw plaintext view
 *
 * Trailing slashes are ignored so `/note/` and `/daily.md/` match the same
 * hide rules as the canonical paths (React Router vs `window.location` can
 * disagree on the slash).
 */
export function shouldHideDonateFab(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/note") return true;
  if (/\.md$/i.test(path)) return true;
  return false;
}
