import type { AddressInfo } from "node:net";
import * as Y from "yjs";
import { createNodeHubServer } from "../src/lib/realtime/hub/node-adapter";
import { decodeBase64Url, encodeBase64Url } from "../src/lib/realtime/protocol";
import { createTestSigningKeys, TEST_HUB_ID } from "../src/lib/realtime/hub/__tests__/test-crypto";
import { base64ToBytes, bytesToBase64 } from "../src/lib/yjs/base64";
import {
  computeCasExpectedMac,
  deriveRelayKey,
  deriveWriteMacKey,
} from "../supabase/functions/_shared/realtime-edge";
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

type FakeNoteState = {
  snapshot: Uint8Array;
  revision: number;
  casAttempts: number;
  casCommits: number;
  casAccepted: number;
  casConflicts: number;
  expectedRevisions: number[];
  firstPairReady: Promise<void>;
  releaseFirstPair: () => void;
};

function createFakeNoteState(): FakeNoteState {
  let releaseFirstPair!: () => void;
  const firstPairReady = new Promise<void>((resolve) => { releaseFirstPair = resolve; });
  return {
    snapshot: new Uint8Array(),
    revision: 1,
    casAttempts: 0,
    casCommits: 0,
    casAccepted: 0,
    casConflicts: 0,
    expectedRevisions: [],
    firstPairReady,
    releaseFirstPair,
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function noteContent(snapshot: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    if (snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
    return doc.getText("content").toString();
  } finally {
    doc.destroy();
  }
}

async function startLocalEdge(keys: Awaited<ReturnType<typeof createTestSigningKeys>>) {
  const writeMacMasterKey = crypto.getRandomValues(new Uint8Array(32));
  const relayMasterKey = crypto.getRandomValues(new Uint8Array(32));
  const notes = new Map<string, FakeNoteState>();
  const noteForSlug = (slug: string) => {
    let note = notes.get(slug);
    if (!note) {
      note = createFakeNoteState();
      notes.set(slug, note);
    }
    return note;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      if (request.method === "GET" && url.pathname.startsWith("/_test/notes/")) {
        const slug = decodeURIComponent(url.pathname.slice("/_test/notes/".length));
        if (!/^[a-z0-9-]{8,60}$/.test(slug)) return json({ error: "invalid_slug" }, 400);
        const note = noteForSlug(slug);
        return json({
          revision: note.revision,
          casAttempts: note.casAttempts,
          casCommits: note.casCommits,
          casAccepted: note.casAccepted,
          casConflicts: note.casConflicts,
          expectedRevisions: note.expectedRevisions,
          content: noteContent(note.snapshot),
        });
      }
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
      const note = noteForSlug(slug);

      if (body.action === "realtime-ticket") {
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
        const now = Math.floor(Date.now() / 1_000);
        const relayKey = await deriveRelayKey(relayMasterKey, roomId, 1);
        const writeMacKey = await deriveWriteMacKey(writeMacMasterKey, roomId, 1);
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
          relay_key_kid: "e2e-relay-v1",
          iat: now,
          exp: now + 300,
        });
        return json({
          ticket,
          roomId,
          write_mac_key: encodeBase64Url(writeMacKey),
          relay_key: encodeBase64Url(relayKey),
          relay_key_kid: "e2e-relay-v1",
          noteId: "00000000-0000-4000-8000-000000000001",
          revision: note.revision,
          generation: 1,
          permissionEpoch: 1,
          ydocState: bytesToBase64(note.snapshot),
        });
      }

      if (body.action === "realtime-cas-save") {
        const generation = Number(body.generation);
        const permissionEpoch = Number(body.permissionEpoch);
        const expectedRevision = Number(body.expectedRevision);
        const revision = expectedRevision + 1;
        const snapshotText = typeof body.ydocState === "string" ? body.ydocState : "";
        const stateVectorText = typeof body.stateVector === "string" ? body.stateVector : "";
        const macText = typeof body.mac === "string" ? body.mac : "";
        if (!Number.isSafeInteger(generation) || generation < 1
          || !Number.isSafeInteger(permissionEpoch) || permissionEpoch < 0
          || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
          || !Number.isSafeInteger(revision) || snapshotText.length === 0) {
          return json({ error: "invalid_cas_metadata" }, 400);
        }
        note.casAttempts += 1;
        note.expectedRevisions.push(expectedRevision);
        if (note.casAttempts <= 2) {
          if (note.casAttempts === 2) note.releaseFirstPair();
          await note.firstPairReady;
        }
        let incomingSnapshot: Uint8Array;
        let stateVector: Uint8Array;
        let presentedMac: Uint8Array;
        try {
          incomingSnapshot = base64ToBytes(snapshotText);
          stateVector = decodeBase64Url(stateVectorText);
          presentedMac = decodeBase64Url(macText);
        } catch {
          return json({ error: "invalid_state_vector" }, 400);
        }
        const writeMacKey = await deriveWriteMacKey(writeMacMasterKey, roomId, generation);
        const expectedMac = await computeCasExpectedMac({
          writeMacKey,
          roomId,
          generation,
          expectedRevision,
          payload: incomingSnapshot,
          permissionEpoch,
          stateVector,
        });
        if (!bytesEqual(expectedMac, presentedMac)) {
          return json({ error: "invalid MAC", code: "INVALID_MAC" }, 401);
        }
        if (generation !== 1 || permissionEpoch !== 1) {
          return json({ error: "invalid authority", code: "generation_conflict" }, 409);
        }
        if (expectedRevision !== note.revision) {
          note.casConflicts += 1;
          return json({ error: "version conflict", code: "version_conflict" }, 409);
        }

        const mergedDoc = new Y.Doc();
        let stateChanged = false;
        try {
          if (note.snapshot.byteLength > 0) Y.applyUpdate(mergedDoc, note.snapshot);
          const storedStateVector = Y.encodeStateVector(mergedDoc);
          Y.applyUpdate(mergedDoc, incomingSnapshot);
          const mergedStateVector = Y.encodeStateVector(mergedDoc);
          if (!bytesEqual(mergedStateVector, stateVector)) {
            return json({ error: "invalid state vector", code: "INVALID_STATE_VECTOR" }, 409);
          }
          stateChanged = !bytesEqual(storedStateVector, mergedStateVector);
          if (stateChanged) note.snapshot = Y.encodeStateAsUpdate(mergedDoc);
        } finally {
          mergedDoc.destroy();
        }
        if (stateChanged) {
          note.revision += 1;
          note.casCommits += 1;
        }
        note.casAccepted += 1;
        const digest = await crypto.subtle.digest("SHA-256", stateVector as BufferSource);
        const stateVectorHash = encodeBase64Url(new Uint8Array(digest));
        const savedAck = await keys.signSavedAck({
          room_id: roomId,
          generation,
          revision: note.revision,
          permission_epoch: permissionEpoch,
          state_vector: stateVectorText,
          state_vector_hash: stateVectorHash,
        });
        return json({ status: "ok", savedAck, roomId, generation, revision: note.revision });
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
