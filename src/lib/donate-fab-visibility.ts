/**
 * Routes where the Ko-fi FAB is suppressed. Shared by DonateButton and the
 * PWA update presenter so the Sonner toast fallback uses the same hide rules.
 *  - `/note` — admin panel
 *  - `*.md`  — raw plaintext view
 */
export function shouldHideDonateFab(pathname: string): boolean {
  if (pathname === "/note") return true;
  if (/\.md$/i.test(pathname)) return true;
  return false;
}
