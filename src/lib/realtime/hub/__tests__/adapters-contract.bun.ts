import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AddressInfo } from "node:net";
import { WebSocket as WsClient } from "ws";
import { FRAME_VECTOR } from "../../__tests__/test-vectors";
import { MAX_REALTIME_FRAME_BYTES } from "../../protocol";
import { createNodeHubServer, type NodeHubServer } from "../node-adapter";
import {
  HubHealthDurableObject,
  RealtimeHubDurableObject,
  routeHubWorkerRequest,
  type DurableObjectContext,
  type DurableObjectNamespace,
  type DurableObjectSocket,
  type HubWorkerEnvironment,
} from "../durable-object-adapter";
import { SqliteReplayStore } from "../replay-store";
import type { HubClock } from "../clock";
import { bunSqliteDriver } from "./bun-sqlite-driver";
import { ManualClock } from "./manual-clock";
import {
  authFrame,
  createTestSigningKeys,
  keyringBindings,
  relayFrame,
  TEST_HUB_ID,
  TEST_NOW_SECONDS,
  TEST_ROOM_ID,
  type TestSigningKeys,
} from "./test-crypto";

const EVENT_TIMEOUT_MS = 3_000;
type HubEvent = { type: "message"; text: string } | { type: "close"; code: number };
type TicketCarriers = { queryTicket?: string; headerTicket?: string };

interface AdapterClient {
  send(text: string): Promise<void>;
  nextEvent(): Promise<HubEvent>;
  close(): void;
}

interface AdapterHarness {
  clock: ManualClock;
  open(roomId?: string, carriers?: TicketCarriers): Promise<AdapterClient>;
  tryOpen(roomId?: string): Promise<boolean>;
  restart(): Promise<void>;
  drain(): Promise<void>;
  health(token?: string): Promise<number>;
  setStorageFailure(): void;
  sqlExecutionCount(): number;
  close(): Promise<void>;
}

class EventQueue {
  private readonly events: HubEvent[] = [];
  private readonly waiters: ((event: HubEvent) => void)[] = [];

  push(event: HubEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }

  next(): Promise<HubEvent> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timerHolder: { id?: ReturnType<typeof setTimeout> } = {};
      const waiter = (event: HubEvent) => {
        if (timerHolder.id !== undefined) clearTimeout(timerHolder.id);
        resolve(event);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for hub socket event"));
      }, EVENT_TIMEOUT_MS);
      timerHolder.id = timeout;
      this.waiters.push(waiter);
    });
  }
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return String(data);
}

class NodeAdapterClient implements AdapterClient {
  private readonly events = new EventQueue();

  constructor(private readonly socket: WsClient) {
    socket.on("message", (data) => this.events.push({ type: "message", text: messageText(data) }));
    socket.on("close", (code) => this.events.push({ type: "close", code }));
  }

  send(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(text, (error) => error ? reject(error) : resolve());
    });
  }

  nextEvent(): Promise<HubEvent> {
    return this.events.next();
  }

  close(): void {
    if (this.socket.readyState === WsClient.OPEN) this.socket.close(1000, "test complete");
    else if (this.socket.readyState === WsClient.CONNECTING) this.socket.terminate();
  }
}

async function createNodeHarness(keys: TestSigningKeys, clock: ManualClock): Promise<AdapterHarness> {
  const database = new Database(":memory:");
  const driver = bunSqliteDriver(database);
  let failWrites = false;
  let sqlExecutions = 0;
  const replayStore = () => new SqliteReplayStore({
    exec(sql) {
      sqlExecutions += 1;
      driver.exec(sql);
    },
    run(sql, ...values) {
      sqlExecutions += 1;
      if (failWrites) throw new Error("synthetic SQLite write failure");
      return driver.run(sql, ...values);
    },
    get(sql, ...values) {
      sqlExecutions += 1;
      return driver.get(sql, ...values);
    },
  });
  let server: NodeHubServer;
  let baseUrl = "";
  const clients: NodeAdapterClient[] = [];

  async function startServer(): Promise<void> {
    const store = replayStore();
    store.initialize(TEST_NOW_SECONDS);
    server = createNodeHubServer({
      config: { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock },
      replayStore: store,
      drainWindowMilliseconds: 0,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
  }

  async function drainCurrentServer(): Promise<void> {
    const drain = server.drain();
    clock.advanceMilliseconds(0);
    await drain;
  }

  await startServer();
  return {
    clock,
    async open(roomId = TEST_ROOM_ID, carriers = {}) {
      const query = carriers.queryTicket ? `?ticket=${encodeURIComponent(carriers.queryTicket)}` : "";
      const headers: Record<string, string> = {};
      if (carriers.headerTicket) {
        headers["x-hub-ticket"] = carriers.headerTicket;
        headers.authorization = `Bearer ${carriers.headerTicket}`;
      }
      const socket = new WsClient(`${baseUrl}/room/${roomId}${query}`, { headers });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const client = new NodeAdapterClient(socket);
      clients.push(client);
      return client;
    },
    async tryOpen(roomId = TEST_ROOM_ID) {
      const socket = new WsClient(`${baseUrl}/room/${roomId}`);
      return new Promise<boolean>((resolve) => {
        let finished = false;
        const finish = (accepted: boolean) => {
          if (finished) return;
          finished = true;
          socket.removeAllListeners("open");
          if (socket.readyState === WsClient.OPEN) socket.close(1000, "probe complete");
          else if (socket.readyState === WsClient.CONNECTING) socket.terminate();
          resolve(accepted);
        };
        socket.once("open", () => finish(true));
        socket.on("error", () => finish(false));
      });
    },
    async restart() {
      for (const client of clients) client.close();
      await drainCurrentServer();
      await startServer();
    },
    drain: drainCurrentServer,
    async health(token) {
      const address = server.address() as AddressInfo;
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`, { headers });
      return response.status;
    },
    setStorageFailure() {
      failWrites = true;
    },
    sqlExecutionCount: () => sqlExecutions,
    async close() {
      for (const client of clients) client.close();
      await drainCurrentServer();
      database.close();
    },
  };
}

class FakeDurableSocket {
  readyState: number = WsClient.OPEN;
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  binaryType: BinaryType = "arraybuffer";
  url = "";
  closeCode?: number;
  private attachment: unknown;
  private remote?: FakeDurableSocket;
  private readonly events: EventQueue;

  constructor(events = new EventQueue()) {
    this.events = events;
  }

  connect(remote: FakeDurableSocket): void {
    this.remote = remote;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment === undefined ? undefined : structuredClone(this.attachment);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== WsClient.OPEN || typeof data !== "string") throw new Error("Fake socket only sends open text frames");
    this.remote?.events.push({ type: "message", text: data });
  }

  close(code = 1000, _reason = ""): void {
    if (this.readyState !== WsClient.OPEN) return;
    this.readyState = WsClient.CLOSED;
    this.closeCode = code;
    this.events.push({ type: "close", code });
    if (this.remote && this.remote.readyState === WsClient.OPEN) {
      this.remote.readyState = WsClient.CLOSED;
      this.remote.closeCode = code;
      this.remote.events.push({ type: "close", code });
    }
  }

  nextEvent(): Promise<HubEvent> {
    return this.events.next();
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
}

interface FakePair {
  client: FakeDurableSocket;
  server: FakeDurableSocket;
}

let latestFakePair: FakePair | undefined;
class FakeWebSocketPair {
  0: WebSocket;
  1: DurableObjectSocket;

  constructor() {
    const client = new FakeDurableSocket();
    const server = new FakeDurableSocket();
    client.connect(server);
    server.connect(client);
    latestFakePair = { client, server };
    this[0] = client as unknown as WebSocket;
    this[1] = server as unknown as DurableObjectSocket;
  }
}

interface TestDurableObjectContext extends DurableObjectContext {
  sockets: DurableObjectSocket[];
  setFailWrites(value: boolean): void;
  sqlExecutionCount(): number;
}

function createDoContext(database: Database): TestDurableObjectContext {
  const sockets: DurableObjectSocket[] = [];
  let failWrites = false;
  let sqlExecutions = 0;
  const sql = {
    exec(query: string, ...values: (string | number)[]) {
      sqlExecutions += 1;
      if (failWrites && !/^\s*(SELECT|PRAGMA)\b/iu.test(query)) throw new Error("synthetic DO SQLite write failure");
      const statement = database.query(query);
      if (/^\s*(SELECT|PRAGMA)\b/iu.test(query) || /\bRETURNING\b/iu.test(query)) {
        const rows = statement.all(...values).filter((row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null,
        );
        return { rowsWritten: 0, one: () => rows[0], toArray: () => rows };
      }
      const result = statement.run(...values);
      return { rowsWritten: Number(result.changes), one: () => undefined, toArray: () => [] };
    },
  };
  return {
    sockets,
    storage: { sql },
    setFailWrites(value) { failWrites = value; },
    sqlExecutionCount: () => sqlExecutions,
    acceptWebSocket(socket) {
      sockets.push(socket);
    },
    getWebSockets() {
      return sockets.filter((socket) => socket.readyState === WsClient.OPEN);
    },
  };
}

class DurableObjectAdapterClient implements AdapterClient {
  constructor(
    private readonly hub: RealtimeHubDurableObject,
    private readonly server: FakeDurableSocket,
    private readonly remote: FakeDurableSocket,
  ) {}

  async send(text: string): Promise<void> {
    if (this.remote.readyState !== WsClient.OPEN) return;
    await this.hub.webSocketMessage(this.server as unknown as DurableObjectSocket, text);
  }

  nextEvent(): Promise<HubEvent> {
    return this.remote.nextEvent();
  }

  close(): void {
    this.remote.close(1000, "test complete");
  }
}

async function createDurableObjectHarness(keys: TestSigningKeys, clock: ManualClock): Promise<AdapterHarness> {
  const database = new Database(":memory:");
  const context = createDoContext(database);
  const healthDatabase = new Database(":memory:");
  const healthContext = createDoContext(healthDatabase);
  const keyBindings = keyringBindings(keys);
  const healthObject = new HubHealthDurableObject(healthContext);
  let healthFetchCount = 0;
  let hub = new RealtimeHubDurableObject(context, keyBindings, clock);
  const healthStub = {
    async fetch(request: Request) {
      healthFetchCount += 1;
      return healthObject.fetch(request);
    },
    async isDraining() {
      return healthObject.isDraining();
    },
    async setDraining(draining = true) {
      await healthObject.setDraining(draining);
    },
  };
  const environment: HubWorkerEnvironment = {
    ...keyBindings,
    ROOM_HUB: {
      idFromName(name: string) { return name; },
      get() { return { fetch: (request: Request) => hub.fetch(request) }; },
    } as unknown as DurableObjectNamespace,
    HUB_HEALTH: {
      idFromName(name: string) { return name; },
      get() { return healthStub; },
    } as unknown as DurableObjectNamespace,
  };
  const previousPairDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    writable: true,
    value: FakeWebSocketPair,
  });
  const clients: DurableObjectAdapterClient[] = [];

  async function routeSocket(roomId: string, carriers: TicketCarriers = {}): Promise<Response | undefined> {
    const query = carriers.queryTicket ? `?ticket=${encodeURIComponent(carriers.queryTicket)}` : "";
    const headers: Record<string, string> = {
      upgrade: "websocket",
      "cf-connecting-ip": "test-client",
    };
    if (carriers.headerTicket) {
      headers["x-hub-ticket"] = carriers.headerTicket;
      headers.authorization = `Bearer ${carriers.headerTicket}`;
    }
    try {
      return await routeHubWorkerRequest(
        new Request(`https://hub.local/room/${roomId}${query}`, { headers }),
        environment,
        clock,
      );
    } catch {
      // Bun's Fetch Response rejects status 101; the accepted local socket is
      // still available from the fake DO state for callback contract tests.
      return undefined;
    }
  }

  return {
    clock,
    async open(roomId = TEST_ROOM_ID, carriers = {}) {
      latestFakePair = undefined;
      const response = await routeSocket(roomId, carriers);
      const pair = latestFakePair;
      if (!pair || !context.sockets.includes(pair.server as unknown as DurableObjectSocket)) {
        throw new Error(`Durable Object did not accept socket (status ${response?.status ?? "none"})`);
      }
      const client = new DurableObjectAdapterClient(hub, pair.server, pair.client);
      clients.push(client);
      return client;
    },
    async tryOpen(roomId = TEST_ROOM_ID) {
      const before = context.sockets.length;
      const response = await routeSocket(roomId);
      return response?.status === 101 || context.sockets.length > before;
    },
    async restart() {
      for (const client of clients) client.close();
      hub = new RealtimeHubDurableObject(context, keyBindings, clock);
    },
    async drain() {
      await healthObject.setDraining();
      const drain = hub.drain(0);
      clock.advanceMilliseconds(0);
      await drain;
    },
    async health(token) {
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      const response = await routeHubWorkerRequest(
        new Request("https://hub.local/healthz", { headers }),
        environment,
        clock,
      );
      return response.status;
    },
    setStorageFailure() {
      context.setFailWrites(true);
    },
    sqlExecutionCount: () => context.sqlExecutionCount(),
    async close() {
      for (const client of clients) client.close();
      const drain = hub.drain(0);
      clock.advanceMilliseconds(0);
      await drain;
      database.close();
      healthDatabase.close();
      if (previousPairDescriptor) Object.defineProperty(globalThis, "WebSocketPair", previousPairDescriptor);
      else Reflect.deleteProperty(globalThis, "WebSocketPair");
    },
  };
}

const adapterFactories: readonly [string, (keys: TestSigningKeys, clock: ManualClock) => Promise<AdapterHarness>][] = [
  ["Node adapter", createNodeHarness],
  ["Durable Object adapter", createDurableObjectHarness],
];

for (const [adapterName, createHarness] of adapterFactories) {
  describe(`${adapterName} security contracts`, () => {
    async function run(test: (harness: AdapterHarness, keys: TestSigningKeys) => Promise<void>): Promise<void> {
      const keys = await createTestSigningKeys();
      const clock = new ManualClock(TEST_NOW_SECONDS);
      const harness = await createHarness(keys, clock);
      try {
        await test(harness, keys);
      } finally {
        await harness.close();
      }
    }

    it("accepts the ticket only in the first frame, not in query/header, and sends a ticket-free ready control", async () => run(async (harness, keys) => {
      const carriedOnlyOutsideFrame = await harness.open(TEST_ROOM_ID, {
        queryTicket: await keys.signTicket(),
        headerTicket: await keys.signTicket(),
      });
      harness.clock.advanceMilliseconds(5_000);
      const rejectedCarrier = await carriedOnlyOutsideFrame.nextEvent();
      expect(rejectedCarrier.type).toBe("close");
      if (rejectedCarrier.type === "close") expect(rejectedCarrier.code).toBe(4408);

      const client = await harness.open();
      await client.send(authFrame(await keys.signTicket()));
      const event = await client.nextEvent();
      expect(event.type).toBe("message");
      if (event.type === "message") {
        const ready = JSON.parse(event.text) as Record<string, unknown>;
        expect(ready.message_type).toBe("hub-ready");
        expect(ready.opaque_room_id).toBe(TEST_ROOM_ID);
        expect(event.text.includes("ticket")).toBe(false);
      }
      const unauthenticated = await harness.open();
      await unauthenticated.send(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 }));
      const rejected = await unauthenticated.nextEvent();
      expect(rejected.type).toBe("close");
      if (rejected.type === "close") expect(rejected.code).toBe(1008);
    }));

    it("binds audience and hub IDs to the adapter and atomically accepts one duplicated ticket JTI", async () => run(async (harness, keys) => {
      const wrongAudience = await harness.open();
      await wrongAudience.send(authFrame(await keys.signTicket({ aud: "another-hub" })));
      expect((await wrongAudience.nextEvent()).type).toBe("close");

      const wrongHub = await harness.open();
      await wrongHub.send(authFrame(await keys.signTicket({ hub_id: "another-hub" })));
      expect((await wrongHub.nextEvent()).type).toBe("close");

      const ticket = await keys.signTicket({ jti: "shared-ticket-jti-adapter-test" });
      const first = await harness.open();
      const second = await harness.open();
      await Promise.all([
        first.send(authFrame(ticket)),
        second.send(authFrame(ticket)),
      ]);
      const outcomes = await Promise.all([first.nextEvent(), second.nextEvent()]);
      expect(outcomes.filter((event) => event.type === "message")).toHaveLength(1);
      expect(outcomes.filter((event) => event.type === "close")).toHaveLength(1);
    }));

    it("persists consumed JTI across adapter restart", async () => run(async (harness, keys) => {
      const ticket = await keys.signTicket({ jti: "persisted-ticket-jti-restart" });
      const first = await harness.open();
      await first.send(authFrame(ticket));
      expect((await first.nextEvent()).type).toBe("message");
      first.close();

      await harness.restart();
      const afterRestart = await harness.open();
      await afterRestart.send(authFrame(ticket));
      const rejected = await afterRestart.nextEvent();
      expect(rejected.type).toBe("close");
    }));

    it("rejects expired initial tickets, blocks frames at exp, and accepts fresh renewal on that socket", async () => run(async (harness, keys) => {
      const expired = await harness.open();
      await expired.send(authFrame(await keys.signTicket({
        jti: "already-expired-adapter-ticket",
        iat: TEST_NOW_SECONDS - 30,
        exp: TEST_NOW_SECONDS - 1,
      })));
      expect((await expired.nextEvent()).type).toBe("close");

      const currentSeconds = Math.floor(harness.clock.nowMilliseconds() / 1_000);
      const expiring = await harness.open();
      await expiring.send(authFrame(await keys.signTicket({
        jti: "expires-on-adapter-socket",
        iat: currentSeconds,
        exp: currentSeconds + 1,
      })));
      expect((await expiring.nextEvent()).type).toBe("message");
      harness.clock.advanceMilliseconds(1_000);
      await expiring.send(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 }));
      const expiredSocket = await expiring.nextEvent();
      expect(expiredSocket.type).toBe("close");
      if (expiredSocket.type === "close") expect(expiredSocket.code).toBe(1008);

      const renewable = await harness.open();
      await renewable.send(authFrame(await keys.signTicket({
        jti: "renewable-adapter-ticket",
        session_id: "session-02",
        iat: currentSeconds + 1,
        exp: currentSeconds + 2,
      }), "session-02"));
      await renewable.nextEvent();
      harness.clock.advanceMilliseconds(1_000);
      const freshTicket = await keys.signTicket({
        jti: "fresh-adapter-renewal-ticket",
        session_id: "session-02",
        iat: currentSeconds + 2,
        exp: currentSeconds + 302,
      });
      await renewable.send(relayFrame("ticket-renewal", {
        ticket: freshTicket,
        session_id: "session-02",
        counter: 1,
      }));
      const renewed = await renewable.nextEvent();
      expect(renewed.type).toBe("message");
      if (renewed.type === "message") expect(JSON.parse(renewed.text).message_type).toBe("ticket-renewed");
    }));

    it("relays the shared ciphertext vector byte-for-byte and ignores client role/slug fields", async () => run(async (harness, keys) => {
      const editor = await harness.open();
      const viewer = await harness.open();
      await editor.send(authFrame(await keys.signTicket({ permission: "edit", permissions: ["read", "write"], session_id: "sender-01" }), "sender-01"));
      await editor.nextEvent();
      await viewer.send(authFrame(await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-02" }), "session-02"));
      await viewer.nextEvent();

      await editor.send(FRAME_VECTOR.wireText);
      const relayed = await viewer.nextEvent();
      expect(relayed).toEqual({ type: "message", text: FRAME_VECTOR.wireText });
    }));

    it("blocks viewer update/save and forwards only an Edge-signed, room-bound saved ACK", async () => run(async (harness, keys) => {
      const viewer = await harness.open();
      await viewer.send(authFrame(await keys.signTicket({ permission: "read", permissions: ["read"] })));
      await viewer.nextEvent();
      await viewer.send(relayFrame("y-update", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1, role: "edit" }));
      expect((await viewer.nextEvent()).type).toBe("close");

      const saveViewer = await harness.open();
      await saveViewer.send(authFrame(await keys.signTicket({ permission: "read", permissions: ["read"] })));
      await saveViewer.nextEvent();
      await saveViewer.send(relayFrame("save", { ciphertext: "AAECAw" }));
      expect((await saveViewer.nextEvent()).type).toBe("close");

      const ackSender = await harness.open();
      const recipient = await harness.open();
      await ackSender.send(authFrame(await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-03" }), "session-03"));
      await ackSender.nextEvent();
      await recipient.send(authFrame(await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-04" }), "session-04"));
      await recipient.nextEvent();
      const validAck = await keys.signSavedAck();
      const validAckFrame = relayFrame("saved-ack", { savedAck: validAck });
      await ackSender.send(validAckFrame);
      expect(await recipient.nextEvent()).toEqual({ type: "message", text: validAckFrame });

      const fakeAck = await keys.signTicket({ purpose: "syrin:saved-ack:v1", room_id: TEST_ROOM_ID, generation: 3 });
      await ackSender.send(relayFrame("saved-ack", { savedAck: fakeAck }));
      expect((await ackSender.nextEvent()).type).toBe("close");
    }));

    it("renews on the same socket with the next counter/session and does not consume renewal JTI", async () => run(async (harness, keys) => {
      const renewalTicket = await keys.signTicket({ jti: "renewal-jti-remains-usable", permission_epoch: 8, session_id: "session-01" });
      const client = await harness.open();
      await client.send(authFrame(await keys.signTicket({ jti: "initial-ticket-jti-renewal-test" }), "session-01"));
      await client.nextEvent();
      const renewal = relayFrame("ticket-renewal", {
        ticket: renewalTicket,
        session_id: "session-01",
        counter: 1,
      });
      await client.send(renewal);
      const renewed = await client.nextEvent();
      expect(renewed.type).toBe("message");
      if (renewed.type === "message") expect(JSON.parse(renewed.text).message_type).toBe("ticket-renewed");

      const mismatchedClaim = await harness.open();
      await mismatchedClaim.send(authFrame(await keys.signTicket({ session_id: "session-01", jti: "mismatch-initial-jti" }), "session-01"));
      await mismatchedClaim.nextEvent();
      await mismatchedClaim.send(relayFrame("ticket-renewal", {
        ticket: await keys.signTicket({ session_id: "session-02", jti: "mismatch-renewal-claim-jti" }),
        session_id: "session-01", counter: 1,
      }));
      expect((await mismatchedClaim.nextEvent()).type).toBe("close");
      const reusedAsInitial = await harness.open();
      await reusedAsInitial.send(authFrame(renewalTicket, "session-01"));
      const accepted = await reusedAsInitial.nextEvent();
      expect(accepted.type).toBe("message");
      if (accepted.type === "message") expect(JSON.parse(accepted.text).message_type).toBe("hub-ready");

      const wrongSession = await harness.open();
      await wrongSession.send(authFrame(await keys.signTicket({ jti: "initial-ticket-jti-wrong-session", session_id: "session-03" }), "session-03"));
      await wrongSession.nextEvent();
      await wrongSession.send(relayFrame("ticket-renewal", {
        ticket: await keys.signTicket({ jti: "wrong-session-renewal-jti" }),
        session_id: "different-session",
        counter: 1,
      }));
      expect((await wrongSession.nextEvent()).type).toBe("close");

      await client.send(renewal);
      expect((await client.nextEvent()).type).toBe("close");
    }));

    it("fails closed on replay storage errors and probes health only with a fresh ≤30s token", async () => run(async (harness, keys) => {
      const beforeHealth = harness.sqlExecutionCount();
      expect(await harness.health()).toBe(404);
      expect(await harness.health(await keys.signProbe({ aud: "another-hub" }))).toBe(404);
      expect(await harness.health(await keys.signProbe({
        iat: TEST_NOW_SECONDS - 200,
        exp: TEST_NOW_SECONDS - 170,
      }))).toBe(404);
      expect(await harness.health(await keys.signProbe({ exp: TEST_NOW_SECONDS + 31 }))).toBe(404);
      expect(await harness.health(await keys.signProbe({ room_id: null }))).toBe(404);
      expect(await harness.health(await keys.signProbe({ room_id: TEST_ROOM_ID }))).toBe(404);
      const freshProbe = await keys.signProbe();
      const healthyStatus = await harness.health(freshProbe);
      expect(healthyStatus).toBe(200);
      if (adapterName === "Durable Object adapter") expect(harness.sqlExecutionCount()).toBe(beforeHealth);

      harness.setStorageFailure();
      const client = await harness.open();
      await client.send(authFrame(await keys.signTicket()));
      const rejected = await client.nextEvent();
      expect(rejected.type).toBe("close");
      if (rejected.type === "close") expect(rejected.code).toBe(1011);
    }));

    it("uses fake clock for the five-second auth timeout and 256 KB limit, then drains admission", async () => run(async (harness, keys) => {
      const waiting = await harness.open();
      harness.clock.advanceMilliseconds(5_000);
      const timeout = await waiting.nextEvent();
      expect(timeout.type).toBe("close");
      if (timeout.type === "close") expect(timeout.code).toBe(4408);

      const client = await harness.open();
      await client.send(authFrame(await keys.signTicket()));
      await client.nextEvent();
      await client.send("{".repeat(MAX_REALTIME_FRAME_BYTES + 1));
      const oversized = await client.nextEvent();
      expect(oversized.type).toBe("close");
      if (oversized.type === "close") expect(oversized.code).toBe(1009);

      await harness.drain();
      expect(await harness.tryOpen()).toBe(false);
    }));
  });
}
