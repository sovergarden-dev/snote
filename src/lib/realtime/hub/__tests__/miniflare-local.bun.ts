import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Miniflare } from "miniflare";
import { keyringBindings, createTestSigningKeys, TEST_HUB_ID } from "./test-crypto";

declare const Bun: {
  build(options: {
    entrypoints: string[];
    outdir: string;
    target: "browser";
    format: "esm";
    splitting: boolean;
    minify: boolean;
    external?: string[];
  }): Promise<{ success: boolean; outputs: { path: string }[] }>;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("local Durable Object harness", () => {
  it("runs offline with a SQLite DO binding, signed health probes, and no account/routes", async () => {
    const cacheDirectory = join(process.cwd(), "node_modules", ".cache");
    await mkdir(cacheDirectory, { recursive: true });
    const directory = await mkdtemp(join(cacheDirectory, "snote-hub-miniflare-"));
    temporaryDirectories.push(directory);
    const entrypoint = new URL("../durable-object-worker.ts", import.meta.url).pathname;
    const build = await Bun.build({
      entrypoints: [entrypoint],
      outdir: directory,
      target: "browser",
      format: "esm",
      splitting: false,
      minify: false,
      external: ["cloudflare:workers"],
    });
    expect(build.success).toBe(true);
    const workerBundlePath = build.outputs[0]?.path;
    expect(typeof workerBundlePath).toBe("string");
    if (!workerBundlePath) throw new Error("Worker bundle was not produced");

    const keys = await createTestSigningKeys();
    const options = {
      name: "snote-hub-local-contract",
      scriptPath: workerBundlePath,
      modules: true,
      compatibilityDate: "2026-08-06",
      durableObjects: {
        ROOM_HUB: {
          className: "RealtimeHubDurableObject",
          useSQLite: true,
          unsafeUniqueKey: "local-only-room-hub",
        },
        HUB_HEALTH: {
          className: "HubHealthDurableObject",
          useSQLite: true,
          unsafeUniqueKey: "local-only-health-hub",
        },
      },
      durableObjectsPersist: join(directory, "durable-storage"),
      bindings: keyringBindings(keys),
    } as const;

    expect("account_id" in options).toBe(false);
    expect("routes" in options).toBe(false);
    expect(Object.keys(options).some((key) => /account|route/iu.test(key))).toBe(false);

    const miniflare = new Miniflare(options);
    try {
      await miniflare.ready;
      const noToken = await miniflare.dispatchFetch("https://hub.local/healthz");
      expect(noToken.status).toBe(404);

      const now = Math.floor(Date.now() / 1_000);
      const freshToken = await keys.signProbe({ aud: TEST_HUB_ID, iat: now, exp: now + 30 });
      const freshProbe = await miniflare.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${freshToken}` },
      });
      if (freshProbe.status !== 200) {
        throw new Error(`Miniflare health probe failed: ${freshProbe.status} ${await freshProbe.text()}`);
      }
      expect(freshProbe.status).toBe(200);

      const expiredToken = await keys.signProbe({ aud: TEST_HUB_ID, iat: now - 200, exp: now - 170 });
      const expiredProbe = await miniflare.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      expect(expiredProbe.status).toBe(404);

      const tooLongToken = await keys.signProbe({ aud: TEST_HUB_ID, iat: now, exp: now + 31 });
      const tooLongProbe = await miniflare.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${tooLongToken}` },
      });
      expect(tooLongProbe.status).toBe(404);

      const nonWebSocketRoomRequest = await miniflare.dispatchFetch("https://hub.local/room/room_01");
      expect(nonWebSocketRoomRequest.status).toBe(404);

      const namespace = await miniflare.getDurableObjectNamespace("HUB_HEALTH") as unknown as {
        idFromName(name: string): unknown;
        get(id: unknown): unknown;
      };
      const healthStub = namespace.get(namespace.idFromName("hub-health-v1")) as unknown as {
        isDraining(): Promise<boolean>;
        setDraining(draining?: boolean): Promise<void>;
      };
      expect(await healthStub.isDraining()).toBe(false);
      await healthStub.setDraining();
      expect(await healthStub.isDraining()).toBe(true);
      const drainingProbe = await miniflare.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(drainingProbe.status).toBe(503);
    } finally {
      await miniflare.dispose();
    }

    const restarted = new Miniflare(options);
    try {
      await restarted.ready;
      const now = Math.floor(Date.now() / 1_000);
      const freshToken = await keys.signProbe({ aud: TEST_HUB_ID, iat: now, exp: now + 30 });
      const persistedDrain = await restarted.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(persistedDrain.status).toBe(503);
      const restartedNamespace = await restarted.getDurableObjectNamespace("HUB_HEALTH") as unknown as {
        idFromName(name: string): unknown;
        get(id: unknown): unknown;
      };
      const restartedHealthStub = restartedNamespace.get(restartedNamespace.idFromName("hub-health-v1")) as unknown as {
        isDraining(): Promise<boolean>;
        setDraining(draining?: boolean): Promise<void>;
      };
      expect(await restartedHealthStub.isDraining()).toBe(true);
      await restartedHealthStub.setDraining(false);
      expect(await restartedHealthStub.isDraining()).toBe(false);
      const acceptingAgain = await restarted.dispatchFetch("https://hub.local/healthz", {
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(acceptingAgain.status).toBe(200);
    } finally {
      await restarted.dispose();
    }
  });
});
