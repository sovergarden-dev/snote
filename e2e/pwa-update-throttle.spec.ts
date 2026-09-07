import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { installPwaUpdateMock, pwaUpdateToast, releaseHeldReload, waitForPwaUpdaterReady } from "./helpers/pwa-update-mock";

// Cross-browser: this spec must pass on chromium, firefox, and webkit — do not
// scope it to a single project. CI runs the full matrix via PLAYWRIGHT_PROJECT.

type PwaUpdateState = {
  currentBuildId: string;
  pendingBuildId: string | null;
  updateAvailable: boolean;
  updateInProgress: boolean;
  lastRemoteBuildId: string | null;
  reloadAttemptCount: number;
  reloadStrategy: "waiting-sw" | "hard" | null;
  lastAcceptedAt: number | null;
};

async function pwaState(page: Page): Promise<PwaUpdateState | null> {
  return page.evaluate(() => (window as any).__SNOTE_PWA_UPDATE_STATE__ ?? null);
}

async function attach(testInfo: TestInfo, page: Page, label: string) {
  const state = await pwaState(page).catch((error) => ({ error: String(error) }));
  await testInfo.attach(`pwa-update-throttle-${label}.json`, {
    body: JSON.stringify({ state }, null, 2),
    contentType: "application/json",
  });
}

// On failure, attach a full-page screenshot + serialized toast DOM so the
// exact UI state at the flicker assertion is debuggable without opening the
// trace viewer. Playwright config also retains trace/video on failure.
let currentPageForHook: Page | null = null;
test.afterEach(async ({}, testInfo) => {
  const page = currentPageForHook;
  currentPageForHook = null;
  if (!page || testInfo.status === testInfo.expectedStatus) return;
  try {
    const shot = await page.screenshot({ fullPage: true });
    await testInfo.attach("pwa-update-throttle-failure.png", { body: shot, contentType: "image/png" });
    const toastHtml = await page.locator("[data-sonner-toast]").first()
      .evaluate((n) => (n as HTMLElement).outerHTML).catch(() => "<no toast>");
    await testInfo.attach("pwa-update-throttle-failure-toast.html", { body: toastHtml, contentType: "text/html" });
  } catch { /* best-effort */ }
});

test("Repeated Update clicks only fire one reload and toast never flickers back", async ({ page }, testInfo) => {
  test.setTimeout(20_000);
  currentPageForHook = page;
  // Hold the hard reload so we can rapid-fire click while the update is 'in-flight'.
  await installPwaUpdateMock(page, {
    fromBuildId: "build-v1",
    toBuildId: "build-v2",
    holdHardReload: true,
  });


  await page.goto("/");
  // Fail fast with a useful diagnostic if the poller never runs (rather than
  // timing out downstream on the toast assertion).
  await waitForPwaUpdaterReady(page, testInfo);

  const toast = pwaUpdateToast(page);
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await attach(testInfo, page, "before-click");

  const update = page.getByRole("button", { name: /^Update$/ });
  await update.click();

  // Deterministic wait: pending state must appear before we spam clicks.
  const pending = page.getByRole("button", { name: /^Update…$/ });
  await expect(pending).toBeDisabled({ timeout: 5_000 });
  await expect.poll(async () => (await pwaState(page))?.updateInProgress, { timeout: 5_000 }).toBe(true);

  for (let i = 0; i < 8; i++) {
    await pending.click({ force: true }).catch(() => {});
  }
  await expect(pwaUpdateToast(page, "pending")).toBeVisible({ timeout: 5_000 });
  await attach(testInfo, page, "while-pending");

  // Only one reload attempt should have been recorded.
  await expect.poll(async () => (await pwaState(page))?.reloadAttemptCount, { timeout: 3_000 }).toBe(1);

  // The state machine must stay in its pending invariant until the held reload
  // is released. Timer duration is covered at unit level; this browser check
  // verifies the observable state without a wall-clock sleep.
  await expect(toast).toHaveCount(0);
  await expect
    .poll(async () => (await pwaState(page))?.updateInProgress)
    .toBe(true);



  // Now release the held reload → buildId transitions → toast auto-hides.
  await releaseHeldReload(page);


  await expect(toast).toBeHidden({ timeout: 5_000 });
  await expect(pwaUpdateToast(page, "pending")).toBeHidden();
  const finalState = await pwaState(page);
  expect(finalState?.reloadAttemptCount).toBe(1);
  expect(finalState?.currentBuildId).toBe("build-v2");
  expect(finalState?.updateInProgress).toBe(false);
  expect(finalState?.updateAvailable).toBe(false);
  await attach(testInfo, page, "after-transition");
});
