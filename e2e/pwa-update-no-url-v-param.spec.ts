import { expect, test } from "@playwright/test";
import {
  expectPwaUpdatePrompt,
  getHardReloadCount,
  installPwaUpdateMock,
  pwaUpdateApplyControl,
  waitForPwaUpdaterReady,
} from "./helpers/pwa-update-mock";

test("Update preserves the note URL without appending or keeping ?v cache-busters", async ({ page }, testInfo) => {
  await installPwaUpdateMock(page, {
    fromBuildId: "build-url-v1",
    toBuildId: "build-url-v2",
    holdHardReload: true,
  });

  await page.goto("/123?v=legacy-noise&foo=bar");
  await waitForPwaUpdaterReady(page, testInfo);
  await expectPwaUpdatePrompt(page);

  await pwaUpdateApplyControl(page).click();
  await expect.poll(() => getHardReloadCount(page)).toBe(1);

  const url = new URL(page.url());
  expect(url.pathname).toBe("/123");
  expect(url.searchParams.get("foo")).toBe("bar");
  expect(url.searchParams.has("v")).toBe(false);
  expect(page.url()).not.toContain("build-url-v2");
});