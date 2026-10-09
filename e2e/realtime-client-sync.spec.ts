// PR #182-only exception: this E2E opens one randomly generated /slug in two
// browser contexts. The dedicated Bun runner overrides all three VITE_SUPABASE_*
// values with fake/local values, serves Edge/API and Node hub locally, and this
// test blocks every non-loopback HTTP(S) request and fails if one is attempted.
// Do not reuse this exception or fixture for other E2E suites.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function authStorageKeyFor(slug: string): Promise<string> {
  const slugNamespaceDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`syrin:realtime:plain-note-auth:v1:${slug}`),
  );
  const namespace = toBase64Url(new Uint8Array(slugNamespaceDigest));
  const storageDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`snote-auth-v1${namespace}`),
  );
  const hex = [...new Uint8Array(storageDigest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `snote-auth-v1-${hex}`;
}

async function createIsolatedContext(
  context: BrowserContext,
  slug: string,
  blockedRequests: string[],
  externalWebSockets: string[],
): Promise<Page> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }
    blockedRequests.push(url.href);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", async (route) => {
    const url = new URL(route.url());
    if (LOCAL_HOSTS.has(url.hostname)) {
      route.connectToServer();
      return;
    }
    externalWebSockets.push(url.href);
    await route.close({ code: 1008, reason: "non-loopback E2E traffic is forbidden" });
  });
  const key = await authStorageKeyFor(slug);
  await context.addInitScript(({ storageKey, now }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      access_token: "fake-local-auth-token-not-a-credential",
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: Math.floor(now / 1_000) + 3_600,
      refresh_token: "fake-local-refresh-token-not-a-credential",
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "anonymous", providers: ["anonymous"] },
        user_metadata: {},
        created_at: new Date(now).toISOString(),
      },
    }));
  }, { storageKey: key, now: Date.now() });
  const page = await context.newPage();
  return page;
}

test("flagged /slug realtime sync relays edits between isolated contexts", async ({ browser }) => {
  const slug = `rt-e2e-${crypto.randomUUID().slice(0, 8)}`;
  const blockedRequests: string[] = [];
  const externalWebSockets: string[] = [];
  const firstContext = await browser.newContext({ serviceWorkers: "block" });
  const secondContext = await browser.newContext({ serviceWorkers: "block" });
  try {
    const firstPage = await createIsolatedContext(firstContext, slug, blockedRequests, externalWebSockets);
    const secondPage = await createIsolatedContext(secondContext, slug, blockedRequests, externalWebSockets);
    await Promise.all([firstPage.goto(`/${slug}`), secondPage.goto(`/${slug}`)]);

    const firstEditor = firstPage.locator(".cm-content[contenteditable='true']");
    const secondEditor = secondPage.locator(".cm-content[contenteditable='true']");
    await expect(firstEditor).toBeVisible({ timeout: 20_000 });
    await expect(secondEditor).toBeVisible({ timeout: 20_000 });
    expect(firstPage.context()).not.toBe(secondPage.context());

    const marker = `pr182-${crypto.randomUUID()}`;
    await firstEditor.click();
    await firstEditor.press("Control+End");
    await firstEditor.press("Enter");
    await firstEditor.pressSequentially(marker, { delay: 2 });
    await expect(secondEditor).toContainText(marker, { timeout: 20_000 });

    // Any attempted external HTTP(S) or WebSocket request is blocked above and
    // makes this assertion fail; only loopback fixtures are permitted here.
    expect(blockedRequests).toEqual([]);
    expect(externalWebSockets).toEqual([]);
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
