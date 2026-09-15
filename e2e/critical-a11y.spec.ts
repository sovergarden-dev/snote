import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import * as Y from "yjs";

function encodeYdocState(content: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const encoded = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  doc.destroy();
  return encoded;
}

async function seedStableUi(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("home.scene", "none");
    localStorage.setItem("notes:preview-visible:wide", "0");
    localStorage.setItem("notes:preview-visible:narrow", "0");
  });
  await page.route("**/functions/v1/legacy-note-open", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { action?: string; slug?: string };
    const slug = body.slug ?? "";
    if (body.action === "exists") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ exists: true }),
      });
      return;
    }
    const encrypted = slug === "axe-locked";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        exists: true,
        note: {
          slug,
          content: encrypted ? "" : `# ${slug}\nAccessible note body`,
          ydocState: encrypted ? "Y2lwaGVydGV4dA==" : "",
          isEncrypted: encrypted,
          salt: encrypted ? "salt" : null,
          check: encrypted ? "check" : null,
          iterations: encrypted ? 600_000 : null,
        },
      }),
    });
  });
  await page.route("**/rest/v1/notes?**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }

    const slugFilter = new URL(request.url()).searchParams.get("slug") ?? "";
    const slug = slugFilter.startsWith("eq.") ? slugFilter.slice(3) : "";
    const encrypted = slug === "axe-locked";
    const content = `# ${slug}\nAccessible note body`;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([{
        slug,
        content: encrypted ? "" : content,
        ydoc_state: encrypted ? "Y2lwaGVydGV4dA==" : encodeYdocState(content),
        is_encrypted: encrypted,
        enc_salt: encrypted ? "salt" : null,
        enc_check: encrypted ? "check" : null,
        enc_iterations: encrypted ? 600_000 : null,
      }]),
    });
  });
}

async function expectNoAxeViolations(page: Page, info: TestInfo, label: string) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => {
      const iterations = animation.effect?.getTiming().iterations;
      return iterations === Infinity || animation.playState === "finished";
    }),
  );
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  if (violations.length > 0) {
    await info.attach(`axe-${label}.json`, {
      body: JSON.stringify(violations, null, 2),
      contentType: "application/json",
    });
  }
  expect(violations, `axe ${label}`).toEqual([]);
}

for (const device of [
  { name: "desktop", width: 1_280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`critical pages pass axe (${device.name})`, async ({ page }, info) => {
    // Five serial axe.analyze() calls exceed Playwright's 30s default on CI WebKit desktop.
    test.setTimeout(90_000);
    await page.setViewportSize({ width: device.width, height: device.height });
    await seedStableUi(page);

    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAxeViolations(page, info, `${device.name}-home`);

    await page.goto("/axe-note");
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoAxeViolations(page, info, `${device.name}-note`);

    await page.goto("/axe-left+axe-right");
    await expect(page.locator("[data-split-workspace]")).toBeVisible();
    if (device.name === "mobile") {
      await expect(page.getByRole("tablist")).toBeVisible();
    }
    await expectNoAxeViolations(page, info, `${device.name}-split`);

    await page.goto("/s#legacy-expired=1");
    await expect(page.getByRole("alert")).toBeVisible();
    await expectNoAxeViolations(page, info, `${device.name}-share`);

    await page.goto("/axe-locked");
    await expect(page.getByRole("heading", { name: "This note is encrypted" })).toBeVisible();
    await expectNoAxeViolations(page, info, `${device.name}-unlock`);
  });
}
