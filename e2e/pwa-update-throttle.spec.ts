import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectPwaUpdatePrompt,
  installPwaUpdateMock,
  pwaUpdateApplyControl,
  pwaUpdateFab,
  pwaUpdateToast,
  releaseHeldReload,
  waitForPwaUpdaterReady,
} from "./helpers/pwa-update-mock";

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

// On failure, attach a full-page screenshot + serialized toast/FAB DOM so the
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
    const fabHtml = await page.getByRole("button", { name: "New version available. Reload to update." }).first()
      .evaluate((n) => (n as HTMLElement).outerHTML).catch(() => "<no fab>");
    await testInfo.attach("pwa-update-throttle-failure-fab.html", { body: fabHtml, contentType: "text/html" });
  } catch { /* best-effort */ }
});

test("Repeated FAB apply clicks only fire one reload and no Sonner toast covers the FAB", async ({ page }, testInfo) => {
  test.setTimeout(20_000);
  currentPageForHook = page;
  // Hold the hard reload so we can rapid-fire click while the update is 'in-flight'.
  await installPwaUpdateMock(page, {
    fromBuildId: "build-v1",
    toBuildId: "build-v2",
    holdHardReload: true,
  });

  await page.goto("/");
  await waitForPwaUpdaterReady(page, testInfo);
  await expectPwaUpdatePrompt(page);
  await attach(testInfo, page, "before-click");

  const apply = pwaUpdateApplyControl(page);
  await apply.click();

  await expect.poll(async () => (await pwaState(page))?.updateInProgress, { timeout: 5_000 }).toBe(true);

  for (let i = 0; i < 8; i++) {
    await apply.click({ force: true }).catch(() => {});
  }
  await expect(pwaUpdateToast(page)).toHaveCount(0);
  await expect(pwaUpdateToast(page, "pending")).toHaveCount(0);
  await attach(testInfo, page, "while-pending");

  await expect.poll(async () => (await pwaState(page))?.reloadAttemptCount, { timeout: 3_000 }).toBe(1);
  await expect
    .poll(async () => (await pwaState(page))?.updateInProgress)
    .toBe(true);

  await releaseHeldReload(page);

  await expect(pwaUpdateFab(page)).toHaveCount(0);
  await expect(pwaUpdateToast(page)).toHaveCount(0);
  const finalState = await pwaState(page);
  expect(finalState?.reloadAttemptCount).toBe(1);
  expect(finalState?.currentBuildId).toBe("build-v2");
  expect(finalState?.updateInProgress).toBe(false);
  expect(finalState?.updateAvailable).toBe(false);
  await attach(testInfo, page, "after-transition");
});

test("FAB-hidden /note keeps the Sonner toast fallback", async ({ page }, testInfo) => {
  currentPageForHook = page;
  await installPwaUpdateMock(page, {
    fromBuildId: "build-note-v1",
    toBuildId: "build-note-v2",
  });
  await page.goto("/note");
  await waitForPwaUpdaterReady(page, testInfo);
  await expectPwaUpdatePrompt(page);
  await expect(page.getByRole("button", { name: /^Update$/ })).toBeVisible();
});
