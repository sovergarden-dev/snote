import type { AddressInfo } from "node:net";
import * as Y from "yjs";
import { createNodeHubServer, type NodeHubServer } from "../src/lib/realtime/hub/node-adapter";
import { decodeBase64Url, encodeBase64Url, verifyProtocolJws } from "../src/lib/realtime/protocol";
import { createTestSigningKeys } from "../src/lib/realtime/hub/__tests__/test-crypto";
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

type LocalHubId = "rt1" | "rt2";
type LocalHubFixture = {
  id: LocalHubId;
  server: NodeHubServer;
  webSocketUrl: string;
  httpUrl: string;
  disable(): Promise<void>;
  isDisabled(): boolean;
  upgradeCount(): number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function roomIdForSlug(slug: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", encoder.encode(`syrin:realtime:local-e2e:${slug}`))
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
  hubId: LocalHubId;
  assignmentEpoch: number;
  topologyEpoch: number;
  issuedHubIds: LocalHubId[];
  issuedTickets: Map<string, { sessionId: string; hubId: LocalHubId; assignmentEpoch: number }>;
  hubReportCount: number;
  probeFailures: number;
  casBlocked: boolean;
  requireConcurrentCas: boolean;
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
    hubId: "rt1",
    assignmentEpoch: 1,
    topologyEpoch: 1,
    issuedHubIds: [],
    issuedTickets: new Map(),
    hubReportCount: 0,
    probeFailures: 0,
    casBlocked: false,
    requireConcurrentCas: false,
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

async function startLocalHub(
  keys: Awaited<ReturnType<typeof createTestSigningKeys>>,
  id: LocalHubId,
): Promise<LocalHubFixture> {
  const replayed = new Set<string>();
  const server = createNodeHubServer({
    config: { hubId: id, pinnedKeys: keys.pinnedKeys },
    replayStore: {
      async consumeJti(jti, expiresAtSeconds, nowSeconds) {
        if (expiresAtSeconds <= nowSeconds || replayed.has(jti)) return false;
        replayed.add(jti);
        return true;
      },
    },
    drainWindowMilliseconds: 0,
  });
  let upgradeCount = 0;
  let disabled = false;
  server.on("upgrade", () => { upgradeCount += 1; });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error(`Local ${id} hub did not bind a TCP port`);
  const host = `127.0.0.1:${(address as AddressInfo).port}`;
  return {
    id,
    server,
    webSocketUrl: `ws://${host}`,
    httpUrl: `http://${host}`,
    async disable() {
      if (disabled) return;
      disabled = true;
      await server.drain();
    },
    isDisabled: () => disabled,
    upgradeCount: () => upgradeCount,
  };
}

async function startLocalEdge(
  keys: Awaited<ReturnType<typeof createTestSigningKeys>>,
  hubs: Record<LocalHubId, LocalHubFixture>,
) {
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
  const probeHub = async (hubId: LocalHubId): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1_000);
    const token = await keys.signProbe({
      aud: hubId,
      hub_id: hubId,
      iat: now,
      exp: now + 30,
    });
    try {
      const response = await fetch(`${hubs[hubId].httpUrl}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
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
          hubId: note.hubId,
          assignmentEpoch: note.assignmentEpoch,
          topologyEpoch: note.topologyEpoch,
          issuedHubIds: note.issuedHubIds,
          hubReportCount: note.hubReportCount,
          probeFailures: note.probeFailures,
          casBlocked: note.casBlocked,
          hub1Disabled: hubs.rt1.isDisabled(),
          hub1Upgrades: hubs.rt1.upgradeCount(),
          hub2Upgrades: hubs.rt2.upgradeCount(),
        });
      }
      if (request.method === "POST" && url.pathname === "/_test/control") {
        let control: Record<string, unknown>;
        try {
          const parsed: unknown = await request.json();
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return json({ error: "invalid_control" }, 400);
          }
          control = parsed as Record<string, unknown>;
        } catch {
          return json({ error: "invalid_control" }, 400);
        }
        const slug = typeof control.slug === "string" ? control.slug : "";
        if (!/^[a-z0-9-]{8,60}$/.test(slug)) return json({ error: "invalid_slug" }, 400);
        const note = noteForSlug(slug);
        if (control.operation === "block-cas") note.casBlocked = true;
        else if (control.operation === "unblock-cas") note.casBlocked = false;
        else if (control.operation === "disable-hub1") await hubs.rt1.disable();
        else if (control.operation === "enable-cas-conflict") note.requireConcurrentCas = true;
        else return json({ error: "invalid_control" }, 400);
        return json({ status: "ok", operation: control.operation });
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
            content: `# Local sync test\n\nIsolated loopback note fixture. ${slug}`,
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
        const hubId = note.hubId;
        const relayKey = await deriveRelayKey(relayMasterKey, roomId, 1);
        const writeMacKey = await deriveWriteMacKey(writeMacMasterKey, roomId, 1);
        const ticket = await keys.signTicket({
          aud: hubId,
          hub_id: hubId,
          room_id: roomId,
          session_id: sessionId,
          generation: 1,
          assignment_epoch: note.assignmentEpoch,
          topology_epoch: note.topologyEpoch,
          permission_epoch: 1,
          permission: "edit",
          permissions: ["read", "write"],
          relay_key_kid: "e2e-relay-v1",
          iat: now,
          exp: now + 300,
        });
        note.issuedHubIds.push(hubId);
        note.issuedTickets.set(ticket, { sessionId, hubId, assignmentEpoch: note.assignmentEpoch });
        while (note.issuedTickets.size > 32) {
          const oldestTicket = note.issuedTickets.keys().next().value;
          if (oldestTicket === undefined) break;
          note.issuedTickets.delete(oldestTicket);
        }
        return json({
          ticket,
          roomId,
          hub_id: hubId,
          assignment_epoch: note.assignmentEpoch,
          topology_epoch: note.topologyEpoch,
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

      if (body.action === "realtime-hub-report") {
        const ticket = typeof body.ticket === "string" ? body.ticket : "";
        const sessionId = typeof body.session_id === "string" ? body.session_id : "";
        const issued = note.issuedTickets.get(ticket);
        if (body.report !== "hub_unreachable" || !issued || issued.sessionId !== sessionId) {
          return json({ error: "invalid_hub_report" }, 401);
        }
        let claims: Record<string, unknown>;
        try {
          claims = await verifyProtocolJws(ticket, {
            tokenType: "ticket",
            pinnedKeys: keys.pinnedKeys,
            expectedAudience: issued.hubId,
            nowSeconds: Math.floor(Date.now() / 1_000),
          });
        } catch {
          return json({ error: "invalid_hub_report_ticket" }, 401);
        }
        if (
          claims.session_id !== sessionId
          || claims.room_id !== roomId
          || claims.hub_id !== issued.hubId
          || claims.assignment_epoch !== issued.assignmentEpoch
          || note.hubId !== issued.hubId
          || note.assignmentEpoch !== issued.assignmentEpoch
        ) return json({ error: "stale_hub_report" }, 409);

        note.hubReportCount += 1;
        if (!await probeHub(issued.hubId)) {
          note.probeFailures += 1;
          if (issued.hubId === "rt1" && !hubs.rt2.isDisabled() && await probeHub("rt2")) {
            note.hubId = "rt2";
            note.assignmentEpoch += 1;
            return json({ status: "hub-change", hub_id: note.hubId });
          }
          return json({ status: "hub-unavailable", hub_id: note.hubId }, 503);
        }
        return json({ status: "hub-healthy", hub_id: note.hubId });
      }

      if (body.action === "realtime-cas-save") {
        if (note.casBlocked) return json({ error: "local_cas_paused" }, 503);
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
        if (note.requireConcurrentCas && note.casAttempts <= 2) {
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
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined) as [string, string][],
  );
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_SUPABASE_") || [
      "VITE_REALTIME_HUB_ID",
      "VITE_REALTIME_HUB_URL",
      "VITE_REALTIME_HUB_URLS_JSON",
      "VITE_REALTIME_HUBS_JSON",
    ].includes(key)) delete env[key];
  }
  let hub1: LocalHubFixture | undefined;
  let hub2: LocalHubFixture | undefined;
  let edge: { port: number; stop(closeActiveConnections?: boolean): void } | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    hub1 = await startLocalHub(keys, "rt1");
    hub2 = await startLocalHub(keys, "rt2");
    edge = await startLocalEdge(keys, { rt1: hub1, rt2: hub2 });
    const edgeUrl = `http://127.0.0.1:${edge.port}`;
    Object.assign(env, {
      VITE_SUPABASE_URL: edgeUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: "fake-invalid-local-publishable-key",
      VITE_SUPABASE_PROJECT_ID: "fake-invalid-local-project-id",
      VITE_TURNSTILE_SITE_KEY: "",
      VITE_CAPABILITY_AUTH_ENABLED: "true",
      VITE_CAPABILITY_ROUTES_ENABLED: "true",
      VITE_REALTIME_HUB_SYNC_ENABLED: "true",
      VITE_REALTIME_HUBS_JSON: JSON.stringify({ rt1: hub1.webSocketUrl, rt2: hub2.webSocketUrl }),
      VITE_REALTIME_TICKET_PUBLIC_KEYS_JSON: JSON.stringify({ "test-ticket-probe": keys.ticketPublicKeyBase64Url }),
      VITE_REALTIME_SAVED_ACK_PUBLIC_KEYS_JSON: JSON.stringify({ "test-saved-ack": keys.savedAckPublicKeyBase64Url }),
      PLAYWRIGHT_BASE_URL: APP_URL,
    });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("VITE_SUPABASE_") || [
        "VITE_REALTIME_HUB_ID",
        "VITE_REALTIME_HUB_URL",
        "VITE_REALTIME_HUB_URLS_JSON",
        "VITE_REALTIME_HUBS_JSON",
      ].includes(key)) delete process.env[key];
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
    edge?.stop(true);
    await Promise.all([hub1?.server.drain(), hub2?.server.drain()]);
  }
}

const exitCode = await main();
process.exitCode = exitCode;
