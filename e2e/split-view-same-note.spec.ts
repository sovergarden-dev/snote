// E2E: same-note split (Pixel A1). Selected by e2e-pr so PR CI covers
// /slug+slug dual panes. LNO is mocked; this must not write production notes.
import { test, expect } from "@playwright/test";

test("same-note split /foo+foo stays two panes and does not collapse (A1)", async ({ page }) => {
  await page.route("**/functions/v1/legacy-note-open", async (route) => {
    const body = route.request().postDataJSON() as { slug?: string };
    const slug = body.slug ?? "note";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        exists: true,
        note: {
          slug,
          content: `# ${slug}\nSplit-view test note`,
          ydocState: "",
          isEncrypted: false,
          salt: null,
          check: null,
          iterations: null,
        },
      }),
    });
  });
  await page.goto("/foo+foo");
  await expect(page).toHaveURL(/\/foo\+foo$/);
  const panes = page.locator("[data-split-view-pane]");
  await expect(panes).toHaveCount(2, { timeout: 5_000 });
  await expect(page.getByRole("button", { name: /Sync scroll OFF/i })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
