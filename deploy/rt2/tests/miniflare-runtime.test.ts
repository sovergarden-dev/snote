import { describe, expect, it } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  createTestSigningKeys,
  keyringBindings,
  TEST_ROOM_ID,
} from "../../../src/lib/realtime/hub/__tests__/test-crypto";

type TestBindings = Record<string, string>;
type ParsedConfig = Record<string, unknown> & { compatibility_date: string };

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const testHarnessEntrypoint = join(packageDirectory, "tests", "miniflare-harness-worker.ts");
const configPath = join(packageDirectory, "wrangler.toml");

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const cacheDirectory = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cacheDirectory, { recursive: true });
  return mkdtemp(join(cacheDirectory, prefix));
}

async function buildWorker(entrypoint: string, outputDirectory: string): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: false,
    external: ["cloudflare:workers"],
  });
  if (!result.success) throw new Error(`Miniflare test Worker build failed: ${entrypoint}`);
  const bundlePath = result.outputs[0]?.path;
  if (!bundlePath) throw new Error("Miniflare test Worker bundle was not produced");
  return bundlePath;
}

async function parsedConfig(): Promise<ParsedConfig> {
  const text = await readFile(configPath, "utf8");
  return parse(text) as unknown as ParsedConfig;
}

function miniflareOptions(
  scriptPath: string,
  persistencePath: string,
  compatibilityDate: string,
  bindings: TestBindings,
) {
  return {
    name: "snote-rt2-offline-contract",
    scriptPath,
    modules: true,
    compatibilityDate,
    durableObjects: {
      ROOM_HUB: {
        className: "RealtimeHubDurableObject",
        useSQLite: true,
        unsafeUniqueKey: "rt2-offline-room-hub",
      },
      HUB_HEALTH: {
        className: "HubHealthDurableObject",
        useSQLite: true,
        unsafeUniqueKey: "rt2-offline-health-hub",
      },
      ROOM_HUB_TEST: {
        className: "MiniflareContractDurableObject",
        useSQLite: true,
        unsafeUniqueKey: "rt2-offline-contract-hub",
      },
    },
    durableObjectsPersist: persistencePath,
    unsafeInspectDurableObjects: true,
    bindings,
  } as const;
}

async function postJson(miniflare: Miniflare, path: string, value: Record<string, unknown>): Promise<Response> {
  return miniflare.dispatchFetch(`https://rt2.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("rt2 offline Miniflare contracts", () => {
  it("opens with a valid ticket and rejects replay after restarting the DO runtime", async () => {
    const temporaryDirectory = await makeTemporaryDirectory("snote-rt2-replay-");
    const bundleDirectory = join(temporaryDirectory, "bundle");
    const persistencePath = join(temporaryDirectory, "durable-storage");
    let miniflare: Miniflare | undefined;
    try {
      const [config, keys] = await Promise.all([parsedConfig(), createTestSigningKeys()]);
      const bundlePath = await buildWorker(testHarnessEntrypoint, bundleDirectory);
      const now = Math.floor(Date.now() / 1_000);
      const ticket = await keys.signTicket({
        jti: `rt2-miniflare-persistent-${crypto.randomUUID()}`,
        session_id: "session-rt2-01",
        iat: now,
        exp: now + 300,
      });
      const options = miniflareOptions(
        bundlePath,
        persistencePath,
        config.compatibility_date,
        keyringBindings(keys),
      );

      miniflare = new Miniflare(options);
      await miniflare.ready;
      const firstResponse = await postJson(miniflare, "/__test/open", {
        roomId: TEST_ROOM_ID,
        sessionId: "session-rt2-01",
        ticket,
      });
      expect(firstResponse.status).toBe(200);
      const replayStorage = await miniflare.unsafeGetDurableObjectStorage(
        "snote-rt2-offline-contract",
        "MiniflareContractDurableObject",
        { name: TEST_ROOM_ID },
      );
      const replayRows = await replayStorage.exec("SELECT COUNT(*) AS row_count FROM hub_ticket_replay");
      expect(Number(replayRows[0]?.row_count)).toBe(1);
      const firstOutcome = await firstResponse.json() as Record<string, unknown>;
      expect(firstOutcome).toEqual({ accepted: true, messageTypes: ["hub-ready"] });
      await miniflare.dispose();
      miniflare = undefined;

      // A new Miniflare/workerd runtime reopens the same persistent DO SQLite directory.
      miniflare = new Miniflare(options);
      await miniflare.ready;
      const replayResponse = await postJson(miniflare, "/__test/open", {
        roomId: TEST_ROOM_ID,
        sessionId: "session-rt2-01",
        ticket,
      });
      expect(replayResponse.status).toBe(200);
      const replayOutcome = await replayResponse.json() as {
        accepted: boolean;
        messageTypes: string[];
        closeReason?: string;
      };
      expect(replayOutcome.accepted).toBe(false);
      expect(replayOutcome.messageTypes).not.toContain("hub-ready");
      expect(replayOutcome.closeReason).toBe("ticket replay");
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when Durable Object SQLite replay storage errors", async () => {
    const temporaryDirectory = await makeTemporaryDirectory("snote-rt2-store-error-");
    let miniflare: Miniflare | undefined;
    try {
      const [config, keys] = await Promise.all([parsedConfig(), createTestSigningKeys()]);
      const bundlePath = await buildWorker(testHarnessEntrypoint, join(temporaryDirectory, "bundle"));
      miniflare = new Miniflare(miniflareOptions(
        bundlePath,
        join(temporaryDirectory, "durable-storage"),
        config.compatibility_date,
        keyringBindings(keys),
      ));
      await miniflare.ready;

      const prepared = await postJson(miniflare, "/__test/store-failure", { roomId: TEST_ROOM_ID });
      expect(await prepared.json()).toEqual({ prepared: true });
      const now = Math.floor(Date.now() / 1_000);
      const ticket = await keys.signTicket({
        jti: `rt2-miniflare-store-error-${crypto.randomUUID()}`,
        session_id: "session-rt2-store-error",
        iat: now,
        exp: now + 300,
      });
      const response = await postJson(miniflare, "/__test/open", {
        roomId: TEST_ROOM_ID,
        sessionId: "session-rt2-store-error",
        ticket,
      });
      const outcome = await response.json() as {
        accepted: boolean;
        messageTypes: string[];
        closeReason?: string;
      };
      expect(response.status).toBe(200);
      expect(outcome.accepted).toBe(false);
      expect(outcome.messageTypes).not.toContain("hub-ready");
      expect(outcome.closeReason).toBe("replay store unavailable");
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires a probe token, rejects room-bound probes, drains, and reports not ready", async () => {
    const temporaryDirectory = await makeTemporaryDirectory("snote-rt2-drain-");
    let miniflare: Miniflare | undefined;
    try {
      const [config, keys] = await Promise.all([parsedConfig(), createTestSigningKeys()]);
      const bundlePath = await buildWorker(testHarnessEntrypoint, join(temporaryDirectory, "bundle"));
      miniflare = new Miniflare(miniflareOptions(
        bundlePath,
        join(temporaryDirectory, "durable-storage"),
        config.compatibility_date,
        keyringBindings(keys),
      ));
      await miniflare.ready;

      const missingProbe = await miniflare.dispatchFetch("https://rt2.local/healthz");
      expect(missingProbe.status).toBe(404);
      const now = Math.floor(Date.now() / 1_000);
      const roomBoundProbeToken = await keys.signProbe({
        iat: now,
        exp: now + 30,
        room_id: TEST_ROOM_ID,
      });
      const roomBoundProbe = await miniflare.dispatchFetch("https://rt2.local/healthz", {
        headers: { authorization: `Bearer ${roomBoundProbeToken}` },
      });
      expect(roomBoundProbe.status).toBe(404);

      const probeToken = await keys.signProbe({ iat: now, exp: now + 30 });
      const healthy = await miniflare.dispatchFetch("https://rt2.local/healthz", {
        headers: { authorization: `Bearer ${probeToken}` },
      });
      expect(healthy.status).toBe(200);

      const ticket = await keys.signTicket({
        jti: `rt2-miniflare-drain-${crypto.randomUUID()}`,
        session_id: "session-rt2-02",
        iat: now,
        exp: now + 300,
      });
      const drained = await postJson(miniflare, "/__test/drain", {
        roomId: TEST_ROOM_ID,
        sessionId: "session-rt2-02",
        ticket,
      });
      expect(drained.status).toBe(200);
      const drainOutcome = await drained.json() as { accepted: boolean; drained: boolean };
      expect(drainOutcome.accepted).toBe(true);
      expect(drainOutcome.drained).toBe(true);

      const notReady = await miniflare.dispatchFetch("https://rt2.local/healthz", {
        headers: { authorization: `Bearer ${probeToken}` },
      });
      expect(notReady.status).toBe(503);
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed for missing bindings, malformed JSON keys, and wrong-length Ed25519 keys", async () => {
    const temporaryDirectory = await makeTemporaryDirectory("snote-rt2-config-");
    let miniflare: Miniflare | undefined;
    try {
      const [config, keys] = await Promise.all([parsedConfig(), createTestSigningKeys()]);
      const bundlePath = await buildWorker(testHarnessEntrypoint, join(temporaryDirectory, "bundle"));
      const valid = keyringBindings(keys);
      const cases: readonly [string, TestBindings][] = [
        ["missing all bindings", {}],
        ["malformed public-key JSON", { ...valid, TICKET_PROBE_PUBLIC_KEYS_JSON: "{" }],
        ["wrong public-key length", {
          ...valid,
          TICKET_PROBE_PUBLIC_KEYS_JSON: JSON.stringify({ "malformed-key": "AA" }),
        }],
      ];

      for (const [caseName, bindings] of cases) {
        miniflare = new Miniflare(miniflareOptions(
          bundlePath,
          join(temporaryDirectory, `durable-storage-${caseName.replaceAll(/[^a-z0-9]/giu, "-")}`),
          config.compatibility_date,
          bindings,
        ));
        await miniflare.ready;
        for (const path of ["/healthz", `/room/${TEST_ROOM_ID}`]) {
          const response = await miniflare.dispatchFetch(`https://rt2.local${path}`);
          expect(response.status).toBe(503);
        }
        await miniflare.dispose();
        miniflare = undefined;
      }
    } finally {
      await miniflare?.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
