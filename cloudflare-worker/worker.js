/**
 * Cloudflare Worker — containment cho URL riêng tư và prerender public shell.
 *
 * Đặt trước syrin.online. Worker phát hiện User-Agent crawler
 * (LinkedIn, Slack, Facebook, Twitter, Discord, WhatsApp, Telegram...). URL
 * note/share luôn nhận HTML generic, không cache và không index; chỉ public
 * shell được prerender metadata. Request từ trình duyệt thường được
 * pass-through tới Lovable hosting nguyên bản mà không redirect URL chứa quyền.
 *
 * Cấu hình cần (Environment Variables / Secrets trong Cloudflare):
 *   - ORIGIN_HOST        = hostname origin đã staging-prove là không redirect
 *   - SITE_URL           = "https://note.syrin.online"
 *   - EDGE_SERVE_ORIGIN  = reserved staging workers.dev authority (staging only)
 *   - STAGING_SUPABASE_ORIGIN = isolated https://<project-ref>.supabase.co
 *                               origin (required and accepted in staging only)
 *
 * Route: gắn worker vào các pattern note.syrin.online/*, syrin.online/*
 * và www.syrin.online/*. Mọi hostname share công khai phải đi qua Worker
 * trước khi request /s/* có thể tới origin.
 */

// Mở rộng UA: thêm iMessage/Apple, TikTok, Zalo, LINE, Viber, KakaoTalk,
// Snapchat, Mastodon, Bluesky, Threads, Notion, Trello, Asana, Microsoft
// Teams, Outlook/Office, Google-Read-Aloud, Google-Site-Verification,
// PetalBot, Yeti (Naver), SeznamBot, Qwantify, MojeekBot, AhrefsBot,
// SemrushBot, archive.org_bot, ia_archiver, Snapcrawler, Tumblr, Flipboard.
const CRAWLER_UA = /(facebookexternalhit|Facebot|meta-externalagent|meta-externalfetcher|Twitterbot|LinkedInBot|Slackbot|Slack-ImgProxy|Discordbot|WhatsApp|TelegramBot|Pinterest|pinterestbot|redditbot|Applebot|Googlebot|Google-Read-Aloud|Google-Site-Verification|Google-InspectionTool|bingbot|DuckDuckBot|YandexBot|Baiduspider|SkypeUriPreview|vkShare|W3C_Validator|Embedly|Iframely|nuzzel|outbrain|quora link preview|XING-contenttabreceiver|TikTokBot|Bytespider|Snapchat|SnapchatAds|Snapcrawler|Mastodon|Pleroma|Misskey|Threads|Bluesky|Notionbot|Trello|Asana|MicrosoftPreview|Teams|Outlook|Office|Zalo|LINE|Viber|KakaoTalk|iMessageLinkPreview|MetaInspector|Tumblr|Flipboard|PetalBot|Yeti|SeznamBot|Qwantify|MojeekBot|AhrefsBot|SemrushBot|archive\.org_bot|ia_archiver|YisouSpider|Sogou|360Spider|MJ12bot|DotBot|HeadlessChrome)/i;

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const WORKBOX_REVISION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RAW_NOTE_RE = /^([a-zA-Z0-9_-]{1,64})\.md$/i;
const SHARE_ROBOTS = "noindex, nofollow, noarchive, nosnippet";
const PRODUCTION_SUPABASE_ORIGIN =
  "https://onfzjmfjldsbthchssfr.supabase.co";
const PRODUCTION_SUPABASE_WS_ORIGIN =
  "wss://onfzjmfjldsbthchssfr.supabase.co";
const SECURITY_CSP_PREFIX =
  "default-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; " +
  "frame-ancestors 'self' chrome-extension://*; script-src 'self' https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://flagcdn.com " +
  "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev; font-src 'self' data:; ";
const SECURITY_CSP_SUFFIX =
  " https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; " +
  "manifest-src 'self'; upgrade-insecure-requests;";
const SECURITY_CSP = securityCsp(
  PRODUCTION_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_WS_ORIGIN,
);
const PERMISSIONS_POLICY =
  "camera=(), geolocation=(), microphone=(), payment=()";
const PRIVATE_ROUTE_KINDS = new Set(["share", "note", "private"]);
const APPROVED_CANONICAL_ORIGIN = "https://note.syrin.online";
const APPROVED_STAGING_SERVE_ORIGIN =
  "https://syrin-prerender-staging.thongdocnganhang1.workers.dev";
const SUPABASE_PROJECT_HOST_RE = /^[a-z0-9]{20}\.supabase\.co$/;
const PUBLIC_HOSTNAMES = new Set([
  "note.syrin.online",
  "syrin.online",
  "www.syrin.online",
]);
const ROOT_RUNTIME_ASSET_PATHS = new Set([
  "/favicon.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable.png",
  "/index.html",
  "/llms.txt",
  "/logo.webp",
  "/manifest.webmanifest",
  "/offline.html",
  "/offline-retry.js",
  "/placeholder.svg",
  "/registerSW.js",
  "/robots.txt",
  "/sitemap.xml",
  "/sw.js",
  "/sw-kill.js",
  "/syrin-note-sidepanel.zip",
  "/syrin-note-sidepanel.zip.manifest.json",
  "/theme-init.js",
  "/version.json",
]);
const PAGES_RUNTIME_ORIGIN_PATHS = new Map([
  ["/index.html", "/"],
  ["/offline.html", "/offline"],
]);
const PRIVATE_RESPONSE_HEADERS = [
  "content-security-policy-report-only",
  "etag",
  "last-modified",
  "nel",
  "report-to",
  "reporting-endpoints",
  "server-timing",
  "x-lovable-analytics",
  "x-lovable-trace",
];
const ORIGIN_SAFE_METHODS = new Set(["GET", "HEAD"]);
const ORIGIN_REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "if-modified-since",
  "if-none-match",
  "range",
];

// Rate limit (in-memory per-isolate). Token bucket đơn giản.
// Ghi chú: Mỗi colo/isolate giữ state riêng, không 100% chính xác toàn cầu,
// nhưng đủ chặn spike. Để chính xác hơn dùng Durable Objects / KV.
//
// Hai tầng giới hạn (đều phải pass):
//   1. Per-IP:        chặn 1 client spam.
//   2. Per-(IP,bot):  mỗi nhóm bot có hạn mức riêng cho cùng 1 IP, để 1 bot
//                     đơn lẻ không "xơi" hết quota chung và bóp các bot khác.
const RL_WINDOW_MS = 60_000;        // cửa sổ 60s
const RL_IP_MAX = 120;              // tổng / IP / 60s
const RL_BOT_DEFAULT_MAX = 30;      // mỗi (IP, bot) / 60s
const RL_BOT_MAX = {                // override theo nhóm bot
  facebook: 40, slack: 40, linkedin: 30, twitter: 30, discord: 30,
  whatsapp: 20, telegram: 20, google: 60, bing: 40, apple: 30,
  tiktok: 20, reddit: 20, pinterest: 20, yandex: 20, baidu: 20,
  zalo: 20, line: 20, viber: 20, kakao: 20, mastodon: 20,
  bluesky: 20, threads: 20, microsoft: 30, seo: 10, archive: 10,
  other: 20,
};

// Map UA → nhóm bot (thứ tự quan trọng, match đầu tiên thắng).
const BOT_GROUPS = [
  ["facebook",  /facebookexternalhit|facebot|meta-external(agent|fetcher)|metainspector/i],
  ["slack",     /slack/i],
  ["linkedin",  /linkedinbot/i],
  ["twitter",   /twitterbot/i],
  ["discord",   /discordbot/i],
  ["whatsapp",  /whatsapp/i],
  ["telegram",  /telegrambot/i],
  ["apple",     /applebot|imessagelinkpreview/i],
  ["tiktok",    /tiktokbot|bytespider/i],
  ["google",    /googlebot|google-(read-aloud|site-verification|inspectiontool)/i],
  ["bing",      /bingbot|microsoftpreview/i],
  ["microsoft", /teams|outlook|office/i],
  ["yandex",    /yandexbot/i],
  ["baidu",     /baiduspider/i],
  ["reddit",    /redditbot/i],
  ["pinterest", /pinterest/i],
  ["zalo",      /zalo/i],
  ["line",      /\bline\b/i],
  ["viber",     /viber/i],
  ["kakao",     /kakaotalk/i],
  ["mastodon",  /mastodon|pleroma|misskey/i],
  ["bluesky",   /bluesky/i],
  ["threads",   /threads/i],
  ["seo",       /ahrefsbot|semrushbot|mj12bot|dotbot|petalbot/i],
  ["archive",   /archive\.org_bot|ia_archiver/i],
];

function botGroup(ua) {
  for (const [name, re] of BOT_GROUPS) if (re.test(ua)) return name;
  return "other";
}

const rlBuckets = new Map();        // key -> { count, resetAt }

function takeBucket(key, limit) {
  const now = Date.now();
  const b = rlBuckets.get(key);
  if (!b || now >= b.resetAt) {
    rlBuckets.set(key, { count: 1, resetAt: now + RL_WINDOW_MS });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - b.count, retryAfter: 0 };
}

// Dọn map định kỳ để tránh phình bộ nhớ isolate.
function gcBuckets() {
  if (rlBuckets.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of rlBuckets) if (now >= v.resetAt) rlBuckets.delete(k);
}

function rateLimit(ip, ua) {
  gcBuckets();
  const group = botGroup(ua);
  const botMax = RL_BOT_MAX[group] ?? RL_BOT_DEFAULT_MAX;
  const ipRes  = takeBucket(`ip:${ip}`, RL_IP_MAX);
  const botRes = takeBucket(`bot:${ip}|${group}`, botMax);
  const ok = ipRes.ok && botRes.ok;
  const reason = !ipRes.ok ? "ip" : !botRes.ok ? "bot" : null;
  const retryAfter = Math.max(ipRes.retryAfter, botRes.retryAfter);
  const remaining = Math.min(ipRes.remaining, botRes.remaining);
  return { ok, remaining, retryAfter, group, reason };
}

function logEvent(env, level, msg, fields = {}) {
  // Cloudflare tự thu console.* vào Workers Logs / Logpush.
  const payload = { ts: new Date().toISOString(), level, msg, ...fields };
  try { console.log(JSON.stringify(payload)); } catch { /* ignore */ }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const authority = validateRequestAuthority(url, env);
    if (!authority.ok) {
      return originUnavailableResponse(env);
    }
    if (!isSecureStandardTransport(url)) {
      return insecureTransportResponse(env);
    }
    const servesAtRequestedAuthority = authority.kind !== "alias";
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const ua = request.headers.get("user-agent") ?? "";
    const isCrawler = CRAWLER_UA.test(ua);
    const normalizedPath = normalizeContainmentPath(url.pathname);
    const policyPath = resolveContainmentDotSegments(normalizedPath);
    const lowerPath = policyPath.toLowerCase();

    // Lovable/Flock telemetry must be denied before asset classification or
    // origin passthrough. The collection prefix is blocked as a family so a
    // versioned sub-path cannot bypass containment.
    if (lowerPath === "/~flock.js") {
      return analyticsDeniedResponse(410);
    }
    if (
      lowerPath === "/~api/analytics"
      || lowerPath.startsWith("/~api/analytics/")
    ) {
      return analyticsDeniedResponse(204);
    }

    if (url.pathname === "/robots.txt") {
      if (!servesAtRequestedAuthority) {
        return canonicalRedirect(url, env);
      }
      const body = renderRobotsTxt(env);
      const etag = etagOf(body);
      if (matchesEtag(request, etag)) {
        return new Response(null, {
          status: 304,
          headers: {
            etag,
            "cache-control": "no-cache, must-revalidate",
            vary: "User-Agent",
          },
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache, must-revalidate",
          etag,
          vary: "User-Agent",
        },
      });
    }

    // Classify capability-bearing share paths before asset passthrough or host
    // redirects. A token may legitimately look like a filename or be followed
    // by nested path data, and neither case may reach the origin.
    const route = parseRoute(url.pathname);
    if (isCrawler && route.kind === "share") {
      logEvent(env, "info", "prerender", {
        kind: "share", status: 200,
      });
      return renderGenericShareHtml(env);
    }
    // A legacy note slug is still an edit credential until the capability
    // cutover. Never read a content-bearing cache or metadata endpoint for a
    // crawler: a cached plaintext preview could survive a later lock/revoke.
    if (isCrawler && route.kind === "note") {
      logEvent(env, "info", "prerender", {
        kind: "note", status: 200,
      });
      return renderGenericNoteHtml(env);
    }
    if (isCrawler && route.kind === "private") {
      logEvent(env, "info", "prerender", {
        kind: "private", status: 200,
      });
      return renderGenericPrivateHtml(
        "Private route - Syrin Notes",
        "Open a private Syrin Notes route in your browser.",
        env,
      );
    }

    if (
      route.kind === "immutable-asset"
      || route.kind === "runtime-asset"
      || route.kind === "public"
      || !isCrawler
    ) {
      // Legacy note locators and share paths are credentials until cutover.
      // Passing them through avoids copying the raw path into Location and
      // another round of proxy/browser logs. Public routes may still redirect.
      if (!PRIVATE_ROUTE_KINDS.has(route.kind) && !servesAtRequestedAuthority) {
        return canonicalRedirect(url, env);
      }
      return passThrough(request, env, route.kind);
    }

    // Rate limit chỉ áp dụng cho nhánh crawler (đã rẽ vào prerender).
    const rl = rateLimit(ip, ua);
    if (!rl.ok) {
      logEvent(env, "warn", "rate_limited", {
        group: rl.group, scope: rl.reason,
        retryAfter: rl.retryAfter,
      });
      return new Response("Too Many Requests", {
        status: 429,
        headers: {
          "retry-after": String(rl.retryAfter),
          "cache-control": "no-store",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-scope": rl.reason ?? "",
          "x-bot-group": rl.group,
        },
      });
    }

    // Canonicalize only after every credential-bearing route has been
    // contained. A redirect would echo that credential in Location.
    if (!servesAtRequestedAuthority) {
      return canonicalRedirect(url, env);
    }

    // Chuẩn hoá pathname (strip trailing slash, lowercase host đã xong)
    if (normalizedPath !== url.pathname) {
      const redir = new URL(url);
      redir.pathname = normalizedPath;
      redir.search = "";
      redir.hash = "";
      return Response.redirect(redir.toString(), 301);
    }

    // Edge cache for the query-free public home document.
    const cache = caches.default;
    // Only the public home document is eligible for this crawler cache. Never
    // retain an arbitrary query because it can contain a legacy locator or
    // capability even though the rendered home shell is query-independent.
    const cacheUrl = new URL(url);
    cacheUrl.search = "";
    cacheUrl.hash = "";
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) {
      logEvent(env, "info", "cache_hit", { kind: route.kind, group: rl.group });
      const cachedHeaders = new Headers(cached.headers);
      applyHtmlSecurityHeaders(cachedHeaders, env);
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cachedHeaders,
      });
    }

    const t0 = Date.now();
    try {
      const meta = await fetchNoteMeta(route, env);
      const html = renderHtml(meta, url, env);
      const isEncrypted = meta.kind !== "home" && meta.found && meta.isEncrypted;
      const cacheControl = isEncrypted
        ? "public, max-age=60, s-maxage=60, must-revalidate"
        : meta.found
          ? "public, max-age=300, s-maxage=300, stale-while-revalidate=3600, must-revalidate"
          : "public, max-age=60, s-maxage=60, must-revalidate";

      const status = meta.kind === "home" || meta.found ? 200 : 404;
      const etag = etagOf(html);

      // Conditional GET: trả 304 nếu client/scraper đã có bản cũ còn hợp lệ
      if (status === 200 && matchesEtag(request, etag)) {
        const headers = new Headers({
          etag,
          "cache-control": cacheControl,
          "x-prerendered": "1",
          "x-robots-tag": isEncrypted ? "noindex, nofollow" : "index, follow",
          vary: "User-Agent",
        });
        applyHtmlSecurityHeaders(headers, env);
        return new Response(null, {
          status: 304,
          headers,
        });
      }

      const responseHeaders = new Headers({
        "content-type": "text/html; charset=utf-8",
        "cache-control": cacheControl,
        etag,
        "x-prerendered": "1",
        "x-robots-tag": isEncrypted ? "noindex, nofollow" : "index, follow",
        "x-ratelimit-remaining": String(rl.remaining),
        vary: "User-Agent",
      });
      applyHtmlSecurityHeaders(responseHeaders, env);
      const response = new Response(html, {
        status,
        headers: responseHeaders,
      });

      logEvent(env, "info", "prerender", {
        kind: route.kind, group: rl.group,
        status, found: !!meta.found, encrypted: !!isEncrypted,
        ms: Date.now() - t0,
      });

      // Lưu cache nền (chỉ cache 200)
      if (response.status === 200) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    } catch (err) {
      logEvent(env, "error", "prerender_failed", {
        kind: route.kind,
        errorName: err instanceof Error ? err.name : "unknown",
        ms: Date.now() - t0,
      });
      return passThrough(request, env, route.kind);
    }
  },
};

function isImmutableAssetPath(pathname) {
  return /^\/assets\/(?:.+\/)?[^/]+-[a-zA-Z0-9_-]{8,}\.(css|js|mjs|json|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)$/i.test(
    pathname,
  );
}

function isRuntimeAssetPath(pathname) {
  if (ROOT_RUNTIME_ASSET_PATHS.has(pathname)) return true;
  if (/^\/sw-identity-[a-f0-9]{16}\.js$/.test(pathname)) return true;
  if (/^\/workbox-[a-zA-Z0-9_-]{8,}\.js$/i.test(pathname)) return true;
  return /^\/assets\/.+\.(css|js|mjs|json|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)$/i.test(pathname);
}

function normalizePath(p) {
  if (!p || p === "/") return "/";
  // Decode + bỏ trailing slash + gộp slash kép
  let v = p.replace(/\/{2,}/g, "/");
  if (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  return v;
}

function parseRoute(pathname) {
  pathname = normalizeContainmentPath(pathname);
  if (traversesShareRoute(pathname)) {
    // Containment is deliberately independent of the legacy token regex.
    // Once resolution reaches `/s/<token>`, later traversal cannot erase the
    // sensitivity of the raw path or let it reach redirects, caches, or logs.
    return { kind: "share" };
  }
  if (pathname === "/" || pathname === "") return { kind: "home" };
  pathname = resolveContainmentDotSegments(pathname);
  if (pathname === "/" || pathname === "") return { kind: "home" };
  // `/privacy` is an explicit public SPA route, not a legacy note locator.
  // Keep it crawlable and outside the no-store/noindex credential boundary.
  if (pathname.toLowerCase() === "/privacy") return { kind: "public" };
  if (isImmutableAssetPath(pathname)) return { kind: "immutable-asset" };
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length === 1) {
    let slug = parts[0];
    try { slug = decodeURIComponent(slug); } catch { /* ignore */ }
    if (SLUG_RE.test(slug)) return { kind: "note", slug };
    const rawNote = slug.match(RAW_NOTE_RE);
    if (rawNote) return { kind: "note", slug: rawNote[1] };
  }
  if (isRuntimeAssetPath(pathname)) return { kind: "runtime-asset" };
  // The app is an SPA: any non-public, non-asset path can resolve to HTML.
  // Defaulting to private prevents a newly added route from silently becoming
  // cacheable or indexable before its security classification is reviewed.
  return { kind: "private" };
}

function normalizeContainmentPath(pathname) {
  let value = pathname || "/";

  // Decode a bounded number of mixed encodings, then collapse arbitrarily
  // repeated standard encodings of path separators. This normalization is
  // only for security classification; the raw path is never logged or echoed.
  for (let pass = 0; pass < 8; pass += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      break;
    }
    if (decoded === value) break;
    value = decoded;
  }
  value = value.replace(/%(?:25)*(?:2f|5c)/gi, "/");
  value = value.replace(/%(?:25)*2e/gi, ".");
  value = value.replace(/\\/g, "/");
  return normalizePath(value);
}

function traversesShareRoute(pathname) {
  const segments = [];
  for (const segment of pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
    if (segments.length >= 2 && isSharePrefix(segments[0])) return true;
  }
  return false;
}

function resolveContainmentDotSegments(pathname) {
  const segments = [];
  for (const segment of pathname.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function originSearchFromRequestUrl(requestUrl) {
  const revision = requestUrl.searchParams.get("__WB_REVISION__");
  if (!revision || !WORKBOX_REVISION_RE.test(revision)) return "";
  return `?__WB_REVISION__=${revision}`;
}

function isSharePrefix(value) {
  // Match s/S plus any number of standard re-encodings of %73/%53, e.g.
  // %73, %2573, %252573. This stays linear for hostile input.
  return value.toLowerCase() === "s" || /^%(?:25)*(?:53|73)$/i.test(value);
}

async function fetchNoteMeta(route) {
  if (route.kind === "home") return { found: true, kind: "home" };
  throw new TypeError("private metadata lookup is disabled");
}

async function passThrough(
  request,
  env,
  routeKind = "public",
) {
  const url = new URL(request.url);
  const privateRoute = PRIVATE_ROUTE_KINDS.has(routeKind);
  if (!ORIGIN_SAFE_METHODS.has(request.method)) {
    return methodNotAllowedResponse(env);
  }
  const origin = validateOriginHost(url, env);
  if (!origin.ok) {
    logEvent(env, "error", "origin_unavailable", {
      kind: routeKind,
      reason: origin.reason,
      status: 503,
    });
    return originUnavailableResponse(env);
  }
  // The client-facing request authority is not an origin configuration
  // input. Pin every authority component so a non-standard Cloudflare port
  // or an HTTP request cannot select a different service on the trusted host.
  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.hostname = origin.hostname;
  url.port = "";
  if (routeKind === "share") {
    // The SPA migrates the legacy token into the URL fragment before routing.
    // Fragments never reach this worker, so the origin only needs the generic
    // compatibility shell and must not receive the raw credential path/query.
    url.pathname = "/s";
    url.search = "";
  } else if (privateRoute) {
    // A legacy slug or private SPA path may carry authority. The root document
    // is the same SPA shell, while the outer browser URL remains unchanged for
    // BrowserRouter and no raw private path reaches origin logs.
    url.pathname = "/";
    url.search = "";
  } else if (routeKind === "home" || routeKind === "public") {
    // Public document queries are needed by the SPA in the browser, not by the
    // origin that serves the same shell. Resolve encoded traversal as well so
    // a private raw prefix cannot enter provider request logs.
    url.pathname = resolveContainmentDotSegments(
      normalizeContainmentPath(url.pathname),
    );
    url.search = "";
  } else if (
    routeKind === "immutable-asset"
    || routeKind === "runtime-asset"
  ) {
    // Only the normalized allowlisted asset path is sent upstream. Forward a
    // conservative Workbox revision query so Pages can cache-bust HTML shells;
    // drop every other param so locators/capabilities never enter origin logs.
    const runtimePath = resolveContainmentDotSegments(
      normalizeContainmentPath(url.pathname),
    );
    // Cloudflare Pages canonicalizes these reviewed HTML filenames with a 308.
    // Fetch their exact non-redirecting aliases so Workbox revision URLs remain
    // available while arbitrary origin redirects still fail closed below.
    url.pathname = PAGES_RUNTIME_ORIGIN_PATHS.get(runtimePath) ?? runtimePath;
    url.search = originSearchFromRequestUrl(url);
  }
  let originRequest;
  let response;
  try {
    originRequest = sanitizedOriginRequest(url, request);
    response = await fetch(originRequest);
  } catch {
    logEvent(env, "error", "origin_unavailable", {
      kind: routeKind,
      reason: "fetch_error",
      status: 503,
    });
    return originUnavailableResponse(env);
  }
  // 304 is a successful conditional-response status, not a redirect. The
  // request allowlist intentionally forwards validators so public/runtime
  // assets can revalidate without turning a cache hit into an outage.
  if (
    response.status !== 304
    && response.status >= 300
    && response.status < 400
  ) {
    logEvent(env, "error", "origin_unavailable", {
      kind: routeKind,
      reason: "redirect",
      status: response.status,
    });
    return originUnavailableResponse(env);
  }
  const headers = new Headers(response.headers);
  // An origin may emit Location on an otherwise non-redirect response. The
  // outer boundary must never reflect an upstream URL because it can contain
  // a legacy locator or capability even when the status is not 3xx.
  headers.delete("location");
  const isHtml =
    privateRoute
    || (headers.get("content-type") || "").toLowerCase().includes("text/html");

  if (routeKind === "immutable-asset") {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (routeKind === "runtime-asset") {
    headers.set("cache-control", "no-cache, no-store, must-revalidate");
    headers.set("cdn-cache-control", "no-store");
  }
  if (isHtml) applyHtmlSecurityHeaders(headers, env);
  if (privateRoute) applyPrivateResponseHeaders(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sanitizedOriginRequest(url, request) {
  const headers = new Headers();
  for (const name of ORIGIN_REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(url.toString(), {
    method: request.method,
    headers,
    redirect: "manual",
  });
}

function validateOriginHost(requestUrl, env) {
  const raw = env?.ORIGIN_HOST;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (raw !== raw.trim() || raw.includes("://")) {
    return { ok: false, reason: "invalid" };
  }

  let originUrl;
  try {
    originUrl = new URL(`https://${raw}/`);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const hostname = originUrl.hostname.toLowerCase();
  if (
    originUrl.username
    || originUrl.password
    || originUrl.port
    || originUrl.pathname !== "/"
    || originUrl.search
    || originUrl.hash
    || hostname !== raw.toLowerCase()
    || hostname.endsWith(".invalid")
  ) {
    return { ok: false, reason: "invalid" };
  }

  const siteUrl = canonicalSiteUrl(env);
  if (!siteUrl) {
    return { ok: false, reason: "invalid" };
  }
  const edgeServeOrigin = configuredEdgeServeOrigin(env);
  if (!edgeServeOrigin.ok) {
    return { ok: false, reason: "invalid" };
  }
  const comparableHostname = dnsComparisonHostname(hostname);
  const canonicalHostname = dnsComparisonHostname(siteUrl.hostname);
  const requestHostname = dnsComparisonHostname(requestUrl.hostname);
  const edgeServeHostname = edgeServeOrigin.url
    ? dnsComparisonHostname(edgeServeOrigin.url.hostname)
    : null;
  if (
    comparableHostname === requestHostname
    || comparableHostname === canonicalHostname
    || comparableHostname === edgeServeHostname
    || PUBLIC_HOSTNAMES.has(comparableHostname)
  ) {
    return { ok: false, reason: "self_reference" };
  }
  return { ok: true, hostname };
}

function originUnavailableResponse(env) {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
  });
  applyHtmlSecurityHeaders(headers, env);
  applyPrivateResponseHeaders(headers);
  return new Response("Service temporarily unavailable", {
    status: 503,
    headers,
  });
}

function isSecureStandardTransport(url) {
  return url.protocol === "https:" && url.port === "";
}

function insecureTransportResponse(env) {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
  });
  applyHtmlSecurityHeaders(headers, env);
  applyPrivateResponseHeaders(headers);
  return new Response("Secure canonical request required", {
    status: 400,
    headers,
  });
}

function methodNotAllowedResponse(env) {
  const headers = new Headers({
    allow: "GET, HEAD",
    "content-type": "text/plain; charset=utf-8",
  });
  applyHtmlSecurityHeaders(headers, env);
  applyPrivateResponseHeaders(headers);
  return new Response("Method not allowed", {
    status: 405,
    headers,
  });
}

function securityCsp(httpOrigin, websocketOrigin) {
  const supabaseSources = httpOrigin && websocketOrigin
    ? ` ${httpOrigin} ${websocketOrigin}`
    : "";
  return `${SECURITY_CSP_PREFIX}connect-src 'self'${supabaseSources}${SECURITY_CSP_SUFFIX}`;
}

function securityCspForEnv(env) {
  const origins = configuredSupabaseConnectOrigins(env);
  return origins.ok
    ? securityCsp(origins.httpOrigin, origins.websocketOrigin)
    : securityCsp(null, null);
}

function applyHtmlSecurityHeaders(headers, env) {
  headers.set("content-security-policy", securityCspForEnv(env));
  headers.set("permissions-policy", PERMISSIONS_POLICY);
  // The extension/embed contract is expressed by CSP frame-ancestors.
  headers.delete("x-frame-options");
}

function applyPrivateResponseHeaders(headers) {
  headers.set("cache-control", "private, no-store");
  headers.set("cdn-cache-control", "no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("x-robots-tag", SHARE_ROBOTS);
  headers.set("referrer-policy", "no-referrer");
  for (const name of PRIVATE_RESPONSE_HEADERS) headers.delete(name);
}

function analyticsDeniedResponse(status) {
  return new Response(status === 204 ? null : "Gone", {
    status,
    headers: {
      "cache-control": "no-store",
      "cdn-cache-control": "no-store",
      "cloudflare-cdn-cache-control": "no-store",
      pragma: "no-cache",
      expires: "0",
      "x-robots-tag": SHARE_ROBOTS,
      "referrer-policy": "no-referrer",
    },
  });
}

function canonicalSiteUrl(env) {
  const raw = env?.SITE_URL ?? APPROVED_CANONICAL_ORIGIN;
  if (typeof raw !== "string" || raw !== raw.trim()) return null;

  let siteUrl;
  try {
    siteUrl = new URL(raw);
  } catch {
    return null;
  }

  if (
    siteUrl.protocol !== "https:"
    || siteUrl.hostname.toLowerCase() !== "note.syrin.online"
    || siteUrl.port
    || siteUrl.username
    || siteUrl.password
    || siteUrl.pathname !== "/"
    || siteUrl.search
    || siteUrl.hash
  ) {
    return null;
  }

  return siteUrl;
}

function configuredEdgeServeOrigin(env) {
  const raw = env?.EDGE_SERVE_ORIGIN;
  if (typeof raw === "undefined") {
    return { ok: true, url: null };
  }
  if (typeof raw !== "string" || raw !== raw.trim()) {
    return { ok: false, url: null };
  }

  let edgeServeUrl;
  try {
    edgeServeUrl = new URL(raw);
  } catch {
    return { ok: false, url: null };
  }

  if (
    raw !== APPROVED_STAGING_SERVE_ORIGIN
    || edgeServeUrl.protocol !== "https:"
    || edgeServeUrl.username
    || edgeServeUrl.password
    || edgeServeUrl.port
    || edgeServeUrl.pathname !== "/"
    || edgeServeUrl.search
    || edgeServeUrl.hash
  ) {
    return { ok: false, url: null };
  }

  return { ok: true, url: edgeServeUrl };
}

function configuredSupabaseConnectOrigins(
  env,
  edgeServeOrigin = configuredEdgeServeOrigin(env),
) {
  if (!edgeServeOrigin.ok) return { ok: false };

  const raw = env?.STAGING_SUPABASE_ORIGIN;
  if (!edgeServeOrigin.url) {
    if (typeof raw !== "undefined") return { ok: false };
    return {
      ok: true,
      httpOrigin: PRODUCTION_SUPABASE_ORIGIN,
      websocketOrigin: PRODUCTION_SUPABASE_WS_ORIGIN,
    };
  }

  if (typeof raw !== "string" || raw !== raw.trim()) {
    return { ok: false };
  }

  let origin;
  try {
    origin = new URL(raw);
  } catch {
    return { ok: false };
  }
  const hostname = origin.hostname.toLowerCase();
  if (
    origin.protocol !== "https:"
    || origin.origin !== raw
    || origin.username
    || origin.password
    || origin.port
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || !SUPABASE_PROJECT_HOST_RE.test(hostname)
    || origin.origin === PRODUCTION_SUPABASE_ORIGIN
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    httpOrigin: origin.origin,
    websocketOrigin: `wss://${hostname}`,
  };
}

function dnsComparisonHostname(hostname) {
  const lowered = hostname.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function validateRequestAuthority(url, env) {
  const siteUrl = canonicalSiteUrl(env);
  if (!siteUrl) return { ok: false, reason: "invalid" };

  const edgeServeOrigin = configuredEdgeServeOrigin(env);
  if (!edgeServeOrigin.ok) {
    return { ok: false, reason: "invalid" };
  }
  if (!configuredSupabaseConnectOrigins(env, edgeServeOrigin).ok) {
    return { ok: false, reason: "invalid" };
  }

  if (edgeServeOrigin.url) {
    if (
      !url.username
      && !url.password
      && url.origin === edgeServeOrigin.url.origin
    ) {
      return { ok: true, kind: "edge_serve" };
    }
    return { ok: false, reason: "unknown_authority" };
  }

  const requestHostname = url.hostname.toLowerCase();
  if (requestHostname === siteUrl.hostname.toLowerCase()) {
    return { ok: true, kind: "canonical" };
  }
  if (PUBLIC_HOSTNAMES.has(requestHostname)) {
    return { ok: true, kind: "alias" };
  }
  return { ok: false, reason: "unknown_authority" };
}

function canonicalRedirect(url, env) {
  const siteUrl = canonicalSiteUrl(env);
  if (!siteUrl) return originUnavailableResponse(env);
  const target = new URL(url);
  target.protocol = "https:";
  target.username = "";
  target.password = "";
  target.hostname = siteUrl.hostname;
  target.port = "";
  // Only explicitly public routes reach this function. Emit the same resolved
  // path used for classification so encoded traversal cannot reflect a private
  // raw prefix into Location, browser history, or downstream proxy logs.
  target.pathname = resolveContainmentDotSegments(
    normalizeContainmentPath(url.pathname),
  );
  target.search = "";
  return Response.redirect(target.toString(), 301);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(meta, url, env) {
  const site = canonicalSiteUrl(env)?.origin ?? APPROVED_CANONICAL_ORIGIN;
  const canonical = `${site}${url.pathname}`;

  let title = "Syrin Notes — Markdown notes, realtime";
  let desc = "Markdown notes với realtime sync, mã hoá đầu cuối tuỳ chọn, không cần đăng ký.";
  let robots = "index, follow";
  let ogType = "website";

  if (meta.kind === "note") {
    if (meta.found) {
      title = `Syrin Notes — /${meta.slug}`;
      ogType = "article";
      if (meta.isEncrypted) {
        desc = `Note "${meta.slug}" được mã hoá đầu cuối trên Syrin Notes. Cần khoá để mở.`;
        // Note mã hoá: chặn mọi index/cache/snippet/archive
        robots = "noindex, nofollow, noarchive, nosnippet, noimageindex, nocache";
      } else if (meta.snippet) {
        desc = meta.snippet;
      } else {
        desc = `Note "${meta.slug}" trên Syrin Notes — markdown realtime, tự động lưu.`;
      }
    } else {
      title = "Note không tồn tại — Syrin Notes";
      desc = "Không tìm thấy note này.";
      robots = "noindex, nofollow";
    }
  }

  const T = escapeHtml(title);
  const D = escapeHtml(desc);
  const U = escapeHtml(canonical);
  const R = escapeHtml(robots);

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${T}</title>
<meta name="description" content="${D}" />
<meta name="robots" content="${R}" />
<meta name="googlebot" content="${R}" />
<link rel="canonical" href="${U}" />
<meta property="og:title" content="${T}" />
<meta property="og:description" content="${D}" />
<meta property="og:url" content="${U}" />
<meta property="og:type" content="${escapeHtml(ogType)}" />
<meta property="og:site_name" content="Syrin Notes" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${T}" />
<meta name="twitter:description" content="${D}" />
</head>
<body>
<h1>${T}</h1>
<p>${D}</p>
<p><a href="${U}">Mở trên Syrin Notes</a></p>
</body>
</html>`;
}

function renderGenericShareHtml(env) {
  return renderGenericPrivateHtml(
    "Shared note — Syrin Notes",
    "Open a private, revocable shared note on Syrin Notes.",
    env,
  );
}

function renderGenericNoteHtml(env) {
  return renderGenericPrivateHtml(
    "Private note — Syrin Notes",
    "Open a private note on Syrin Notes.",
    env,
  );
}

function renderGenericPrivateHtml(title, description, env) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${title}</title>
<meta name="description" content="${description}" />
<meta name="robots" content="${SHARE_ROBOTS}" />
<meta name="googlebot" content="${SHARE_ROBOTS}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Syrin Notes" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
</head>
<body>
<h1>${title}</h1>
<p>${description}</p>
<p><a href="/">Open Syrin Notes</a></p>
</body>
</html>`;

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    vary: "User-Agent",
  });
  applyHtmlSecurityHeaders(headers, env);
  applyPrivateResponseHeaders(headers);

  return new Response(html, {
    status: 200,
    headers,
  });
}

function renderRobotsTxt(env) {
  const siteUrl = canonicalSiteUrl(env)?.origin ?? APPROVED_CANONICAL_ORIGIN;
  return `User-agent: *
Allow: /$
Allow: /privacy$
Allow: /assets/
Disallow: /

Sitemap: ${siteUrl}/sitemap.xml
`;
}

// FNV-1a 32-bit → ETag yếu, đủ để so sánh body.
function etagOf(input) {
  const s = typeof input === "string" ? input : String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `W/"${h.toString(16)}-${s.length.toString(16)}"`;
}

function matchesEtag(request, etag) {
  const inm = request.headers.get("if-none-match");
  if (!inm) return false;
  // Hỗ trợ list comma-separated và '*'
  if (inm.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return inm.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "");
    return v === bare;
  });
}
