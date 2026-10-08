// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker.js";

const CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; " +
  "frame-ancestors 'self' chrome-extension://*; script-src 'self' https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://flagcdn.com " +
  "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev; font-src 'self' data:; " +
  "connect-src 'self' https://onfzjmfjldsbthchssfr.supabase.co " +
  "wss://onfzjmfjldsbthchssfr.supabase.co https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; " +
  "manifest-src 'self'; upgrade-insecure-requests;";
const PRIVATE_ROBOTS = "noindex, nofollow, noarchive, nosnippet";
const PERMISSIONS_POLICY =
  "camera=(), geolocation=(), microphone=(), payment=()";
const ENV = {
  ORIGIN_HOST: "snote.lovable.app",
  SITE_URL: "https://note.syrin.online",
};
const STAGING_SERVE_ORIGIN =
  "https://syrin-prerender-staging.thongdocnganhang1.workers.dev";
const STAGING_SUPABASE_ORIGIN =
  "https://abcdefghijklmnopqrst.supabase.co";
const STAGING_SUPABASE_WS_ORIGIN =
  "wss://abcdefghijklmnopqrst.supabase.co";
const STAGING_CSP = CSP
  .replace("https://onfzjmfjldsbthchssfr.supabase.co", STAGING_SUPABASE_ORIGIN)
  .replace("wss://onfzjmfjldsbthchssfr.supabase.co", STAGING_SUPABASE_WS_ORIGIN);
const RESTRICTIVE_CSP = CSP
  .replace(" https://onfzjmfjldsbthchssfr.supabase.co", "")
  .replace(" wss://onfzjmfjldsbthchssfr.supabase.co", "");
const STAGING_ENV = {
  ORIGIN_HOST: "isolated-staging-origin.example",
  SITE_URL: "https://note.syrin.online",
  EDGE_SERVE_ORIGIN: STAGING_SERVE_ORIGIN,
  STAGING_SUPABASE_ORIGIN,
};

function installOriginDouble() {
  const originFetch = vi.fn(async () =>
    new Response("<!doctype html><html><body>app shell</body></html>", {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        etag: '"origin-etag"',
        "last-modified": "Tue, 28 Jul 2026 00:00:00 GMT",
        nel: '{"report_to":"origin"}',
        "report-to": '{"group":"origin"}',
        "reporting-endpoints": 'origin="https://telemetry.invalid/report"',
        "server-timing": "analytics;dur=1",
      },
    }),
  );
  const cacheMatch = vi.fn(async () => undefined);
  const cachePut = vi.fn(async () => undefined);
  const waitUntil = vi.fn();

  vi.stubGlobal("fetch", originFetch);
  vi.stubGlobal("caches", {
    default: { match: cacheMatch, put: cachePut },
  });

  return { originFetch, cacheMatch, cachePut, waitUntil };
}

async function expectFailClosedOriginResponse(
  response: Response,
  secrets: string[] = [],
  expectedCsp = CSP,
) {
  const body = await response.text();
  const observable = [
    body,
    ...Array.from(response.headers.entries()).flat(),
  ].join("\n");

  expect(response.status).toBe(503);
  expect(body).toBe("Service temporarily unavailable");
  expect(response.headers.get("content-security-policy")).toBe(expectedCsp);
  expect(response.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("expires")).toBe("0");
  expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_ROBOTS);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-frame-options")).toBeNull();
  expect(response.headers.get("x-origin-secret")).toBeNull();
  for (const secret of secrets) expect(observable).not.toContain(secret);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("edge privacy containment", () => {
  it.each([
    { path: "/~flock.js", statuses: [410] },
    { path: "/~api/analytics", statuses: [204, 410] },
    { path: "/~api/analytics/events", statuses: [204, 410] },
    { path: "/x/%252e%252e/~flock.js", statuses: [410] },
    {
      path: "/x/%252e%252e/~api%252fanalytics/events",
      statuses: [204, 410],
    },
  ])("denies $path before the Lovable origin", async ({ path, statuses }) => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request(`https://note.syrin.online${path}`),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(statuses).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it.each([
    "/synthetic-private-note",
    "/s/synthetic-share-capability",
    "/unlock",
    "/embed/synthetic-private-note",
    "/embed/synthetic-private-note.js",
    "/api/error",
    "/compat/synthetic-private-note",
  ])("makes private HTML uncacheable and non-indexable for %s", async (path) => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request(`https://note.syrin.online${path}`, {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_ROBOTS);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    expect(response.headers.get("nel")).toBeNull();
    expect(response.headers.get("report-to")).toBeNull();
    expect(response.headers.get("reporting-endpoints")).toBeNull();
    expect(response.headers.get("server-timing")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it.each(["/", "/privacy"])(
    "keeps the public document %s outside private indexing policy",
    async (path) => {
      const doubles = installOriginDouble();

      const response = await worker.fetch(
        new Request(`https://note.syrin.online${path}`, {
          headers: { "user-agent": "Mozilla/5.0" },
        }),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.headers.get("x-robots-tag")).toBeNull();
      expect(response.headers.get("content-security-policy")).toBe(CSP);
      expect(response.headers.get("permissions-policy")).toBe(
        PERMISSIONS_POLICY,
      );
      expect(response.headers.get("x-frame-options")).toBeNull();
    },
  );

  it.each(["/", "/privacy"])(
    "does not expose a public document query to the origin for %s",
    async (path) => {
      const doubles = installOriginDouble();
      const syntheticQuery = "private-capability-must-not-reach-origin";

      await worker.fetch(
        new Request(
          `https://note.syrin.online${path}?token=${syntheticQuery}`,
          { headers: { "user-agent": "Mozilla/5.0" } },
        ),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      expect(originUrl.pathname).toBe(path);
      expect(originUrl.search).toBe("");
      expect(originRequest.url).not.toContain(syntheticQuery);
    },
  );

  it.each(["/", "/privacy"])(
    "does not forward a Workbox revision query from the public document %s",
    async (path) => {
      const doubles = installOriginDouble();

      await worker.fetch(
        new Request(
          `https://note.syrin.online${path}?__WB_REVISION__=root&token=secret`,
          { headers: { "user-agent": "Mozilla/5.0" } },
        ),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      expect(originUrl.pathname).toBe(path);
      expect(originUrl.search).toBe("");
      expect(originRequest.url).not.toContain("__WB_REVISION__");
      expect(originRequest.url).not.toContain("token");
      expect(originRequest.url).not.toContain("secret");
    },
  );

  it("uses a query-free cache key for crawler home responses", async () => {
    const doubles = installOriginDouble();
    const syntheticQuery = "private-capability-must-not-enter-edge-cache";

    const response = await worker.fetch(
      new Request(`https://note.syrin.online/?token=${syntheticQuery}`, {
        headers: { "user-agent": "Googlebot" },
      }),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(response.status).toBe(200);
    expect(doubles.cacheMatch).toHaveBeenCalledOnce();
    expect(doubles.cachePut).toHaveBeenCalledOnce();
    for (const cacheKey of [
      doubles.cacheMatch.mock.calls[0]?.[0] as Request,
      doubles.cachePut.mock.calls[0]?.[0] as Request,
    ]) {
      const cacheUrl = new URL(cacheKey.url);
      expect(cacheUrl.pathname).toBe("/");
      expect(cacheUrl.search).toBe("");
      expect(cacheKey.url).not.toContain(syntheticQuery);
    }
  });

  it.each([
    {
      label: "canonical",
      requestOrigin: "https://note.syrin.online",
      env: ENV,
    },
    {
      label: "staging",
      requestOrigin: STAGING_SERVE_ORIGIN,
      env: STAGING_ENV,
    },
  ])(
    "does not reflect a sensitive query while normalizing crawler home on $label",
    async ({ requestOrigin, env }) => {
      const doubles = installOriginDouble();
      const secret = "capability-secret-must-not-enter-location";

      const response = await worker.fetch(
        new Request(
          `${requestOrigin}/%252e%252e/?token=${secret}`,
          { headers: { "user-agent": "Googlebot" } },
        ),
        env,
        { waitUntil: doubles.waitUntil },
      );
      const location = response.headers.get("location") ?? "";
      const redirectUrl = new URL(location);

      expect(response.status).toBe(301);
      expect(redirectUrl.origin).toBe(requestOrigin);
      expect(redirectUrl.pathname).toBe("/");
      expect(redirectUrl.search).toBe("");
      expect(location).not.toContain(secret);
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it("publicly caches only fingerprinted assets", async () => {
    const doubles = installOriginDouble();

    const fingerprinted = await worker.fetch(
      new Request("https://note.syrin.online/assets/index-AbCdEf12.js"),
      ENV,
      { waitUntil: doubles.waitUntil },
    );
    const unfingerprinted = await worker.fetch(
      new Request("https://note.syrin.online/assets/runtime.js"),
      ENV,
      { waitUntil: doubles.waitUntil },
    );
    const workerIdentity = await worker.fetch(
      new Request(
        "https://note.syrin.online/sw-identity-0123456789abcdef.js",
      ),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(fingerprinted.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(unfingerprinted.headers.get("cache-control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(unfingerprinted.headers.get("cdn-cache-control")).toBe("no-store");
    expect(workerIdentity.headers.get("cache-control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(workerIdentity.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it.each([
    "/assets/index-AbCdEf12.js",
    "/assets/runtime.js",
    "/sw-identity-0123456789abcdef.js",
    "/theme-init.js",
  ])("strips untrusted queries before fetching the allowed asset %s", async (path) => {
    const doubles = installOriginDouble();
    const syntheticQuery = "private-capability-must-not-reach-origin";

    await worker.fetch(
      new Request(
        `https://note.syrin.online${path}?token=${syntheticQuery}`,
      ),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
    const originUrl = new URL(originRequest.url);
    expect(originUrl.pathname).toBe(path);
    expect(originUrl.search).toBe("");
    expect(originRequest.url).not.toContain(syntheticQuery);
  });

  it("treats an unlisted root artifact as a private route", async () => {
    const doubles = installOriginDouble();
    const syntheticQuery = "private-capability-must-not-reach-origin";

    const response = await worker.fetch(
      new Request(
        `https://note.syrin.online/private-capability.js?token=${syntheticQuery}`,
      ),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
    const originUrl = new URL(originRequest.url);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_ROBOTS);
    expect(originUrl.pathname).toBe("/");
    expect(originUrl.search).toBe("");
    expect(originRequest.url).not.toContain(syntheticQuery);
  });

  it.each([
    { path: "/", expectedOriginPath: "/" },
    { path: "/privacy", expectedOriginPath: "/privacy" },
    { path: "/version.json", expectedOriginPath: "/version.json" },
    { path: "/synthetic-private-capability", expectedOriginPath: "/" },
  ])(
    "serves the isolated staging shell for $path without redirecting",
    async ({ path, expectedOriginPath }) => {
      const doubles = installOriginDouble();

      const response = await worker.fetch(
        new Request(`${STAGING_SERVE_ORIGIN}${path}`, {
          headers: { "user-agent": "Mozilla/5.0" },
        }),
        STAGING_ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(doubles.originFetch).toHaveBeenCalledOnce();
      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      expect(originUrl.hostname).toBe(STAGING_ENV.ORIGIN_HOST);
      expect(originUrl.pathname).toBe(expectedOriginPath);
      expect(originUrl.search).toBe("");
    },
  );

  it("keeps production canonical metadata on the staging crawler home", async () => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request(`${STAGING_SERVE_ORIGIN}/`, {
        headers: { "user-agent": "Googlebot" },
      }),
      STAGING_ENV,
      { waitUntil: doubles.waitUntil },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(
      '<link rel="canonical" href="https://note.syrin.online/"',
    );
    expect(body).toContain(
      '<meta property="og:url" content="https://note.syrin.online/"',
    );
    expect(body).not.toContain(STAGING_SERVE_ORIGIN);
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it("uses only the isolated staging Supabase origin in staging HTML CSP", async () => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request(`${STAGING_SERVE_ORIGIN}/synthetic-private-capability`, {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
      STAGING_ENV,
      { waitUntil: doubles.waitUntil },
    );

    const csp = response.headers.get("content-security-policy");
    expect(response.status).toBe(200);
    expect(csp).toBe(STAGING_CSP);
    expect(csp).toContain(STAGING_SUPABASE_ORIGIN);
    expect(csp).toContain(STAGING_SUPABASE_WS_ORIGIN);
    expect(csp).not.toContain("onfzjmfjldsbthchssfr");
  });

  it.each([
    undefined,
    "https://onfzjmfjldsbthchssfr.supabase.co",
    "http://abcdefghijklmnopqrst.supabase.co",
    "https://abcdefghijklmnopqrst.supabase.co/private",
    "https://untrusted.example",
  ])("fails closed for an invalid staging Supabase origin: %s", async (origin) => {
    const doubles = installOriginDouble();
    const response = await worker.fetch(
      new Request(`${STAGING_SERVE_ORIGIN}/synthetic-private-capability`),
      { ...STAGING_ENV, STAGING_SUPABASE_ORIGIN: origin },
      { waitUntil: doubles.waitUntil },
    );

    await expectFailClosedOriginResponse(response, [], RESTRICTIVE_CSP);
    expect(doubles.originFetch).not.toHaveBeenCalled();
    expect(response.headers.get("content-security-policy"))
      .not.toContain("onfzjmfjldsbthchssfr");
  });

  it("refuses a staging Supabase override in production mode", async () => {
    const doubles = installOriginDouble();
    const response = await worker.fetch(
      new Request("https://note.syrin.online/synthetic-private-capability"),
      { ...ENV, STAGING_SUPABASE_ORIGIN },
      { waitUntil: doubles.waitUntil },
    );

    await expectFailClosedOriginResponse(response, [], RESTRICTIVE_CSP);
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it("keeps the production sitemap on staging robots.txt", async () => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request(`${STAGING_SERVE_ORIGIN}/robots.txt`),
      STAGING_ENV,
      { waitUntil: doubles.waitUntil },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain(
      "Sitemap: https://note.syrin.online/sitemap.xml",
    );
    expect(body).not.toContain(STAGING_SERVE_ORIGIN);
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "HTTP",
      edgeServeOrigin:
        "http://syrin-prerender-staging.thongdocnganhang1.workers.dev",
    },
    {
      label: "credentials",
      edgeServeOrigin:
        "https://edge-user:edge-secret@syrin-prerender-staging.thongdocnganhang1.workers.dev",
    },
    {
      label: "port",
      edgeServeOrigin:
        "https://syrin-prerender-staging.thongdocnganhang1.workers.dev:8443",
    },
    {
      label: "path",
      edgeServeOrigin:
        "https://syrin-prerender-staging.thongdocnganhang1.workers.dev/private",
    },
    {
      label: "query",
      edgeServeOrigin:
        "https://syrin-prerender-staging.thongdocnganhang1.workers.dev/?token=edge-secret",
    },
    {
      label: "fragment",
      edgeServeOrigin:
        "https://syrin-prerender-staging.thongdocnganhang1.workers.dev/#edge-secret",
    },
    {
      label: "mismatched host",
      edgeServeOrigin: "https://different-staging-worker.workers.dev",
    },
  ])(
    "fails closed for a malformed or mismatched $label EDGE_SERVE_ORIGIN",
    async ({ edgeServeOrigin }) => {
      const doubles = installOriginDouble();
      const response = await worker.fetch(
        new Request(`${STAGING_SERVE_ORIGIN}/privacy`),
        { ...STAGING_ENV, EDGE_SERVE_ORIGIN: edgeServeOrigin },
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(
        response,
        ["edge-secret"],
        RESTRICTIVE_CSP,
      );
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "production config",
      requestOrigin: STAGING_SERVE_ORIGIN,
      env: ENV,
    },
    {
      label: "missing staging config",
      requestOrigin: STAGING_SERVE_ORIGIN,
      env: { ...STAGING_ENV, EDGE_SERVE_ORIGIN: undefined },
    },
    {
      label: "wrong incoming authority",
      requestOrigin: "https://unknown-staging-authority.workers.dev",
      env: STAGING_ENV,
    },
  ])(
    "fails closed for a staging request with $label",
    async ({ requestOrigin, env }) => {
      const doubles = installOriginDouble();
      const response = await worker.fetch(
        new Request(`${requestOrigin}/privacy?token=request-secret`),
        env,
        { waitUntil: doubles.waitUntil },
      );

      const expectedCsp = env === ENV
        ? CSP
        : env.EDGE_SERVE_ORIGIN === STAGING_SERVE_ORIGIN
          ? STAGING_CSP
          : RESTRICTIVE_CSP;
      await expectFailClosedOriginResponse(
        response,
        ["request-secret"],
        expectedCsp,
      );
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://syrin-prerender-staging.thongdocnganhang1.workers.dev/privacy?token=request-secret",
    "https://syrin-prerender-staging.thongdocnganhang1.workers.dev:8443/privacy?token=request-secret",
  ])(
    "fails closed for non-exact staging transport %s",
    async (requestUrl) => {
      const doubles = installOriginDouble();
      const response = await worker.fetch(
        new Request(requestUrl),
        STAGING_ENV,
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(
        response,
        ["request-secret"],
        STAGING_CSP,
      );
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://note.syrin.online",
    "https://syrin.online",
    "https://www.syrin.online",
  ])(
    "fails closed for production authority %s under staging config",
    async (requestOrigin) => {
      const doubles = installOriginDouble();
      const response = await worker.fetch(
        new Request(`${requestOrigin}/privacy?token=request-secret`),
        STAGING_ENV,
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(
        response,
        ["request-secret"],
        STAGING_CSP,
      );
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "syrin-prerender-staging.thongdocnganhang1.workers.dev",
    "syrin-prerender-staging.thongdocnganhang1.workers.dev.",
  ])(
    "rejects the staging serve authority as origin: %s",
    async (originHost) => {
      const doubles = installOriginDouble();
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line) =>
        logs.push(String(line)),
      );

      const response = await worker.fetch(
        new Request(
          `${STAGING_SERVE_ORIGIN}/synthetic-private-capability`,
        ),
        { ...STAGING_ENV, ORIGIN_HOST: originHost },
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(response, [], STAGING_CSP);
      expect(doubles.originFetch).not.toHaveBeenCalled();
      expect(JSON.parse(logs[0])).toMatchObject({
        msg: "origin_unavailable",
        reason: "self_reference",
        status: 503,
      });
    },
  );

  it("redirects a public alias route to the canonical origin", async () => {
    const doubles = installOriginDouble();

    const response = await worker.fetch(
      new Request("https://syrin.online/privacy", {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://note.syrin.online/privacy",
    );
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "downgrade and port",
      siteUrl: "http://note.syrin.online:8080",
      marker: "8080",
    },
    {
      label: "unapproved hostname",
      siteUrl: "https://redirect-target.invalid",
      marker: "redirect-target.invalid",
    },
    {
      label: "userinfo",
      siteUrl: "https://site-user:site-secret@note.syrin.online/",
      marker: "site-secret",
    },
    {
      label: "non-root path",
      siteUrl: "https://note.syrin.online/untrusted-path",
      marker: "untrusted-path",
    },
    {
      label: "query",
      siteUrl: "https://note.syrin.online/?untrusted=query-secret",
      marker: "query-secret",
    },
    {
      label: "fragment",
      siteUrl: "https://note.syrin.online/#untrusted-fragment",
      marker: "untrusted-fragment",
    },
  ])(
    "fails closed instead of using a $label SITE_URL",
    async ({ siteUrl, marker }) => {
      const doubles = installOriginDouble();
      const hostileEnv = { ...ENV, SITE_URL: siteUrl };

      const aliasResponse = await worker.fetch(
        new Request("https://syrin.online/privacy"),
        hostileEnv,
        { waitUntil: doubles.waitUntil },
      );
      await expectFailClosedOriginResponse(aliasResponse, [marker]);
      expect(aliasResponse.headers.get("location")).toBeNull();

      const robotsResponse = await worker.fetch(
        new Request("https://note.syrin.online/robots.txt"),
        hostileEnv,
        { waitUntil: doubles.waitUntil },
      );
      await expectFailClosedOriginResponse(robotsResponse, [marker]);
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it("does not reflect URL credentials when canonicalizing a public alias", async () => {
    const doubles = installOriginDouble();
    const username = "redirect-credential-user";
    const password = "redirect-credential-secret";

    // Browser Request construction rejects URL userinfo, but the boundary
    // still treats request.url as untrusted input and must not reflect it if a
    // runtime/proxy supplies one.
    const credentialedRequest = {
      url: `https://${username}:${password}@syrin.online/privacy`,
      method: "GET",
      headers: new Headers(),
    } as unknown as Request;
    const response = await worker.fetch(credentialedRequest, ENV, {
      waitUntil: doubles.waitUntil,
    });

    const location = response.headers.get("location") ?? "";
    expect(response.status).toBe(301);
    expect(location).toBe("https://note.syrin.online/privacy");
    expect(location).not.toContain(username);
    expect(location).not.toContain(password);
    expect(doubles.originFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["syrin.online", "privacy", "/privacy"],
    ["syrin.online", "theme-init.js", "/theme-init.js"],
    [
      "syrin.online",
      "assets/index-AbCdEf12.js",
      "/assets/index-AbCdEf12.js",
    ],
    ["www.syrin.online", "privacy", "/privacy"],
    ["www.syrin.online", "theme-init.js", "/theme-init.js"],
    [
      "www.syrin.online",
      "assets/index-AbCdEf12.js",
      "/assets/index-AbCdEf12.js",
    ],
  ])(
    "does not reflect a traversed private segment through %s for %s",
    async (host, suffix, safePath) => {
      const doubles = installOriginDouble();
      const privateSegment = "private-capability-must-not-reach-redirect";

      const response = await worker.fetch(
        new Request(
          `https://${host}/${privateSegment}/%252e%252e/${suffix}?token=query-secret`,
        ),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      const location = response.headers.get("location") ?? "";
      expect(response.status).toBe(301);
      expect(location).toBe(`https://note.syrin.online${safePath}`);
      expect(location).not.toContain(privateSegment);
      expect(location).not.toContain("query-secret");
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it("passes a conditional 304 from the origin without leaking its Location", async () => {
    const doubles = installOriginDouble();
    const etag = '"version-etag"';
    const upstreamSecret = "origin-location-must-not-escape";
    doubles.originFetch.mockResolvedValueOnce(
      new Response(null, {
        status: 304,
        headers: {
          "content-type": "application/json",
          etag,
          location: `https://origin.invalid/${upstreamSecret}`,
          "cache-control": "public, max-age=300",
        },
      }),
    );

    const response = await worker.fetch(
      new Request("https://note.syrin.online/version.json", {
        headers: { "if-none-match": etag },
      }),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
    expect(originRequest.headers.get("if-none-match")).toBe(etag);
    expect(Array.from(response.headers.entries()).flat().join("\n")).not.toContain(
      upstreamSecret,
    );
  });

  it.each([
    ["privacy", "/privacy"],
    ["theme-init.js", "/theme-init.js"],
    ["assets/index-AbCdEf12.js", "/assets/index-AbCdEf12.js"],
  ])(
    "does not expose a traversed private segment to the origin for %s",
    async (suffix, safePath) => {
      const doubles = installOriginDouble();
      const privateSegment = "private-capability-must-not-reach-origin";

      await worker.fetch(
        new Request(
          `https://note.syrin.online/${privateSegment}/%252e%252e/${suffix}?token=query-secret`,
        ),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      expect(originUrl.pathname).toBe(safePath);
      expect(originUrl.search).toBe("");
      expect(originRequest.url).not.toContain(privateSegment);
      expect(originRequest.url).not.toContain("query-secret");
    },
  );

  it("does not echo a private alias path or raw client address", async () => {
    const doubles = installOriginDouble();
    const logs: string[] = [];
    const syntheticPath = "/embed/synthetic-private-capability";
    const syntheticIp = "192.0.2.44";
    vi.spyOn(console, "log").mockImplementation((line) =>
      logs.push(String(line)),
    );

    const response = await worker.fetch(
      new Request(`https://www.syrin.online${syntheticPath}`, {
        headers: {
          "cf-connecting-ip": syntheticIp,
          "user-agent": "Mozilla/5.0",
        },
      }),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
    const observable = [
      response.headers.get("location") ?? "",
      new URL(originRequest.url).pathname,
      ...logs,
    ].join("\n");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new URL(originRequest.url).pathname).toBe("/");
    expect(observable).not.toContain(syntheticPath);
    expect(observable).not.toContain("synthetic-private-capability");
    expect(observable).not.toContain(syntheticIp);
  });

  it.each([
    { path: "/synthetic-private-capability", expectedOriginPath: "/" },
    { path: "/s/synthetic-share-capability", expectedOriginPath: "/s" },
  ])(
    "strips browser credentials and identity headers before proxying $path",
    async ({ path, expectedOriginPath }) => {
      const doubles = installOriginDouble();
      const headerSecret = "header-capability-must-not-reach-origin";
      const rawIp = "198.51.100.91";
      const referer = `https://note.syrin.online/private?token=${headerSecret}`;

      const response = await worker.fetch(
        new Request(`https://note.syrin.online${path}`, {
          headers: {
            accept: "text/html",
            authorization: `Bearer ${headerSecret}`,
            cookie: `session=${headerSecret}`,
            referer,
            "x-forwarded-for": rawIp,
            "cf-connecting-ip": rawIp,
            "user-agent": "Mozilla/5.0",
          },
        }),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.status).toBe(200);
      expect(doubles.originFetch).toHaveBeenCalledOnce();
      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      const forwardedHeaders = Array.from(originRequest.headers.entries())
        .flat()
        .join("\n");

      expect(originRequest.method).toBe("GET");
      expect(originUrl.pathname).toBe(expectedOriginPath);
      expect(originUrl.search).toBe("");
      expect(originRequest.headers.get("authorization")).toBeNull();
      expect(originRequest.headers.get("cookie")).toBeNull();
      expect(originRequest.headers.get("referer")).toBeNull();
      expect(originRequest.headers.get("x-forwarded-for")).toBeNull();
      expect(originRequest.headers.get("cf-connecting-ip")).toBeNull();
      expect(forwardedHeaders).not.toContain(headerSecret);
      expect(forwardedHeaders).not.toContain(rawIp);
    },
  );

  it.each(["/synthetic-private-capability", "/s/synthetic-share-capability"])(
    "rejects a content-bearing %s request without reaching the origin",
    async (path) => {
      const doubles = installOriginDouble();
      const bodySecret = "body-capability-must-not-reach-origin";

      const response = await worker.fetch(
        new Request(`https://note.syrin.online${path}`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: bodySecret,
        }),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_ROBOTS);
      expect(await response.text()).not.toContain(bodySecret);
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://note.syrin.online/insecure-private-capability",
    "https://note.syrin.online:8443/insecure-private-capability",
  ])(
    "fails closed before proxying an insecure or non-standard client authority: %s",
    async (requestUrl) => {
      const doubles = installOriginDouble();
      const capability = "insecure-private-capability";

      const response = await worker.fetch(
        new Request(requestUrl),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe(PRIVATE_ROBOTS);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain(capability);
      expect(doubles.originFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { path: "/", expectedOriginPath: "/", kind: "home" },
    {
      path: "/synthetic-private-capability",
      expectedOriginPath: "/",
      kind: "note",
    },
    {
      path: "/s/synthetic-share-capability",
      expectedOriginPath: "/s",
      kind: "share",
    },
  ])(
    "fails closed when the origin redirects $kind traffic to canonical",
    async ({ path, expectedOriginPath, kind }) => {
      const doubles = installOriginDouble();
      const querySecret = "query-capability-must-not-escape";
      const rawIp = "192.0.2.81";
      const upstreamSecret = "upstream-location-secret";
      const logs: string[] = [];
      doubles.originFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://note.syrin.online/${upstreamSecret}`,
            "x-origin-secret": upstreamSecret,
          },
        }),
      );
      vi.spyOn(console, "log").mockImplementation((line) =>
        logs.push(String(line)),
      );

      const response = await worker.fetch(
        new Request(
          `https://note.syrin.online${path}?token=${querySecret}`,
          {
            headers: {
              "cf-connecting-ip": rawIp,
              "user-agent": "Mozilla/5.0",
            },
          },
        ),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(response, [
        querySecret,
        rawIp,
        upstreamSecret,
      ]);
      expect(doubles.originFetch).toHaveBeenCalledOnce();
      const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
      const originUrl = new URL(originRequest.url);
      expect(originRequest.redirect).toBe("manual");
      expect(originUrl.pathname).toBe(expectedOriginPath);
      expect(originUrl.search).toBe("");
      expect(logs).toHaveLength(1);
      const log = JSON.parse(logs[0]) as Record<string, unknown>;
      expect(log).toMatchObject({
        level: "error",
        msg: "origin_unavailable",
        kind,
        reason: "redirect",
        status: 302,
      });
      expect(Object.keys(log).sort()).toEqual(
        ["kind", "level", "msg", "reason", "status", "ts"].sort(),
      );
      expect(logs.join("\n")).not.toContain(querySecret);
      expect(logs.join("\n")).not.toContain(rawIp);
      expect(logs.join("\n")).not.toContain(upstreamSecret);
    },
  );

  it.each([
    { label: "missing", originHost: undefined, reason: "missing" },
    {
      label: "URL-shaped",
      originHost: "https://origin.invalid/path",
      reason: "invalid",
    },
    {
      label: "placeholder",
      originHost: "production-origin.invalid",
      reason: "invalid",
    },
    {
      label: "request self-reference",
      originHost: "note.syrin.online",
      reason: "self_reference",
    },
    {
      label: "canonical self-reference from an alias",
      originHost: "note.syrin.online",
      reason: "self_reference",
      requestHost: "www.syrin.online",
    },
    {
      label: "another public alias",
      originHost: "www.syrin.online",
      reason: "self_reference",
    },
  ])(
    "fails closed before fetch for a $label origin",
    async ({ originHost, reason, requestHost = "note.syrin.online" }) => {
      const doubles = installOriginDouble();
      const rawPathSecret = "private-origin-config-secret";
      const rawIp = "192.0.2.82";
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line) =>
        logs.push(String(line)),
      );

      const response = await worker.fetch(
        new Request(`https://${requestHost}/${rawPathSecret}?token=query-secret`, {
          headers: {
            "cf-connecting-ip": rawIp,
            "user-agent": "Mozilla/5.0",
          },
        }),
        {
          ORIGIN_HOST: originHost,
          SITE_URL: "https://note.syrin.online",
        },
        { waitUntil: doubles.waitUntil },
      );

      await expectFailClosedOriginResponse(response, [
        rawPathSecret,
        rawIp,
        "query-secret",
      ]);
      expect(doubles.originFetch).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      const log = JSON.parse(logs[0]) as Record<string, unknown>;
      expect(log).toMatchObject({
        level: "error",
        msg: "origin_unavailable",
        kind: "note",
        reason,
        status: 503,
      });
      expect(Object.keys(log).sort()).toEqual(
        ["kind", "level", "msg", "reason", "status", "ts"].sort(),
      );
      expect(logs.join("\n")).not.toContain(rawPathSecret);
      expect(logs.join("\n")).not.toContain(rawIp);
      expect(logs.join("\n")).not.toContain("query-secret");
    },
  );

  it("fails closed after one origin fetch exception", async () => {
    const doubles = installOriginDouble();
    const rawPathSecret = "private-fetch-exception-secret";
    const rawIp = "192.0.2.83";
    const logs: string[] = [];
    doubles.originFetch.mockRejectedValueOnce(
      new TypeError("fetch failed with upstream-location-secret"),
    );
    vi.spyOn(console, "log").mockImplementation((line) =>
      logs.push(String(line)),
    );

    const response = await worker.fetch(
      new Request(
        `https://note.syrin.online/${rawPathSecret}?token=query-secret`,
        {
          headers: {
            "cf-connecting-ip": rawIp,
            "user-agent": "Mozilla/5.0",
          },
        },
      ),
      ENV,
      { waitUntil: doubles.waitUntil },
    );

    await expectFailClosedOriginResponse(response, [
      rawPathSecret,
      rawIp,
      "query-secret",
      "upstream-location-secret",
    ]);
    expect(doubles.originFetch).toHaveBeenCalledOnce();
    const originRequest = doubles.originFetch.mock.calls[0]?.[0] as Request;
    expect(originRequest.redirect).toBe("manual");
    expect(new URL(originRequest.url).pathname).toBe("/");
    expect(logs).toHaveLength(1);
    const log = JSON.parse(logs[0]) as Record<string, unknown>;
    expect(log).toMatchObject({
      level: "error",
      msg: "origin_unavailable",
      kind: "note",
      reason: "fetch_error",
      status: 503,
    });
    expect(Object.keys(log).sort()).toEqual(
      ["kind", "level", "msg", "reason", "status", "ts"].sort(),
    );
    expect(logs.join("\n")).not.toContain(rawPathSecret);
    expect(logs.join("\n")).not.toContain(rawIp);
    expect(logs.join("\n")).not.toContain("upstream-location-secret");
  });

  it.each([
    { path: "/privacy", status: 200 },
    { path: "/synthetic-private-capability", status: 404 },
    { path: "/s/synthetic-share-capability", status: 500 },
  ])(
    "never forwards an upstream Location header on a non-redirect response for $path",
    async ({ path, status }) => {
      const doubles = installOriginDouble();
      const upstreamSecret = "upstream-location-must-not-escape";
      doubles.originFetch.mockResolvedValueOnce(
        new Response("origin response", {
          status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            location: `https://origin.invalid/${upstreamSecret}`,
          },
        }),
      );

      const response = await worker.fetch(
        new Request(`https://note.syrin.online${path}`),
        ENV,
        { waitUntil: doubles.waitUntil },
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain(upstreamSecret);
      expect(
        Array.from(response.headers.entries()).flat().join("\n"),
      ).not.toContain(upstreamSecret);
    },
  );
});
