// Dedicated local-only realtime E2E. The Bun runner uses fake/local Supabase,
// Edge and two Node hubs; this test blocks every non-loopback HTTP(S)/WebSocket
// request and fails if one is attempted. Do not reuse this fixture for other suites.
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
  await context.addInitScript(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
      originalSetTimeout(handler, timeout === 90_000 ? 1_000 : timeout, ...args)) as typeof window.setTimeout;
  });
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

async function outboxCount(page: Page, slug: string): Promise<number> {
  return page.evaluate(async (noteSlug) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("snote-realtime-outbox", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("outbox database unavailable"));
    });
    try {
      const rows = await new Promise<Array<{ slug?: unknown }>>((resolve, reject) => {
        const request = db.transaction("updates", "readonly").objectStore("updates").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ slug?: unknown }>);
        request.onerror = () => reject(request.error ?? new Error("outbox query failed"));
      });
      return rows.filter((row) => row.slug === noteSlug).length;
    } finally {
      db.close();
    }
  }, slug);
}

test("flagged /slug concurrent edits survive revision conflict and both contexts receive ACK", async ({ browser }) => {
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

    const edgeUrl = process.env.VITE_SUPABASE_URL;
    if (!edgeUrl) throw new Error("local fake Edge URL is not set");
    const barrier = await firstContext.request.post(`${edgeUrl}/_test/control`, {
      data: { operation: "enable-cas-conflict", slug },
    });
    expect(barrier.ok()).toBe(true);

    const firstMarker = `context-one-${crypto.randomUUID()}`;
    const secondMarker = `context-two-${crypto.randomUUID()}`;
    const appendMarker = async (editor: typeof firstEditor, marker: string) => {
      await editor.click();
      await editor.press("Control+End");
      await editor.press("Enter");
      await editor.pressSequentially(marker, { delay: 1 });
    };
    await Promise.all([
      appendMarker(firstEditor, firstMarker),
      appendMarker(secondEditor, secondMarker),
    ]);
    await expect(firstEditor).toContainText(firstMarker, { timeout: 20_000 });
    await expect(firstEditor).toContainText(secondMarker, { timeout: 20_000 });
    await expect(secondEditor).toContainText(firstMarker, { timeout: 20_000 });
    await expect(secondEditor).toContainText(secondMarker, { timeout: 20_000 });

    const inspectUrl = `${edgeUrl}/_test/notes/${encodeURIComponent(slug)}`;
    await expect.poll(async () => {
      const response = await firstContext.request.get(inspectUrl);
      if (!response.ok()) return 0;
      const state = await response.json() as { casAccepted: number };
      return state.casAccepted;
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    const inspectResponse = await firstContext.request.get(inspectUrl);
    const state = await inspectResponse.json() as {
      content: string;
      casAttempts: number;
      casCommits: number;
      casAccepted: number;
      casConflicts: number;
      expectedRevisions: number[];
    };
    expect(state.casAttempts).toBeGreaterThanOrEqual(3);
    expect(state.expectedRevisions.slice(0, 3)).toEqual([1, 1, 2]);
    expect(state.casConflicts).toBeGreaterThanOrEqual(1);
    expect(state.casAccepted).toBeGreaterThanOrEqual(2);
    expect(state.casCommits).toBeGreaterThanOrEqual(1);
    expect(state.content).toContain(firstMarker);
    expect(state.content).toContain(secondMarker);
    await expect.poll(() => outboxCount(firstPage, slug), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => outboxCount(secondPage, slug), { timeout: 20_000 }).toBe(0);

    // Any attempted external HTTP(S) or WebSocket request is blocked above and
    // makes this assertion fail; only loopback fixtures are permitted here.
    expect(blockedRequests).toEqual([]);
    expect(externalWebSockets).toEqual([]);
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test("routes from disabled rt1 to rt2 and preserves pending outbox through the hub change", async ({ browser }) => {
  const slug = `rt-e2e-failover-${crypto.randomUUID().slice(0, 8)}`;
  const blockedRequests: string[] = [];
  const externalWebSockets: string[] = [];
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const page = await createIsolatedContext(context, slug, blockedRequests, externalWebSockets);
    await page.goto(`/${slug}`);
    const editor = page.locator(".cm-content[contenteditable='true']");
    await expect(editor).toBeVisible({ timeout: 20_000 });

    const edgeUrl = process.env.VITE_SUPABASE_URL;
    if (!edgeUrl) throw new Error("local fake Edge URL is not set");
    const inspect = async () => {
      const response = await context.request.get(`${edgeUrl}/_test/notes/${encodeURIComponent(slug)}`);
      if (!response.ok()) throw new Error("local failover diagnostics are unavailable");
      return response.json() as Promise<{
        hubId: string;
        assignmentEpoch: number;
        issuedHubIds: string[];
        hubReportCount: number;
        probeFailures: number;
        casBlocked: boolean;
        hub1Disabled: boolean;
        hub1Upgrades: number;
        hub2Upgrades: number;
        content: string;
        casAccepted: number;
      }>;
    };
    const control = async (operation: "block-cas" | "unblock-cas" | "disable-hub1") => {
      const response = await context.request.post(`${edgeUrl}/_test/control`, {
        data: { operation, slug },
      });
      expect(response.ok()).toBe(true);
    };

    await expect.poll(async () => (await inspect()).hub1Upgrades, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await inspect()).issuedHubIds[0], { timeout: 20_000 }).toBe("rt1");
    await control("block-cas");

    const marker = `outbox-survives-${crypto.randomUUID()}`;
    await editor.click();
    await editor.press("Control+End");
    await editor.press("Enter");
    await editor.pressSequentially(marker, { delay: 1 });
    await expect(editor).toContainText(marker);
    await expect.poll(() => outboxCount(page, slug), { timeout: 10_000 }).toBeGreaterThan(0);

    await control("disable-hub1");
    await expect.poll(async () => {
      const state = await inspect();
      return state.hubId === "rt2"
        && state.assignmentEpoch === 2
        && state.issuedHubIds.includes("rt2")
        && state.hubReportCount >= 1
        && state.probeFailures >= 1
        && state.hub1Disabled
        && state.hub2Upgrades >= 1;
    }, { timeout: 30_000 }).toBe(true);

    expect(await outboxCount(page, slug)).toBeGreaterThan(0);
    const switchedState = await inspect();
    expect(switchedState.issuedHubIds[0]).toBe("rt1");
    expect(switchedState.issuedHubIds).toContain("rt2");
    await control("unblock-cas");

    await expect.poll(() => outboxCount(page, slug), { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => (await inspect()).content, { timeout: 30_000 }).toContain(marker);
    expect((await inspect()).casAccepted).toBeGreaterThan(0);
    expect(blockedRequests).toEqual([]);
    expect(externalWebSockets).toEqual([]);
  } finally {
    await context.close();
  }
});
