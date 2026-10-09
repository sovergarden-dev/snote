import type { AddressInfo } from "node:net";
import { createNodeHubServer } from "../src/lib/realtime/hub/node-adapter";
import { decodeBase64Url, encodeBase64Url } from "../src/lib/realtime/protocol";
import { createTestSigningKeys, TEST_HUB_ID } from "../src/lib/realtime/hub/__tests__/test-crypto";
import { createServer as createViteServer } from "vite";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number; stop(closeActiveConnections?: boolean): void };
  spawn(
    command: string[],
    options: { cwd: string; env: Record<string, string>; stdout: "inherit"; stderr: "inherit" },
  ): { exited: Promise<number> };
};

const APP_URL = "http://127.0.0.1:8093";
const FAKE_ACCESS_TOKEN = "fake-local-auth-token-not-a-credential";
const encoder = new TextEncoder();
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-snote-auth, apikey",
  "cache-control": "no-store",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function roomIdForSlug(slug: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", encoder.encode(`syrin:pr182:e2e:${slug}`))
    .then((digest) => `room_${encodeBase64Url(new Uint8Array(digest)).slice(0, 32)}`);
}

async function startLocalEdge(keys: Awaited<ReturnType<typeof createTestSigningKeys>>) {
  const writeMacKey = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const emptySnapshot = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      if (url.pathname === "/auth/v1/user" && request.method === "GET") {
        return json({ id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated" });
      }
      if (url.pathname.startsWith("/auth/v1/") && request.method === "POST") {
        const now = Math.floor(Date.now() / 1_000);
        return json({
          access_token: FAKE_ACCESS_TOKEN,
          token_type: "bearer",
          expires_in: 3_600,
          expires_at: now + 3_600,
          refresh_token: "fake-local-refresh-token-not-a-credential",
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            aud: "authenticated",
            role: "authenticated",
            app_metadata: { provider: "anonymous", providers: ["anonymous"] },
            user_metadata: {},
            created_at: new Date().toISOString(),
          },
        });
      }
      if (url.pathname !== "/functions/v1/legacy-note-open" && url.pathname !== "/functions/v1/note-session") {
        return json({ error: "not_found" }, 404);
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await request.json();
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: "invalid_json" }, 400);
        body = parsed as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      if (url.pathname === "/functions/v1/legacy-note-open") {
        const slug = typeof body.slug === "string" ? body.slug : "";
        if (!/^[a-z0-9-]{8,60}$/.test(slug)) return json({ error: "invalid_slug" }, 400);
        if (body.action === "exists") return json({ exists: true });
        if (body.action !== "open") return json({ error: "invalid_action" }, 400);
        return json({
          exists: true,
          note: {
            slug,
            content: `# Local sync test\n\nIsolated PR #182 note fixture. ${slug}`,
            ydocState: "",
            isEncrypted: false,
            salt: null,
            check: null,
            iterations: null,
          },
        });
      }

      const slug = typeof body.slug === "string" ? body.slug : "";
      if (!/^[a-z0-9-]{8,60}$/.test(slug)) return json({ error: "invalid_slug" }, 400);
      if (request.headers.get("x-snote-auth") !== FAKE_ACCESS_TOKEN) {
        return json({ error: "missing_fake_local_auth" }, 401);
      }
      const roomId = await roomIdForSlug(slug);

      if (body.action === "realtime-ticket") {
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
        const now = Math.floor(Date.now() / 1_000);
        const ticket = await keys.signTicket({
          aud: TEST_HUB_ID,
          hub_id: TEST_HUB_ID,
          room_id: roomId,
          session_id: sessionId,
          generation: 1,
          assignment_epoch: 1,
          permission_epoch: 1,
          permission: "edit",
          permissions: ["read", "write"],
          iat: now,
          exp: now + 300,
        });
        return json({
          ticket,
          roomId,
          write_mac_key: writeMacKey,
          noteId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
          generation: 1,
          permissionEpoch: 1,
          ydocState: emptySnapshot,
        });
      }

      if (body.action === "realtime-cas-save") {
        const generation = Number(body.generation);
        const permissionEpoch = Number(body.permissionEpoch);
        const revision = Number(body.expectedRevision) + 1;
        const stateVectorText = typeof body.stateVector === "string" ? body.stateVector : "";
        if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(permissionEpoch) || !Number.isSafeInteger(revision)) {
          return json({ error: "invalid_cas_metadata" }, 400);
        }
        let stateVectorHash: string;
        try {
          const stateVector = decodeBase64Url(stateVectorText);
          const digest = await crypto.subtle.digest("SHA-256", stateVector as BufferSource);
          stateVectorHash = encodeBase64Url(new Uint8Array(digest));
        } catch {
          return json({ error: "invalid_state_vector" }, 400);
        }
        const savedAck = await keys.signSavedAck({
          room_id: roomId,
          generation,
          revision,
          permission_epoch: permissionEpoch,
          state_vector: stateVectorText,
          state_vector_hash: stateVectorHash,
        });
        return json({ status: "ok", savedAck, roomId, generation, revision });
      }
      return json({ error: "invalid_action" }, 400);
    },
  });
  return server;
}

async function main(): Promise<number> {
  const keys = await createTestSigningKeys();
  const replayed = new Set<string>();
  const hub = createNodeHubServer({
    config: { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys },
    replayStore: {
      async consumeJti(jti, expiresAtSeconds, nowSeconds) {
        if (expiresAtSeconds <= nowSeconds || replayed.has(jti)) return false;
        replayed.add(jti);
        return true;
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    hub.once("error", reject);
    hub.listen(0, "127.0.0.1", resolve);
  });
  const hubAddress = hub.address();
  if (!hubAddress || typeof hubAddress === "string") throw new Error("Local hub did not bind a TCP port");
  const hubUrl = `ws://127.0.0.1:${(hubAddress as AddressInfo).port}`;
  const edge = await startLocalEdge(keys);
  const edgeUrl = `http://127.0.0.1:${edge.port}`;

  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined) as [string, string][],
  );
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_SUPABASE_")) delete env[key];
  }
  Object.assign(env, {
    VITE_SUPABASE_URL: edgeUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: "fake-invalid-local-publishable-key",
    VITE_SUPABASE_PROJECT_ID: "fake-invalid-local-project-id",
    VITE_TURNSTILE_SITE_KEY: "",
    VITE_CAPABILITY_AUTH_ENABLED: "true",
    VITE_CAPABILITY_ROUTES_ENABLED: "true",
    VITE_REALTIME_HUB_SYNC_ENABLED: "true",
    VITE_REALTIME_HUB_ID: TEST_HUB_ID,
    VITE_REALTIME_HUB_URL: hubUrl,
    VITE_REALTIME_TICKET_PUBLIC_KEYS_JSON: JSON.stringify({ "test-ticket-probe": keys.ticketPublicKeyBase64Url }),
    VITE_REALTIME_SAVED_ACK_PUBLIC_KEYS_JSON: JSON.stringify({ "test-saved-ack": keys.savedAckPublicKeyBase64Url }),
    PLAYWRIGHT_BASE_URL: APP_URL,
  });

  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VITE_SUPABASE_")) delete process.env[key];
    }
    Object.assign(process.env, env);
    vite = await createViteServer({
      server: { host: "127.0.0.1", port: 8093, strictPort: true },
    });
    await vite.listen();
    const playwright = Bun.spawn([
      "bunx", "playwright", "test", "--config=playwright.realtime.config.ts", "--project=chromium",
    ], { cwd: process.cwd(), env, stdout: "inherit", stderr: "inherit" });
    return await playwright.exited;
  } finally {
    await vite?.close();
    edge.stop(true);
    await hub.drain();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
