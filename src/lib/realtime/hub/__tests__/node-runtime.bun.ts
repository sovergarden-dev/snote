import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AddressInfo, connect as connectTcp } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { WebSocket as WsClient } from "ws";
import { createNodeHubServer, installNodeSigtermDrain, type NodeHubServer } from "../node-adapter";
import type { ReplayStore } from "../replay-store";
import { SqliteReplayStore } from "../replay-store";
import { bunSqliteDriver } from "./bun-sqlite-driver";
import { ManualClock } from "./manual-clock";
import { authFrame, createTestSigningKeys, keyringBindings, TEST_HUB_ID, TEST_NOW_SECONDS } from "./test-crypto";
import { createRt1HubServerFromEnvironment, loadRt1HubConfig } from "../node-entrypoint";

const COMPOSE_URL = new URL("../../../../../deploy/rt1/compose.yaml", import.meta.url);
const RUNTIME_ENV_URL = new URL("../../../../../deploy/rt1/runtime.env.example", import.meta.url);
const RUNTIME_DOCS_URL = new URL("../../../../../deploy/rt1/README.md", import.meta.url);
const DOCKERFILE_URL = new URL("../../../../../deploy/rt1/Dockerfile", import.meta.url);

function validEnvironment(keys: Awaited<ReturnType<typeof createTestSigningKeys>>): Record<string, string> {
  return {
    ...keyringBindings(keys),
    HUB_LISTEN_ADDRESS: "0.0.0.0",
    HUB_PORT: "8787",
    HUB_DRAIN_WINDOW_MS: "2000",
    HUB_REPLAY_DATABASE_PATH: "/var/lib/snote-rt1/replay.sqlite",
  };
}

function listen(server: NodeHubServer): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readHealth(baseUrl: string, token?: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}/healthz`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function expectRejected(operation: Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

function connect(baseUrl: string): Promise<WsClient> {
  const socket = new WsClient(baseUrl.replace(/^http/u, "ws") + "/room/room_01");
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.on("error", (error) => {
      if (socket.readyState === WsClient.CONNECTING) reject(error);
    });
  });
}

function isUpgradeAccepted(baseUrl: string): Promise<boolean> {
  const target = new URL(baseUrl);
  const socket = connectTcp(Number(target.port), target.hostname);
  return new Promise((resolve) => {
    let finished = false;
    let received = "";
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(accepted);
    };
    socket.once("connect", () => {
      socket.write([
        "GET /room/room_01 HTTP/1.1",
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      received += chunk.toString();
      const status = /^HTTP\/1\.1 ([0-9]{3})/u.exec(received)?.[1];
      if (status) finish(status === "101");
    });
    socket.on("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function send(socket: WsClient, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(text, (error) => error ? reject(error) : resolve());
  });
}

describe("rt1 Node runtime configuration", () => {
  it("requires every runtime setting and imports only valid public verification key sets", async () => {
    const keys = await createTestSigningKeys();
    const env = validEnvironment(keys);
    const parsed = await loadRt1HubConfig(env);
    expect(parsed.config.hubId).toBe(TEST_HUB_ID);
    expect(parsed.listenAddress).toBe("0.0.0.0");
    expect(parsed.port).toBe(8787);
    expect(parsed.drainWindowMilliseconds).toBe(2_000);
    expect(parsed.replayDatabasePath).toBe("/var/lib/snote-rt1/replay.sqlite");

    for (const name of [
      "HUB_ID",
      "TICKET_PROBE_PUBLIC_KEYS_JSON",
      "SAVED_ACK_PUBLIC_KEYS_JSON",
      "HUB_LISTEN_ADDRESS",
      "HUB_PORT",
      "HUB_DRAIN_WINDOW_MS",
      "HUB_REPLAY_DATABASE_PATH",
    ]) {
      const missing = { ...env };
      delete missing[name];
      await expectRejected(loadRt1HubConfig(missing));
    }
  });

  it("fails fast on malformed or non-Ed25519-length public keys", async () => {
    const keys = await createTestSigningKeys();
    const env = validEnvironment(keys);
    await expectRejected(loadRt1HubConfig({ ...env, TICKET_PROBE_PUBLIC_KEYS_JSON: "{" }));
    await expectRejected(loadRt1HubConfig({ ...env, TICKET_PROBE_PUBLIC_KEYS_JSON: JSON.stringify({ bad: "AA" }) }));
    await expectRejected(loadRt1HubConfig({
      ...env,
      TICKET_PROBE_PUBLIC_KEYS_JSON: JSON.stringify({ "test-ticket-probe": keys.savedAckPublicKeyBase64Url }),
    }));
  });

  it("does not open storage or create a server when required config, key, or bind address is invalid", async () => {
    const keys = await createTestSigningKeys();
    const env = validEnvironment(keys);
    let factoryCalled = false;
    const createServer = async () => {
      factoryCalled = true;
      throw new Error("server factory should not run");
    };

    await expectRejected(createRt1HubServerFromEnvironment({}, createServer));
    await expectRejected(createRt1HubServerFromEnvironment({ ...env, TICKET_PROBE_PUBLIC_KEYS_JSON: "{" }, createServer));
    await expectRejected(createRt1HubServerFromEnvironment({ ...env, HUB_LISTEN_ADDRESS: "192.168.1.10" }, createServer));
    expect(factoryCalled).toBe(false);
  });

  it("accepts only the expected container listener address, not loopback or host/LAN addresses", async () => {
    const keys = await createTestSigningKeys();
    const env = validEnvironment(keys);
    for (const address of ["127.0.0.1", "127.0.0.2", "192.168.1.10", "::", "0.0.0.0/0"]) {
      await expectRejected(loadRt1HubConfig({ ...env, HUB_LISTEN_ADDRESS: address }));
    }
  });

  it("rejects invalid ports, unbounded drain windows, and replay paths outside the persistent volume", async () => {
    const keys = await createTestSigningKeys();
    const env = validEnvironment(keys);
    for (const port of ["", "0", "65536", "80abc", "-1"]) {
      await expectRejected(loadRt1HubConfig({ ...env, HUB_PORT: port }));
    }
    for (const drainWindow of ["", "-1", "30001", "2.5", "1e3"]) {
      await expectRejected(loadRt1HubConfig({ ...env, HUB_DRAIN_WINDOW_MS: drainWindow }));
    }
    for (const path of [":memory:", "relative.sqlite", "/tmp/replay.sqlite", "/var/lib/snote-rt1/../outside.sqlite"]) {
      await expectRejected(loadRt1HubConfig({ ...env, HUB_REPLAY_DATABASE_PATH: path }));
    }
  });
});

describe("rt1 Node health and lifecycle", () => {
  it("requires a valid short-lived probe token and returns only status", async () => {
    const keys = await createTestSigningKeys();
    const clock = new ManualClock(TEST_NOW_SECONDS);
    const database = new Database(":memory:");
    const replayStore = new SqliteReplayStore(bunSqliteDriver(database));
    replayStore.initialize(TEST_NOW_SECONDS);
    const server = createNodeHubServer({
      config: { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock },
      replayStore,
      drainWindowMilliseconds: 0,
    });
    const baseUrl = await listen(server);
    try {
      expect(await readHealth(baseUrl)).toEqual({ status: 404, body: "{\"error\":\"not_found\"}" });
      expect(await readHealth(baseUrl, await keys.signProbe({ aud: "wrong-hub" }))).toEqual({
        status: 404,
        body: "{\"error\":\"not_found\"}",
      });
      expect(await readHealth(baseUrl, await keys.signProbe())).toEqual({ status: 200, body: "{\"ok\":true}" });
    } finally {
      await server.drain();
      database.close();
    }
  });

  it("fails readiness closed after SQLite replay failure and rejects subsequent handshakes", async () => {
    const keys = await createTestSigningKeys();
    const clock = new ManualClock(TEST_NOW_SECONDS);
    let readable = true;
    const replayStore: ReplayStore & { checkReadable(): boolean } = {
      checkReadable: () => readable,
      async consumeJti() {
        throw new Error("synthetic storage failure");
      },
    };
    const server = createNodeHubServer({
      config: { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock },
      replayStore,
      drainWindowMilliseconds: 0,
    });
    const baseUrl = await listen(server);
    let socket: WsClient | undefined;
    try {
      const probe = await keys.signProbe();
      expect(await readHealth(baseUrl, probe)).toEqual({ status: 200, body: "{\"ok\":true}" });
      socket = await connect(baseUrl);
      const closed = new Promise<number>((resolve) => socket!.once("close", (code) => resolve(code)));
      await send(socket, authFrame(await keys.signTicket()));
      expect(await closed).toBe(1011);
      readable = true;
      expect(await readHealth(baseUrl, probe)).toEqual({ status: 503, body: "{\"ok\":false}" });

      expect(await isUpgradeAccepted(baseUrl)).toBe(false);
    } finally {
      socket?.terminate();
      await server.drain();
    }
  });

  it("sends drain on SIGTERM, keeps readiness false during the bounded window, then closes", async () => {
    const keys = await createTestSigningKeys();
    const clock = new ManualClock(TEST_NOW_SECONDS);
    const database = new Database(":memory:");
    const replayStore = new SqliteReplayStore(bunSqliteDriver(database));
    replayStore.initialize(TEST_NOW_SECONDS);
    const server = createNodeHubServer({
      config: { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock },
      replayStore,
      drainWindowMilliseconds: 2_000,
    });
    const baseUrl = await listen(server);
    let socket: WsClient | undefined;
    let removeSignalHandler: () => void = () => {};
    try {
      socket = await connect(baseUrl);
      const ready = new Promise<string>((resolve) => socket!.once("message", (data) => resolve(String(data))));
      await send(socket, authFrame(await keys.signTicket()));
      expect(JSON.parse(await ready).message_type).toBe("hub-ready");

      let complete!: () => void;
      let fail!: (error: unknown) => void;
      const drained = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
      removeSignalHandler = installNodeSigtermDrain(server, (error) => error ? fail(error) : complete());
      process.emit("SIGTERM");

      const drainFrame = await new Promise<string>((resolve) => socket!.once("message", (data) => resolve(String(data))));
      expect(JSON.parse(drainFrame).message_type).toBe("drain");
      expect(server.isDraining()).toBe(true);
      expect(await readHealth(baseUrl, await keys.signProbe())).toEqual({ status: 503, body: "{\"ok\":false}" });

      clock.advanceMilliseconds(1_999);
      await Promise.resolve();
      expect(server.listening).toBe(true);
      clock.advanceMilliseconds(1);
      await drained;
      expect(server.listening).toBe(false);
    } finally {
      removeSignalHandler();
      socket?.terminate();
      if (server.listening) {
        const drain = server.drain();
        clock.advanceMilliseconds(30_000);
        await drain;
      }
      database.close();
    }
  });
});

describe("rt1 Docker packaging contract", () => {
  it("uses a private internal network, no published ports, and only cloudflared has egress", async () => {
    const document = parseYaml(await readFile(COMPOSE_URL, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, { internal?: boolean }>;
    };
    const hub = document.services["rt1-hub"]!;
    const cloudflared = document.services.cloudflared!;
    const hubNetworks = hub.networks as string[];
    const cloudflaredNetworks = cloudflared.networks as string[];
    const buildArgs = (hub.build as { args: Record<string, string> }).args;
    const cloudflaredImage = cloudflared.image as string;
    const dockerfile = await readFile(DOCKERFILE_URL, "utf8");

    expect(buildArgs.HUB_BUN_BUILDER_IMAGE_REPOSITORY).toBe("${HUB_BUN_BUILDER_IMAGE_REPOSITORY:?set the Bun builder repository}");
    expect(buildArgs.HUB_BUN_BUILDER_IMAGE_DIGEST).toBe("${HUB_BUN_BUILDER_IMAGE_DIGEST:?set the Bun builder SHA-256 digest}");
    expect(buildArgs.HUB_NODE_RUNTIME_IMAGE_REPOSITORY).toBe("${HUB_NODE_RUNTIME_IMAGE_REPOSITORY:?set the Node 22.22+ runtime repository}");
    expect(buildArgs.HUB_NODE_RUNTIME_IMAGE_DIGEST).toBe("${HUB_NODE_RUNTIME_IMAGE_DIGEST:?set the Node runtime SHA-256 digest}");
    expect(cloudflaredImage).toBe("${CLOUDFLARED_IMAGE_REPOSITORY:?set the cloudflared repository}@sha256:${CLOUDFLARED_IMAGE_DIGEST:?set the cloudflared SHA-256 digest}");
    expect(dockerfile.includes("FROM ${HUB_BUN_BUILDER_IMAGE_REPOSITORY}@sha256:${HUB_BUN_BUILDER_IMAGE_DIGEST} AS builder")).toBe(true);
    expect(dockerfile.includes("FROM ${HUB_NODE_RUNTIME_IMAGE_REPOSITORY}@sha256:${HUB_NODE_RUNTIME_IMAGE_DIGEST} AS runtime")).toBe(true);
    const firstFromIndex = dockerfile.indexOf("FROM ");
    expect(dockerfile.indexOf("ARG HUB_NODE_RUNTIME_IMAGE_REPOSITORY") < firstFromIndex).toBe(true);
    expect(dockerfile.indexOf("ARG HUB_NODE_RUNTIME_IMAGE_DIGEST") < firstFromIndex).toBe(true);

    expect(Object.hasOwn(hub, "ports")).toBe(false);
    expect(Object.hasOwn(cloudflared, "ports")).toBe(false);
    expect(document.networks["rt1-internal"]?.internal).toBe(true);
    expect(hubNetworks).toEqual(["rt1-internal"]);
    expect(cloudflaredNetworks.includes("rt1-internal")).toBe(true);
    expect(cloudflaredNetworks.includes("rt1-egress")).toBe(true);
    expect(hubNetworks.includes("rt1-egress")).toBe(false);
    expect(Object.hasOwn(cloudflared.depends_on as Record<string, unknown>, "rt1-hub")).toBe(true);
  });

  it("runs the hub as non-root with read-only root, persistent replay volume and bounded resources/drain", async () => {
    const document = parseYaml(await readFile(COMPOSE_URL, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const hub = document.services["rt1-hub"]!;
    expect(hub.user).toBe("10001:10001");
    expect(hub.read_only).toBe(true);
    expect(hub.restart).toBe("unless-stopped");
    expect(hub.stop_grace_period).toBe("40s");
    expect(hub.mem_limit).toBe("${HUB_MEMORY_LIMIT:?set an operator-selected cap}");
    expect(hub.cpus).toBe("${HUB_CPU_LIMIT:?set an operator-selected cap}");
    expect(hub.pids_limit).toBe("${HUB_PIDS_LIMIT:?set an operator-selected cap}");
    expect(Object.hasOwn(hub.ulimits as Record<string, unknown>, "nofile")).toBe(true);
    expect((hub.volumes as string[]).join("\n").includes("/var/lib/snote-rt1")).toBe(true);
    expect((hub.environment as Record<string, string>).HUB_LISTEN_ADDRESS).toBe("${HUB_LISTEN_ADDRESS:?required}");
  });

  it("passes only public keys/settings to Hub; keeps samples blank and documents the host assumption", async () => {
    const document = parseYaml(await readFile(COMPOSE_URL, "utf8")) as {
      services: Record<string, Record<string, unknown>>;
    };
    const hub = document.services["rt1-hub"]!;
    const environment = hub.environment as Record<string, string>;
    expect(Object.keys(environment).sort()).toEqual([
      "HUB_DRAIN_WINDOW_MS",
      "HUB_ID",
      "HUB_LISTEN_ADDRESS",
      "HUB_PORT",
      "HUB_REPLAY_DATABASE_PATH",
      "SAVED_ACK_PUBLIC_KEYS_JSON",
      "TICKET_PROBE_PUBLIC_KEYS_JSON",
    ].sort());
    expect(Object.keys(environment).some((name) => /PRIVATE|HMAC|MASTER|SECRET|TUNNEL_TOKEN/u.test(name))).toBe(false);

    const sampleLines = (await readFile(RUNTIME_ENV_URL, "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"));
    expect(sampleLines.length > 0).toBe(true);
    for (const line of sampleLines) expect(/^[A-Z][A-Z0-9_]*=$/u.test(line)).toBe(true);

    const runtimeDocs = await readFile(RUNTIME_DOCS_URL, "utf8");
    expect(runtimeDocs.includes("http://rt1-hub:<HUB_PORT>")).toBe(true);
    expect(runtimeDocs.includes("the Ubuntu VM/Docker host is inside the trusted boundary")).toBe(true);
    expect(runtimeDocs.includes("No host firewall or iptables rule is added")).toBe(true);
    expect(runtimeDocs.includes("checks do not claim otherwise")).toBe(true);
    const dockerfile = await readFile(DOCKERFILE_URL, "utf8");
    expect(/COPY\s+\.\s+\./u.test(dockerfile)).toBe(false);
    expect(dockerfile.includes("USER 10001:10001")).toBe(true);
    expect(dockerfile.includes("--frozen-lockfile")).toBe(true);
  });
});
