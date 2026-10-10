// @vitest-environment jsdom
import "fake-indexeddb/auto";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PROTOCOL_VERSION,
  Ed25519UnsupportedError,
  decodeBase64Url,
  encodeBase64Url,
  encodeRealtimeFrame,
  type JwsPinnedKeySets,
} from "@/lib/realtime/protocol";
import {
  prepareRealtimeNote,
  prepareRealtimeNoteSafely,
  RealtimeEdgeApiError,
  type RealtimeEdgeApi,
  type RealtimeHubConfig,
  type RealtimeTicketBundle,
} from "@/lib/realtime/client-sync";
import { RealtimeYjsProvider } from "../realtime-provider";
import { RealtimeOutbox } from "../realtime-outbox";
import { base64ToBytes, bytesToBase64 } from "../base64";
import { encryptRealtimePayload } from "@/lib/realtime/client-crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HUB_ID = "test-hub";
const ROOM_PREFIX = "test-room-generation-";
const NOTE_ID = "d26ec6e7-038c-49c1-a767-8e38c0f9c1f0";
const SESSION_ID = "session-test-01";
const CONFIG: RealtimeHubConfig = { hubId: HUB_ID, hubUrl: "ws://localhost:8787" };
const ROUTED_CONFIG: RealtimeHubConfig = {
  hubId: "rt1",
  hubUrl: "ws://localhost:8787/",
  hubUrls: { rt1: "ws://localhost:8787/", rt2: "ws://localhost:8788/" },
};

function segment(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

async function signJws(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
  typ: string,
): Promise<string> {
  const input = `${segment({ alg: "EdDSA", kid, typ })}.${segment(payload)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    encoder.encode(input) as BufferSource,
  ));
  return `${input}.${encodeBase64Url(signature)}`;
}

async function createKeyFixture(): Promise<{
  pinnedKeys: JwsPinnedKeySets;
  ticketPrivate: CryptoKey;
  ackPrivate: CryptoKey;
}> {
  const ticketPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const ackPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    pinnedKeys: {
      ticketAndProbe: { "ticket-test-kid": ticketPair.publicKey },
      savedAck: { "ack-test-kid": ackPair.publicKey },
    },
    ticketPrivate: ticketPair.privateKey,
    ackPrivate: ackPair.privateKey,
  };
}

function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  if (text) doc.getText("content").insert(0, text);
  return doc;
}

async function createTicketBundle(
  keys: Awaited<ReturnType<typeof createKeyFixture>>,
  sessionId: string,
  generation = 7,
  snapshot = "",
  permissionEpoch = 4,
  roomIdOverride?: string,
  routing?: { hubId: "rt1" | "rt2"; assignmentEpoch: number; topologyEpoch: number },
): Promise<RealtimeTicketBundle> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const roomId = roomIdOverride ?? `${ROOM_PREFIX}${generation}-${"x".repeat(24)}`;
  const hubId = routing?.hubId ?? HUB_ID;
  const rawWriteMacKey = new Uint8Array(32).fill(23 + generation);
  const rawRelayKey = new Uint8Array(32).fill(73 + generation);
  const ticket = await signJws({
    purpose: "syrin:ticket:v1",
    aud: hubId,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    jti: `jti-${generation}-${sessionId}`,
    hub_id: hubId,
    assignment_epoch: routing?.assignmentEpoch ?? "epoch-a",
    ...(routing ? { topology_epoch: routing.topologyEpoch } : {}),
    room_id: roomId,
    generation,
    permission_epoch: permissionEpoch,
    permission: "edit",
    permissions: ["read", "write"],
    session_id: sessionId,
    relay_key_kid: "relay-test-kid",
  }, keys.ticketPrivate, "ticket-test-kid", "syrin-ticket+jwt");
  return {
    ticket,
    roomId,
    write_mac_key: encodeBase64Url(rawWriteMacKey),
    relay_key: encodeBase64Url(rawRelayKey),
    relay_key_kid: "relay-test-kid",
    noteId: NOTE_ID,
    revision: 1,
    generation,
    permissionEpoch,
    ydocState: snapshot,
    ...(routing ? {
      hub_id: hubId,
      assignment_epoch: routing.assignmentEpoch,
      topology_epoch: routing.topologyEpoch,
    } : {}),
  };
}

async function createPrelude(
  keys: Awaited<ReturnType<typeof createKeyFixture>>,
  options: { generation?: number; snapshot?: string } = {},
): Promise<{ prelude: Awaited<ReturnType<typeof prepareRealtimeNote>>; api: RealtimeEdgeApi }> {
  const api: RealtimeEdgeApi = {
    issueTicket: async (_slug, sessionId) => createTicketBundle(
      keys,
      sessionId,
      options.generation ?? 7,
      options.snapshot ?? "",
    ),
    casSave: async () => { throw new Error("unexpected CAS save"); },
  };
  const prelude = await prepareRealtimeNote("random-test-note", {
    api,
    config: CONFIG,
    pinnedKeys: keys.pinnedKeys,
    sessionId: SESSION_ID,
  });
  return { prelude, api };
}

function makeAckSigner(
  keys: Awaited<ReturnType<typeof createKeyFixture>>,
): (request: Parameters<RealtimeEdgeApi["casSave"]>[0], revision?: number) => Promise<string> {
  return async (request, revision = request.expectedRevision + 1) => {
    const stateVector = decodeBase64Url(request.stateVector);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", stateVector as BufferSource));
    return signJws({
      purpose: "syrin:saved-ack:v1",
      iat: Math.floor(Date.now() / 1000),
      room_id: `${ROOM_PREFIX}${request.generation}-${"x".repeat(24)}`,
      generation: request.generation,
      revision,
      permission_epoch: request.permissionEpoch,
      state_vector: request.stateVector,
      state_vector_hash: encodeBase64Url(hash),
    }, keys.ackPrivate, "ack-test-kid", "syrin-saved-ack+jwt");
  };
}

async function makeInvalidSignatureAck(
  request: Parameters<RealtimeEdgeApi["casSave"]>[0],
  roomId: string,
): Promise<string> {
  const stateVector = decodeBase64Url(request.stateVector);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", stateVector as BufferSource));
  const input = `${segment({ alg: "EdDSA", kid: "ack-test-kid", typ: "syrin-saved-ack+jwt" })}.${segment({
    purpose: "syrin:saved-ack:v1",
    iat: Math.floor(Date.now() / 1000),
    room_id: roomId,
    generation: request.generation,
    revision: request.expectedRevision + 1,
    permission_epoch: request.permissionEpoch,
    state_vector: request.stateVector,
    state_vector_hash: encodeBase64Url(hash),
  })}`;
  return `${input}.${encodeBase64Url(new Uint8Array(64))}`;
}

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  readonly sent: string[] = [];

  constructor(readonly url: string, private readonly roomId: string) {
    super();
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    this.sent.push(data);
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.message_type === "hub-auth") {
      queueMicrotask(() => this.serverSend({
        v: CURRENT_PROTOCOL_VERSION,
        message_type: "hub-ready",
        opaque_room_id: this.roomId,
        payload: { sender_id: "sender-test-0001" },
      }));
    }
    if (frame.message_type === "ticket-renewal") {
      const payload = frame.payload as Record<string, unknown>;
      queueMicrotask(() => this.serverSend({
        v: CURRENT_PROTOCOL_VERSION,
        message_type: "ticket-renewed",
        opaque_room_id: this.roomId,
        payload: { counter: payload.counter },
      }));
    }
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  serverClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  serverSend(frame: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

async function connectProvider(provider: RealtimeYjsProvider): Promise<FakeWebSocket> {
  await provider.connect({ name: "Test editor", color: "#123456" });
  for (let attempt = 0; attempt < 50 && !provider.connected; attempt += 1) await Promise.resolve();
  expect(provider.connected).toBe(true);
  const socket = (provider as unknown as { socket: FakeWebSocket }).socket;
  return socket;
}

describe("routed realtime provider recovery", () => {
  it("opens the WebSocket on the URL selected by the renewed ticket hub_id", async () => {
    const keys = await createKeyFixture();
    const initialApi: RealtimeEdgeApi = {
      issueTicket: async (_slug, sessionId) => createTicketBundle(
        keys,
        sessionId,
        7,
        "",
        4,
        undefined,
        { hubId: "rt1", assignmentEpoch: 2, topologyEpoch: 1 },
      ),
      casSave: async () => { throw new Error("unexpected CAS save"); },
    };
    const prelude = await prepareRealtimeNote("random-test-note", {
      api: initialApi,
      config: ROUTED_CONFIG,
      pinnedKeys: keys.pinnedKeys,
      sessionId: SESSION_ID,
    });
    const reconnectApi: RealtimeEdgeApi = {
      issueTicket: async (_slug, sessionId) => createTicketBundle(
        keys,
        sessionId,
        7,
        "",
        4,
        undefined,
        { hubId: "rt2", assignmentEpoch: 3, topologyEpoch: 2 },
      ),
      casSave: async () => { throw new Error("unexpected CAS save"); },
    };
    const urls: string[] = [];
    const doc = new Y.Doc();
    const outbox = new RealtimeOutbox(`provider-route-${crypto.randomUUID()}`);
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api: reconnectApi,
      outbox,
      socketFactory: (url) => {
        urls.push(url);
        return new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket;
      },
    });
    doc.getText("content").insert(0, "unsent across hub change");
    await provider.whenOutboxPersisted();
    const pendingBefore = await outbox.list("random-test-note", 7);
    expect(pendingBefore).toHaveLength(1);
    await (provider as unknown as { openSocket(reconnecting: boolean): Promise<void> })
      .openSocket(true);
    for (let attempt = 0; attempt < 50 && !provider.connected; attempt += 1) await Promise.resolve();
    expect(urls[0]).toContain("localhost:8788/room/");
    expect(provider.connected).toBe(true);
    expect(await outbox.list("random-test-note", 7)).toMatchObject([
      { updateId: pendingBefore[0]!.updateId },
    ]);
    await provider.destroy();
    doc.destroy();
  });

  it("reconnects after a hub drain using the newly issued hub ticket and retains outbox rows", async () => {
    const keys = await createKeyFixture();
    const initialApi: RealtimeEdgeApi = {
      issueTicket: async (_slug, sessionId) => createTicketBundle(
        keys,
        sessionId,
        7,
        "",
        4,
        undefined,
        { hubId: "rt1", assignmentEpoch: 2, topologyEpoch: 1 },
      ),
      casSave: async () => { throw new Error("unexpected CAS save"); },
    };
    const prelude = await prepareRealtimeNote("random-test-note", {
      api: initialApi,
      config: ROUTED_CONFIG,
      pinnedKeys: keys.pinnedKeys,
      sessionId: SESSION_ID,
    });
    const issueTicket = vi.fn(async (_slug: string, sessionId: string) => createTicketBundle(
      keys,
      sessionId,
      7,
      "",
      4,
      undefined,
      { hubId: "rt2", assignmentEpoch: 3, topologyEpoch: 2 },
    ));
    const api: RealtimeEdgeApi = {
      issueTicket,
      casSave: initialApi.casSave,
    };
    const urls: string[] = [];
    const doc = new Y.Doc();
    const outbox = new RealtimeOutbox(`provider-drain-${crypto.randomUUID()}`);
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api,
      outbox,
      socketFactory: (url) => {
        urls.push(url);
        return new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket;
      },
    });

    const initialSocket = await connectProvider(provider);
    doc.getText("content").insert(0, "unsent through drain");
    await provider.whenOutboxPersisted();
    const pendingBefore = await outbox.list("random-test-note", 7);
    expect(pendingBefore).toHaveLength(1);

    initialSocket.serverSend({
      v: CURRENT_PROTOCOL_VERSION,
      message_type: "drain",
      opaque_room_id: prelude.ticket.roomId,
    });

    await vi.waitFor(() => expect(urls).toHaveLength(2));
    await vi.waitFor(() => expect(provider.connected).toBe(true));
    expect(urls[0]).toContain("localhost:8787/room/");
    expect(urls[1]).toContain("localhost:8788/room/");
    expect(issueTicket).toHaveBeenCalledOnce();
    expect(await outbox.list("random-test-note", 7)).toMatchObject([
      { updateId: pendingBefore[0]!.updateId },
    ]);

    await provider.destroy();
    doc.destroy();
  });

  it("reports a single unreachable event only when the WebSocket never opened", async () => {
    const keys = await createKeyFixture();
    const initialApi: RealtimeEdgeApi = {
      issueTicket: async (_slug, sessionId) => createTicketBundle(
        keys,
        sessionId,
        7,
        "",
        4,
        undefined,
        { hubId: "rt1", assignmentEpoch: 2, topologyEpoch: 1 },
      ),
      casSave: async () => { throw new Error("unexpected CAS save"); },
    };
    const prelude = await prepareRealtimeNote("random-test-note", {
      api: initialApi,
      config: ROUTED_CONFIG,
      pinnedKeys: keys.pinnedKeys,
      sessionId: SESSION_ID,
    });
    const reportHubUnreachable = vi.fn(async () => "hub-change");
    const api: RealtimeEdgeApi = {
      issueTicket: initialApi.issueTicket,
      reportHubUnreachable,
      casSave: initialApi.casSave,
    };
    class NeverOpenWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = NeverOpenWebSocket.CONNECTING;
      readonly url: string;
      constructor(url: string) {
        super();
        this.url = url;
      }
      send(): void {}
      close(): void {
        this.readyState = NeverOpenWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
      failBeforeOpen(): void {
        this.dispatchEvent(new Event("error"));
        this.close();
      }
    }
    let socket: NeverOpenWebSocket | null = null;
    const provider = new RealtimeYjsProvider("random-test-note", new Y.Doc(), {
      prelude,
      api,
      outbox: new RealtimeOutbox(`provider-report-${crypto.randomUUID()}`),
      socketFactory: (url) => {
        socket = new NeverOpenWebSocket(url);
        return socket as unknown as WebSocket;
      },
    });
    await (provider as unknown as { openSocket(reconnecting: boolean): Promise<void> })
      .openSocket(false);
    socket!.failBeforeOpen();
    await vi.waitFor(() => expect(reportHubUnreachable).toHaveBeenCalledOnce());
    expect(reportHubUnreachable).toHaveBeenCalledWith(
      "random-test-note",
      prelude.sessionId,
      prelude.ticket.ticket,
    );
    await provider.destroy();
  });
});

async function waitForRow(outbox: RealtimeOutbox, generation = 7): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await outbox.list("random-test-note", generation)).length > 0) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for realtime outbox row");
}

async function expectUnsafeCasRebaseToBeRejected(options: {
  permissionEpoch?: number;
  roomId?: string;
}): Promise<void> {
  const keys = await createKeyFixture();
  const { prelude } = await createPrelude(keys);
  const foreignDoc = makeDoc("foreign authority snapshot");
  const latestTicket = {
    ...(await createTicketBundle(
      keys,
      SESSION_ID,
      7,
      bytesToBase64(Y.encodeStateAsUpdate(foreignDoc)),
      options.permissionEpoch ?? 4,
      options.roomId,
    )),
    revision: 2,
  };
  const issueTicket = vi.fn(async () => latestTicket);
  const casSave = vi.fn(async () => {
    throw new RealtimeEdgeApiError("stale revision", 409, "version_conflict");
  });
  const outbox = new RealtimeOutbox(`provider-unsafe-rebase-${crypto.randomUUID()}`);
  const doc = new Y.Doc();
  const provider = new RealtimeYjsProvider("random-test-note", doc, {
    prelude,
    api: { issueTicket, casSave },
    outbox,
    socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
  });
  provider.setExpectedEncrypted(false);
  await connectProvider(provider);
  doc.getText("content").insert(0, "local edit");
  await provider.whenOutboxPersisted();
  await waitForRow(outbox);

  await provider.flushCasFallback();

  expect(casSave).toHaveBeenCalledTimes(1);
  expect(issueTicket).toHaveBeenCalledWith("random-test-note", SESSION_ID);
  expect(doc.getText("content").toString()).not.toContain("foreign authority snapshot");
  expect(await outbox.list("random-test-note", 7)).toHaveLength(1);
  await provider.destroy();
  foreignDoc.destroy();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeYjsProvider durable ACK and fallback", () => {
  it("does not clear the outbox for a fake relay ACK or a correctly shaped CAS JWS with an invalid Ed25519 signature", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const database = `provider-forged-${crypto.randomUUID()}`;
    const outbox = new RealtimeOutbox(database);
    const doc = new Y.Doc();
    const forgedApi: RealtimeEdgeApi = {
      issueTicket: async () => prelude.ticket,
      casSave: async (request) => {
        const savedAck = await makeInvalidSignatureAck(request, prelude.ticket.roomId);
        expect(savedAck.split(".")).toHaveLength(3);
        expect(decodeBase64Url(savedAck.split(".")[2])).toHaveLength(64);
        return {
          savedAck,
          roomId: prelude.ticket.roomId,
          generation: request.generation,
          revision: request.expectedRevision + 1,
        };
      },
    };
    const socketFactory = (url: string): WebSocket => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket;
    const provider = new RealtimeYjsProvider("random-test-note", doc, { prelude, api: forgedApi, outbox, socketFactory });
    provider.setExpectedEncrypted(false);
    await connectProvider(provider);
    doc.getText("content").insert(0, "kept until verified");
    await provider.whenOutboxPersisted();
    await waitForRow(outbox);

    (provider as unknown as { socket: FakeWebSocket }).socket.serverSend({
      v: CURRENT_PROTOCOL_VERSION,
      message_type: "saved-ack",
      opaque_room_id: prelude.ticket.roomId,
      payload: { token: "forged" },
    });
    await Promise.resolve();
    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);

    await provider.flushCasFallback();
    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);
    await provider.destroy();
  });

  it("keeps the existing outbox and returns safe fallback when Ed25519 is unsupported", async () => {
    const database = `provider-ed25519-${crypto.randomUUID()}`;
    const outbox = new RealtimeOutbox(database);
    await outbox.enqueue({
      slug: "random-test-note",
      generation: 7,
      updateId: "abcdefghijklmnop",
      update: new Uint8Array([1, 2, 3]),
      createdAt: 1,
    });
    const api: RealtimeEdgeApi = {
      issueTicket: async () => { throw new Error("must not request a ticket without Ed25519"); },
      casSave: async () => { throw new Error("unexpected CAS"); },
    };
    const result = await prepareRealtimeNoteSafely("random-test-note", {
      api,
      config: CONFIG,
      loadKeys: async () => { throw new Ed25519UnsupportedError(); },
      sessionId: SESSION_ID,
    });
    expect(result).toEqual({ status: "fallback", reason: "ed25519-unsupported" });
    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);
    outbox.close();
  });

  it("renews the ticket on the socket with its signed session ID and next counter", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const api: RealtimeEdgeApi = {
      issueTicket: vi.fn(async (_slug, sessionId) => {
        expect(sessionId).toBe(SESSION_ID);
        return prelude.ticket;
      }),
      casSave: async () => { throw new Error("unexpected CAS"); },
    };
    const provider = new RealtimeYjsProvider("random-test-note", new Y.Doc(), {
      prelude,
      api,
      outbox: new RealtimeOutbox(`provider-renewal-${crypto.randomUUID()}`),
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    provider.setExpectedEncrypted(false);
    const socket = await connectProvider(provider);

    await (provider as unknown as { renewTicketOverSocket: () => Promise<void> }).renewTicketOverSocket();
    await Promise.resolve();
    const frames = socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
    const renewal = frames.find((frame) => frame.message_type === "ticket-renewal");
    expect(renewal).toBeDefined();
    expect(new URL(socket.url).search).toBe("");
    expect(api.issueTicket).toHaveBeenCalledWith("random-test-note", SESSION_ID);
    expect(renewal?.payload).toMatchObject({ session_id: SESSION_ID, counter: 1 });
    expect((provider as unknown as { renewalWaitingFor: number | null }).renewalWaitingFor).toBeNull();

    await provider.destroy();
  });

  it("runs the safe CAS fallback after 90 seconds and clears only after a verified ACK", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const database = `provider-cas-${crypto.randomUUID()}`;
    const outbox = new RealtimeOutbox(database);
    const doc = new Y.Doc();
    const ackFor = makeAckSigner(keys);
    const casSave = vi.fn(async (request: Parameters<RealtimeEdgeApi["casSave"]>[0]) => ({
      savedAck: await ackFor(request),
      roomId: prelude.ticket.roomId,
      generation: 7,
      revision: request.expectedRevision + 1,
    }));
    const api: RealtimeEdgeApi = {
      issueTicket: async () => prelude.ticket,
      casSave,
    };
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api,
      outbox,
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    provider.setExpectedEncrypted(false);
    await connectProvider(provider);
    const synced = new Promise<void>((resolve) => {
      provider.onSyncEvent((event) => { if (event.type === "synced-durable") resolve(); });
    });
    doc.getText("content").insert(0, "durable after signed ACK");
    await provider.whenOutboxPersisted();
    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(casSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await synced;
    expect(casSave).toHaveBeenCalledTimes(1);
    expect(await outbox.list("random-test-note", 7)).toHaveLength(0);
    expect(provider.getLastSnapshotAt()).toBeGreaterThan(0);
    await provider.destroy();
  });

  it("clears a raced outbox row after an idempotent CAS returns the same revision with a valid ACK", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const doc = new Y.Doc();
    let injectOnNextList = false;
    class RacingOutbox extends RealtimeOutbox {
      override async list(slug: string, generation: number, limit = 256) {
        const rows = await super.list(slug, generation, limit);
        if (injectOnNextList) {
          injectOnNextList = false;
          const content = doc.getText("content");
          content.insert(content.length, " raced update");
        }
        return rows;
      }
    }
    const outbox = new RacingOutbox(`provider-cas-race-${crypto.randomUUID()}`);
    const requests: Parameters<RealtimeEdgeApi["casSave"]>[0][] = [];
    const ackFor = makeAckSigner(keys);
    const casSave = vi.fn(async (request: Parameters<RealtimeEdgeApi["casSave"]>[0]) => {
      requests.push(request);
      const revision = requests.length === 1
        ? request.expectedRevision + 1
        : request.expectedRevision;
      return {
        savedAck: await ackFor(request, revision),
        roomId: prelude.ticket.roomId,
        generation: request.generation,
        revision,
      };
    });
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api: { issueTicket: async () => prelude.ticket, casSave },
      outbox,
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    provider.setExpectedEncrypted(false);
    await connectProvider(provider);
    doc.getText("content").insert(0, "first update");
    await provider.whenOutboxPersisted();
    await waitForRow(outbox);

    // This local update arrives after the CAS outbox-ID snapshot but before
    // its Yjs snapshot is encoded, so it is committed but not in the first ACK batch.
    injectOnNextList = true;
    await provider.flushCasFallback();
    expect(casSave).toHaveBeenCalledTimes(1);
    expect(requests[0]?.expectedRevision).toBe(1);
    const committedDoc = new Y.Doc();
    try {
      Y.applyUpdate(committedDoc, base64ToBytes(requests[0]!.ydocState));
      expect(committedDoc.getText("content").toString()).toContain("first update");
      expect(committedDoc.getText("content").toString()).toContain("raced update");
    } finally {
      committedDoc.destroy();
    }
    expect(await outbox.list("random-test-note", 7)).toHaveLength(1);

    // The state vector is already durable: the retry is an idempotent CAS.
    // Its signed ACK may keep revision 2, but must still clear only the retained row.
    await provider.flushCasFallback();
    expect(casSave).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.expectedRevision)).toEqual([1, 2]);
    expect(requests[1]?.stateVector).toBe(requests[0]?.stateVector);
    expect(await outbox.list("random-test-note", 7)).toHaveLength(0);
    expect(provider.hasUnflushedLocalChanges()).toBe(false);
    await provider.destroy();
  });

  it("rebases a stale revision, retries CAS and clears outbox only after the valid ACK", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const remoteDoc = makeDoc("remote edit");
    const snapshot = bytesToBase64(Y.encodeStateAsUpdate(remoteDoc));
    const latestTicket = {
      ...(await createTicketBundle(keys, SESSION_ID, 7, snapshot)),
      revision: 2,
    };
    const issueTicket = vi.fn(async () => latestTicket);
    const requests: Parameters<RealtimeEdgeApi["casSave"]>[0][] = [];
    let mergedContent = "";
    const ackFor = makeAckSigner(keys);
    const casSave = vi.fn(async (request: Parameters<RealtimeEdgeApi["casSave"]>[0]) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new RealtimeEdgeApiError("stale revision", 409, "version_conflict");
      }
      const mergedDoc = new Y.Doc();
      Y.applyUpdate(mergedDoc, base64ToBytes(request.ydocState));
      mergedContent = mergedDoc.getText("content").toString();
      mergedDoc.destroy();
      return {
        savedAck: await ackFor(request),
        roomId: prelude.ticket.roomId,
        generation: 7,
        revision: 3,
      };
    });
    const api: RealtimeEdgeApi = { issueTicket, casSave };
    const database = `provider-rebase-${crypto.randomUUID()}`;
    const outbox = new RealtimeOutbox(database);
    const doc = new Y.Doc();
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api,
      outbox,
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    provider.setExpectedEncrypted(false);
    await connectProvider(provider);
    doc.getText("content").insert(0, "local edit");
    await provider.whenOutboxPersisted();
    await waitForRow(outbox);

    await provider.flushCasFallback();

    expect(casSave).toHaveBeenCalledTimes(2);
    expect(requests.map((request) => request.expectedRevision)).toEqual([1, 2]);
    expect(issueTicket).toHaveBeenCalledWith("random-test-note", SESSION_ID);
    expect(mergedContent).toContain("local edit");
    expect(mergedContent).toContain("remote edit");
    expect(doc.getText("content").toString()).toContain("remote edit");
    expect(await outbox.list("random-test-note", 7)).toHaveLength(0);
    await provider.destroy();
    remoteDoc.destroy();
  });

  it("does not rebase a revision conflict into a different permission epoch", async () => {
    await expectUnsafeCasRebaseToBeRejected({ permissionEpoch: 5 });
  });

  it("does not rebase a revision conflict into a different room", async () => {
    await expectUnsafeCasRebaseToBeRejected({ roomId: `${ROOM_PREFIX}7-${"y".repeat(24)}` });
  });

  it("does not apply inbound y-update when its MAC is missing or invalid", async () => {
    const keys = await createKeyFixture();
    const { prelude } = await createPrelude(keys);
    const doc = new Y.Doc();
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api: {
        issueTicket: async () => prelude.ticket,
        casSave: async () => { throw new Error("unexpected CAS"); },
      },
      outbox: new RealtimeOutbox(`provider-bad-mac-${crypto.randomUUID()}`),
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    provider.setExpectedEncrypted(false);
    await connectProvider(provider);
    const remote = makeDoc("must not be merged");
    const update = Y.encodeStateAsUpdate(remote);
    const makePayload = (counter: number) => encryptRealtimePayload(update, {
      roomId: prelude.ticket.roomId,
      generation: 7,
      messageType: "y-update",
      senderId: "sender-attacker-01",
      sessionId: "session-attacker-01",
      counter,
    }, prelude.relayKey, prelude.writeMacKey);
    const missingMac = await makePayload(1);
    delete missingMac.mac;
    const invalidMac = {
      ...(await makePayload(2)),
      mac: encodeBase64Url(new Uint8Array(32)),
    };
    const receiveFrame = (payload: unknown) => JSON.stringify({
      v: CURRENT_PROTOCOL_VERSION,
      message_type: "y-update",
      opaque_room_id: prelude.ticket.roomId,
      payload,
    });
    const receive = (provider as unknown as {
      handleSocketMessage: (value: unknown) => Promise<void>;
    }).handleSocketMessage.bind(provider);

    await receive(receiveFrame(missingMac));
    await receive(receiveFrame(invalidMac));

    expect(doc.getText("content").toString()).toBe("");
    expect(provider.getPendingBytes()).toBe(0);
    await provider.destroy();
    remote.destroy();
  });

  it("does not merge a new-generation snapshot after reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const keys = await createKeyFixture();
    const oldSnapshot = bytesToBase64(Y.encodeStateAsUpdate(makeDoc("old-generation")));
    const newSnapshot = bytesToBase64(Y.encodeStateAsUpdate(makeDoc("new-generation")));
    const { prelude } = await createPrelude(keys, { generation: 7, snapshot: oldSnapshot });
    const database = `provider-generation-${crypto.randomUUID()}`;
    const outbox = new RealtimeOutbox(database);
    const issueTicket = vi.fn(async (_slug: string, sessionId: string) => createTicketBundle(
      keys,
      sessionId,
      8,
      newSnapshot,
    ));
    const api: RealtimeEdgeApi = {
      issueTicket,
      casSave: async () => { throw new Error("unexpected CAS"); },
    };
    const doc = new Y.Doc();
    const provider = new RealtimeYjsProvider("random-test-note", doc, {
      prelude,
      api,
      outbox,
      random: () => 0,
      socketFactory: (url) => new FakeWebSocket(url, prelude.ticket.roomId) as unknown as WebSocket,
    });
    provider.setExpectedEncrypted(false);
    const socket = await connectProvider(provider);
    expect(doc.getText("content").toString()).toBe("old-generation");
    socket.serverClose();
    await vi.advanceTimersByTimeAsync(1);
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    expect(issueTicket).toHaveBeenCalledTimes(1);
    expect(provider.generation).toBe(7);
    expect(doc.getText("content").toString()).toBe("old-generation");
    await provider.destroy();
  });
});
