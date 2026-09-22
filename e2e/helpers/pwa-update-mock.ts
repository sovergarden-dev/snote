// Deterministic PWA-update mock for E2E specs.
//
// Wraps the ad-hoc addInitScript + page.route boilerplate used by
// pwa-update-*.spec.ts so every spec configures the fake service worker /
// hard-reload path the same way, and results are repeatable across runs and
// browsers (chromium/firefox/webkit).
//
// Key guarantees:
// - Uses fixed buildIds (no Date.now / Math.random anywhere in the setup).
// - Fixed poll intervals (initial 10ms, interval 250ms by default).
// - Optionally "holds" the hard-reload event so tests can inspect the
//   pending state deterministically and release it on demand.

import { expect, type Page } from "@playwright/test";
import { shouldHideDonateFab } from "../../src/lib/donate-fab-visibility";

export type PwaMockOptions = {
  fromBuildId: string;
  toBuildId: string;
  /** When true, defer applying the new buildId until releaseHeldReload() runs. */
  holdHardReload?: boolean;
  initialPollMs?: number;
  pollIntervalMs?: number;
};

export async function installPwaUpdateMock(page: Page, opts: PwaMockOptions): Promise<void> {
  const cfg = {
    initialPollMs: 10,
    pollIntervalMs: 250,
    holdHardReload: false,
    ...opts,
  };
  await page.addInitScript((c) => {
    (window as any).__SNOTE_E2E_ENABLE_PWA_UPDATE__ = true;
    (window as any).__SNOTE_E2E_BUILD_ID__ = c.fromBuildId;
    (window as any).__SNOTE_E2E_PWA_INITIAL_POLL_MS__ = c.initialPollMs;
    (window as any).__SNOTE_E2E_PWA_POLL_INTERVAL_MS__ = c.pollIntervalMs;
    (window as any).__SNOTE_E2E_HARD_RELOAD_COUNT__ = 0;
    (window as any).__SNOTE_E2E_HELD_TARGET__ = null;
    window.addEventListener("snote:e2e-pwa-hard-reload", (e: Event) => {
      (window as any).__SNOTE_E2E_HARD_RELOAD_COUNT__ += 1;
      const target = (e as CustomEvent).detail.targetBuildId;
      if (c.holdHardReload) {
        (window as any).__SNOTE_E2E_BUILD_ID__ = c.fromBuildId;
        (window as any).__SNOTE_E2E_HELD_TARGET__ = target;
      } else {
        (window as any).__SNOTE_E2E_BUILD_ID__ = target;
      }
    });
  }, cfg);
  await page.route("**/version.json**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ buildId: opts.toBuildId }),
    }),
  );
}

/** Release a held hard-reload so the toast transitions to the new buildId. */
export async function releaseHeldReload(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = (window as any).__SNOTE_E2E_HELD_TARGET__;
    if (t) (window as any).__SNOTE_E2E_BUILD_ID__ = t;
  });
}

export async function getHardReloadCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__SNOTE_E2E_HARD_RELOAD_COUNT__ ?? 0);
}

/**
 * Visible PWA-update Sonner toast. Substring `getByText("New version available")`
 * also matches the Ko-fi FAB's sr-only `role="status"` live region
 * ("New version available. Reload to update."), which fails Playwright strict
 * mode. Scope to the toast host and match the title exactly.
 *
 * Only assert this on FAB-hidden routes (`/note`, `*.md`). On FAB-eligible
 * routes the toast is suppressed; use {@link pwaUpdateFab} instead.
 */
export function pwaUpdateToast(page: Page, state: "available" | "pending" = "available") {
  const title = state === "pending" ? "Update pending" : "New version available";
  return page.locator("[data-sonner-toast]").filter({
    has: page.getByText(title, { exact: true }),
  });
}

const FAB_UPDATE_NAME = "New version available. Reload to update.";
const FAB_UPDATE_STATUS = "Update available";

/** Ko-fi FAB in update-available mode (primary click reloads). */
export function pwaUpdateFab(page: Page) {
  return page.getByRole("button", { name: FAB_UPDATE_NAME });
}

/** Non-interactive status chip above the update FAB (not a control). */
export function pwaUpdateFabStatus(page: Page) {
  return page.getByText(FAB_UPDATE_STATUS, { exact: true });
}

export function pwaUpdateFabLiveRegion(page: Page) {
  return page.getByRole("status").filter({ hasText: FAB_UPDATE_NAME });
}

function pathnameOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return "/";
  }
}

/** Primary control that applies the waiting PWA update on this page. */
export function pwaUpdateApplyControl(page: Page) {
  if (shouldHideDonateFab(pathnameOf(page))) {
    return page.getByRole("button", { name: /^Update$/ });
  }
  return pwaUpdateFab(page);
}

/**
 * Wait until the route-appropriate update UI is showing. FAB routes must not
 * also show the Sonner toast (that was the Pixel covering-toast failure).
 */
export async function expectPwaUpdatePrompt(page: Page): Promise<"fab" | "toast"> {
  if (shouldHideDonateFab(pathnameOf(page))) {
    await expect(pwaUpdateToast(page)).toBeVisible({ timeout: 5_000 });
    await expect(pwaUpdateFab(page)).toHaveCount(0);
    return "toast";
  }
  await expect(pwaUpdateFab(page)).toBeVisible({ timeout: 5_000 });
  await expect(pwaUpdateFabStatus(page)).toBeVisible();
  await expect(pwaUpdateFab(page).locator("span[aria-hidden='true']")).toHaveCount(0);
  await expect(pwaUpdateFabLiveRegion(page)).toHaveCount(1);
  await expect(pwaUpdateToast(page)).toHaveCount(0);
  return "fab";
}

/**
 * Wait for the version poller to have fetched at least once and populated
 * window.__SNOTE_PWA_UPDATE_STATE__. Fails fast with an attached diagnostic
 * (state snapshot, console log) if the poller stalls, so CI failures point
 * at "poller never ran" rather than a downstream toast assertion timeout.
 *
 * In non-E2E production this is where you'd also wait for the service worker
 * to reach `activated` before letting the Update button click. In E2E mode
 * (`__SNOTE_E2E_ENABLE_PWA_UPDATE__ = true`) the real SW is skipped, so we
 * only assert the poller side is healthy.
 */
export async function waitForPwaUpdaterReady(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  timeoutMs = 5000,
): Promise<void> {
  let lastState: unknown = null;
  try {
    await expect
      .poll(
        async () => {
          lastState = await page.evaluate(
            () => (window as any).__SNOTE_PWA_UPDATE_STATE__ ?? null,
          );
          return Boolean(
            lastState &&
              (lastState as { lastRemoteBuildId?: string }).lastRemoteBuildId,
          );
        },
        {
          timeout: timeoutMs,
          message: "version poller should publish its first remote build id",
        },
      )
      .toBe(true);
    return;
  } catch {
    // Attach the exact terminal state below so a timeout is actionable in CI.
  }
  const swState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    return {
      supported: true,
      hasRegistration: !!reg,
      active: reg?.active?.state ?? null,
      waiting: reg?.waiting?.state ?? null,
      installing: reg?.installing?.state ?? null,
    };
  });
  await testInfo.attach("pwa-updater-not-ready.json", {
    body: JSON.stringify({ lastState, swState, timeoutMs }, null, 2),
    contentType: "application/json",
  });
  throw new Error(
    `[pwa-update] version poller never populated __SNOTE_PWA_UPDATE_STATE__.lastRemoteBuildId within ${timeoutMs}ms — see pwa-updater-not-ready.json`,
  );
}
