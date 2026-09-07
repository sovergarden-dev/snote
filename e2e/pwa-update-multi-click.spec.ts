// E2E: clicking Update multiple times only triggers one reload path and the
// note URL never gains a ?v= cache-buster, even under rapid repeated clicks.
import { expect, test } from "@playwright/test";
import {
  expectPwaUpdatePrompt,
  getHardReloadCount,
  installPwaUpdateMock,
  pwaUpdateApplyControl,
  pwaUpdateToast,
  waitForPwaUpdaterReady,
} from "./helpers/pwa-update-mock";

test("multiple Update clicks apply the new build without adding ?v to the URL", async ({ page }, testInfo) => {
  // Record every URL the page navigates to so a `?v=` regression is easy to
  // trace back to the exact click that introduced it (attached below).
  const urlHistory: Array<{ at: number; url: string; type: "goto" | "framenavigated" }> = [];
  const t0 = Date.now();
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      urlHistory.push({ at: Date.now() - t0, url: frame.url(), type: "framenavigated" });
    }
  });

  // Snapshot of `navigator.serviceWorker.getRegistrations()` — helps trace
  // whether a rogue SW is the source of a `?v=` cache-buster.
  const snapshotSwRegs = () =>
    page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { available: false as const };
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        return {
          available: true as const,
          registrations: regs.map((r) => ({
            scope: r.scope,
            scriptURL: r.active?.scriptURL ?? r.installing?.scriptURL ?? r.waiting?.scriptURL ?? null,
            state: r.active?.state ?? r.installing?.state ?? r.waiting?.state ?? null,
          })),
        };
      } catch (e) {
        return { available: true as const, error: String(e) };
      }
    });

  await installPwaUpdateMock(page, {
    fromBuildId: "build-multi-v1",
    toBuildId: "build-multi-v2",
  });

  urlHistory.push({ at: Date.now() - t0, url: "/my-note?foo=bar", type: "goto" });
  await page.goto("/my-note?foo=bar");
  await waitForPwaUpdaterReady(page, testInfo);

  const swBefore = await snapshotSwRegs();
  console.log("[pwa-smoke] SW registrations BEFORE Update:", JSON.stringify(swBefore));

  await expectPwaUpdatePrompt(page);

  const update = pwaUpdateApplyControl(page);
  await update.click();
  // Rapid follow-up clicks should be ignored (apply is a no-op while in-flight).
  // Bound each click's wait: once the update applies, the FAB/toast control
  // is dismissed, and an unbounded locator wait for the vanishing
  // button would otherwise eat the whole test budget — the exact WebKit
  // flake where the spec stalled in the follow-up loop and never reached
  // the reload-count poll.
  for (let i = 0; i < 4; i++) {
    await pwaUpdateApplyControl(page)
      .click({ force: true, timeout: 2_000 })
      .catch(() => {});
  }

  await expect.poll(() => getHardReloadCount(page)).toBe(1);
  await expect(pwaUpdateToast(page)).toHaveCount(0);

  const swAfter = await snapshotSwRegs();
  console.log("[pwa-smoke] SW registrations AFTER Update:", JSON.stringify(swAfter));

  const url = new URL(page.url());
  const hasVParam = url.searchParams.has("v");
  // Whitelist: only these query params are allowed to survive the Update
  // click flow. Anything else (e.g. `?v=`, `?ver=`, `?t=`, `?nocache=`) is
  // treated as a cache-buster regression.
  const ALLOWED_QUERY = new Set(["foo"]);
  const unexpectedQuery = [...url.searchParams.keys()].filter((k) => !ALLOWED_QUERY.has(k));

  const isRegression =
    hasVParam ||
    unexpectedQuery.length > 0 ||
    url.pathname !== "/my-note" ||
    url.searchParams.get("foo") !== "bar";

  if (isRegression) {
    await testInfo.attach("url-history.json", {
      body: JSON.stringify(
        { finalUrl: page.url(), history: urlHistory, unexpectedQuery, swBefore, swAfter },
        null,
        2,
      ),
      contentType: "application/json",
    });
    await testInfo.attach("regression-screenshot.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    console.error("[pwa-smoke] regression detected", {
      finalUrl: page.url(),
      unexpectedQuery,
      urlHistory,
      swBefore,
      swAfter,
    });
  }

  expect(url.pathname).toBe("/my-note");
  expect(url.searchParams.get("foo")).toBe("bar");
  expect(hasVParam, `note URL gained ?v= after Update clicks: ${page.url()}`).toBe(false);
  expect(
    unexpectedQuery,
    `note URL gained unexpected query params after Update clicks: ${unexpectedQuery.join(",")} — full URL: ${page.url()}`,
  ).toEqual([]);

  // Reload once and re-assert the whitelist. Catches the case where a
  // service worker rewrites navigations on the next load (the exact bug
  // that forced users to clear cookies).
  urlHistory.push({ at: Date.now() - t0, url: page.url(), type: "goto" });
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedUrl = new URL(page.url());
  const reloadedUnexpected = [...reloadedUrl.searchParams.keys()].filter((k) => !ALLOWED_QUERY.has(k));
  if (reloadedUnexpected.length > 0 || reloadedUrl.searchParams.has("v")) {
    await testInfo.attach("url-history-post-reload.json", {
      body: JSON.stringify(
        { finalUrl: page.url(), history: urlHistory, reloadedUnexpected, swAfter },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
  expect(reloadedUrl.pathname).toBe("/my-note");
  expect(reloadedUrl.searchParams.has("v"), `reload re-introduced ?v=: ${page.url()}`).toBe(false);
  expect(
    reloadedUnexpected,
    `reload re-introduced unexpected query params: ${reloadedUnexpected.join(",")} — full URL: ${page.url()}`,
  ).toEqual([]);
});
