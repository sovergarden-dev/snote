import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { FRAME_VECTOR } from "../../__tests__/test-vectors";
import { MAX_REALTIME_FRAME_BYTES } from "../../protocol";
import { RelayCore, HUB_CLOSE_CODES, type HubRuntimeConfig, type HubSocketAttachment, type HubSocketPeer } from "../relay-core";
import { SqliteReplayStore, HUB_REPLAY_TABLE } from "../replay-store";
import { bunSqliteDriver } from "./bun-sqlite-driver";
import { ManualClock } from "./manual-clock";
import { authFrame, createTestSigningKeys, relayFrame, TEST_HUB_ID, TEST_NOW_SECONDS, TEST_ROOM_ID } from "./test-crypto";

class FakePeer implements HubSocketPeer {
  open = true;
  attachment: unknown;
  sent: string[] = [];
  closeCode?: number;
  closeReason?: string;

  isOpen(): boolean {
    return this.open;
  }

  getAttachment(): unknown {
    return this.attachment;
  }

  setAttachment(attachment: HubSocketAttachment): void {
    this.attachment = structuredClone(attachment);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    this.open = false;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

const encoder = new TextEncoder();
const databases: Database[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

async function setup() {
  const database = new Database(":memory:");
  databases.push(database);
  const keys = await createTestSigningKeys();
  const clock = new ManualClock(TEST_NOW_SECONDS);
  const store = new SqliteReplayStore(bunSqliteDriver(database));
  const config: HubRuntimeConfig = { hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock };
  return { database, keys, clock, store, core: new RelayCore(config, store) };
}

async function authenticate(
  core: RelayCore,
  peer: FakePeer,
  ticket: string,
  roomId = TEST_ROOM_ID,
  sessionId = "session-01",
  roomPeers: FakePeer[] = [peer],
): Promise<void> {
  await core.handleFrame(peer, roomId, encoder.encode(authFrame(ticket, sessionId, roomId)), roomPeers);
}

describe("shared relay core contracts", () => {
  it("requires the ticket in the first text frame and never accepts a later auth frame", async () => {
    const { core, keys } = await setup();
    const peer = new FakePeer();
    await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 })), [peer]);
    expect(peer.open).toBe(false);
    expect(peer.closeCode).toBe(1008);

    const secondPeer = new FakePeer();
    const ticket = await keys.signTicket();
    await authenticate(core, secondPeer, ticket);
    await core.handleFrame(
      secondPeer,
      TEST_ROOM_ID,
      encoder.encode(authFrame(await keys.signTicket(), "session-01")),
      [secondPeer],
    );
    expect(secondPeer.open).toBe(false);
    expect(secondPeer.closeReason).toBe("authentication frame already used");
  });

  it("requires the shared v2 vector, ignores unauthenticated role/slug fields, and relays its exact bytes", async () => {
    const { core, keys } = await setup();
    const editor = new FakePeer();
    const viewer = new FakePeer();
    await authenticate(core, editor, await keys.signTicket({ permission: "edit", permissions: ["read", "write"], session_id: "sender-01" }), TEST_ROOM_ID, "sender-01", [editor, viewer]);
    await authenticate(core, viewer, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-02" }), TEST_ROOM_ID, "session-02", [editor, viewer]);
    editor.sent = [];
    viewer.sent = [];

    await core.handleFrame(editor, TEST_ROOM_ID, encoder.encode(FRAME_VECTOR.wireText), [editor, viewer]);

    expect(viewer.sent).toEqual([FRAME_VECTOR.wireText]);
    expect(viewer.sent[0]).toBe(FRAME_VECTOR.wireText);
  });

  it("rejects an initial auth payload whose session differs from the signed claim", async () => {
    const { core, keys } = await setup();
    const peer = new FakePeer();
    await authenticate(core, peer, await keys.signTicket({ session_id: "session-02" }), TEST_ROOM_ID, "session-01");
    expect(peer.open).toBe(false);
    expect(peer.closeCode).toBe(HUB_CLOSE_CODES.policy);
  });

  it("binds a verified ticket to its pinned-key audience, hub ID, and requested room before consuming JTI", async () => {
    const { core, keys, database } = await setup();
    const invalidTickets = [
      await keys.signTicket({ aud: "another-hub" }),
      await keys.signTicket({ hub_id: "another-hub" }),
      await keys.signTicket({ room_id: "another-room" }),
    ];
    for (const ticket of invalidTickets) {
      const peer = new FakePeer();
      await authenticate(core, peer, ticket);
      expect(peer.open).toBe(false);
      expect(peer.closeCode).toBe(HUB_CLOSE_CODES.policy);
    }
    const replayTable = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(HUB_REPLAY_TABLE);
    expect(replayTable).toBeNull();
  });

  it("atomically accepts one connection for a duplicated ticket JTI", async () => {
    const { core, keys } = await setup();
    const ticket = await keys.signTicket({ jti: "same-ticket-jti-value" });
    const first = new FakePeer();
    const second = new FakePeer();
    await Promise.all([
      authenticate(core, first, ticket),
      authenticate(core, second, ticket),
    ]);
    expect([first.open, second.open].filter(Boolean)).toHaveLength(1);
    expect([first.closeCode, second.closeCode].filter((code) => code === HUB_CLOSE_CODES.policy)).toHaveLength(1);
  });

  it("rejects expired tickets, blocks relays at exp, and permits only a fresh same-session renewal", async () => {
    const { core, keys, clock } = await setup();
    const expiredPeer = new FakePeer();
    const expiredTicket = await keys.signTicket({
      jti: "already-expired-ticket-jti",
      iat: TEST_NOW_SECONDS - 30,
      exp: TEST_NOW_SECONDS - 1,
    });
    await authenticate(core, expiredPeer, expiredTicket);
    expect(expiredPeer.open).toBe(false);
    expect(expiredPeer.closeCode).toBe(HUB_CLOSE_CODES.policy);

    const expiringPeer = new FakePeer();
    const shortTicket = await keys.signTicket({
      jti: "expires-while-socket-open-jti",
      exp: TEST_NOW_SECONDS + 1,
    });
    await authenticate(core, expiringPeer, shortTicket);
    clock.advanceMilliseconds(1_000);
    await core.handleFrame(
      expiringPeer,
      TEST_ROOM_ID,
      encoder.encode(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 })),
      [expiringPeer],
    );
    expect(expiringPeer.open).toBe(false);
    expect(expiringPeer.closeCode).toBe(HUB_CLOSE_CODES.policy);

    const renewablePeer = new FakePeer();
    const expiringButStillValid = await keys.signTicket({
      jti: "expires-before-renewal-jti",
      iat: TEST_NOW_SECONDS + 1,
      exp: TEST_NOW_SECONDS + 2,
    });
    await authenticate(core, renewablePeer, expiringButStillValid);
    clock.advanceMilliseconds(1_000);
    const freshRenewal = await keys.signTicket({
      jti: "fresh-renewal-jti-after-exp",
      iat: TEST_NOW_SECONDS + 2,
      exp: TEST_NOW_SECONDS + 302,
    });
    await core.handleFrame(renewablePeer, TEST_ROOM_ID, encoder.encode(relayFrame("ticket-renewal", {
      ticket: freshRenewal,
      session_id: "session-01",
      counter: 1,
    })), [renewablePeer]);
    expect(renewablePeer.open).toBe(true);
    expect((renewablePeer.attachment as HubSocketAttachment).ticket_expires_at).toBe(TEST_NOW_SECONDS + 302);
  });

  it("blocks viewers from updates and save commands regardless of payload role fields", async () => {
    const { core, keys } = await setup();
    const viewer = new FakePeer();
    const recipient = new FakePeer();
    await authenticate(core, viewer, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-01" }), TEST_ROOM_ID, "session-01", [viewer, recipient]);
    await authenticate(core, recipient, await keys.signTicket({ permission: "edit", permissions: ["read", "write"], session_id: "session-02" }), TEST_ROOM_ID, "session-02", [viewer, recipient]);

    await core.handleFrame(viewer, TEST_ROOM_ID, encoder.encode(JSON.stringify({
      v: 2,
      message_type: "y-update",
      opaque_room_id: TEST_ROOM_ID,
      payload: { ciphertext: "AAECAw" },
      role: "edit",
    })), [viewer, recipient]);
    expect(viewer.open).toBe(false);
    expect(recipient.sent).toHaveLength(1);

    const saveViewer = new FakePeer();
    await authenticate(core, saveViewer, await keys.signTicket({ permission: "read", permissions: ["read"] }));
    await core.handleFrame(saveViewer, TEST_ROOM_ID, encoder.encode(relayFrame("save", { ciphertext: "AAECAw" })), [saveViewer]);
    expect(saveViewer.open).toBe(false);
  });

  it("requires renewal to advance the attachment counter, preserve session/room epochs, and never consume JTI", async () => {
    const { core, keys, database } = await setup();
    const peer = new FakePeer();
    await authenticate(core, peer, await keys.signTicket({ jti: "initial-ticket-jti-0001" }));
    const renewalTicket = await keys.signTicket({ jti: "renewal-ticket-jti-0001", permission_epoch: 8 });
    const renewal = () => relayFrame("ticket-renewal", {
      ticket: renewalTicket,
      session_id: "session-01",
      counter: 1,
    });
    await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(renewal()), [peer]);
    expect((peer.attachment as HubSocketAttachment).renewal_counter).toBe(1);
    expect((peer.attachment as HubSocketAttachment).permission_epoch).toBe(8);
    const initialRows = database.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE}`).get() as { count: number };
    expect(initialRows.count).toBe(1);

    await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(renewal()), [peer]);
    expect(peer.open).toBe(false);
    const rowsAfterReplay = database.query(`SELECT COUNT(*) AS count FROM ${HUB_REPLAY_TABLE}`).get() as { count: number };
    expect(rowsAfterReplay.count).toBe(1);
  });

  it("rejects a renewal for the wrong session, counter, room, generation, assignment, or older permission epoch", async () => {
    const cases = [
      { session_id: "other-sess", counter: 1, overrides: {} },
      { session_id: "session-01", counter: 2, overrides: {} },
      { session_id: "session-01", counter: 1, overrides: { room_id: "other-room" } },
      { session_id: "session-01", counter: 1, overrides: { generation: 4 } },
      { session_id: "session-01", counter: 1, overrides: { assignment_epoch: 5 } },
      { session_id: "session-01", counter: 1, overrides: { permission_epoch: 6 } },
    ];
    for (const testCase of cases) {
      const { core, keys } = await setup();
      const peer = new FakePeer();
      await authenticate(core, peer, await keys.signTicket({ jti: `initial-jti-${Math.random()}` }));
      const renewalTicket = await keys.signTicket({
        jti: `renewal-jti-${Math.random()}`,
        ...testCase.overrides,
      });
      await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(relayFrame("ticket-renewal", {
        ticket: renewalTicket,
        session_id: testCase.session_id,
        counter: testCase.counter,
      })), [peer]);
      expect(peer.open).toBe(false);
    }
  });

  it("forwards only Edge-signed saved ACKs scoped to the same room and generation", async () => {
    const { core, keys } = await setup();
    const sender = new FakePeer();
    const recipient = new FakePeer();
    await authenticate(core, sender, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-01" }), TEST_ROOM_ID, "session-01", [sender, recipient]);
    await authenticate(core, recipient, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-02" }), TEST_ROOM_ID, "session-02", [sender, recipient]);
    const ack = await keys.signSavedAck();
    const ackFrame = relayFrame("saved-ack", { savedAck: ack });
    sender.sent = [];
    recipient.sent = [];
    await core.handleFrame(sender, TEST_ROOM_ID, encoder.encode(ackFrame), [sender, recipient]);
    expect(recipient.sent).toEqual([ackFrame]);

    const invalidSender = new FakePeer();
    const invalidRecipient = new FakePeer();
    await authenticate(core, invalidSender, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-03" }), TEST_ROOM_ID, "session-03", [invalidSender, invalidRecipient]);
    await authenticate(core, invalidRecipient, await keys.signTicket({ permission: "read", permissions: ["read"], session_id: "session-04" }), TEST_ROOM_ID, "session-04", [invalidSender, invalidRecipient]);
    const fakeAck = await keys.signTicket({ purpose: "syrin:saved-ack:v1", room_id: TEST_ROOM_ID, generation: 3 });
    await core.handleFrame(invalidSender, TEST_ROOM_ID, encoder.encode(relayFrame("saved-ack", { savedAck: fakeAck })), [invalidSender, invalidRecipient]);
    expect(invalidSender.open).toBe(false);
    expect(invalidRecipient.sent).toHaveLength(1);
  });

  it("checks the raw frame size before JSON parsing and accepts only the previous/current versions", async () => {
    const { core, keys } = await setup();
    const tooLargePeer = new FakePeer();
    await core.handleFrame(tooLargePeer, TEST_ROOM_ID, new Uint8Array(MAX_REALTIME_FRAME_BYTES + 1), [tooLargePeer]);
    expect(tooLargePeer.closeCode).toBe(HUB_CLOSE_CODES.tooLarge);

    const peer = new FakePeer();
    await authenticate(core, peer, await keys.signTicket(), TEST_ROOM_ID, "session-01", [peer]);
    peer.sent = [];
    await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 }, TEST_ROOM_ID, 1)), [peer]);
    expect(peer.open).toBe(true);
    await core.handleFrame(peer, TEST_ROOM_ID, encoder.encode(relayFrame("presence", { ciphertext: "AAECAw", sender_id: "session-01", session_id: "session-01", counter: 1 }, TEST_ROOM_ID, 0)), [peer]);
    expect(peer.open).toBe(false);
  });

  it("fails closed when durable replay storage is unavailable", async () => {
    const { keys, clock } = await setup();
    const failingCore = new RelayCore({ hubId: TEST_HUB_ID, pinnedKeys: keys.pinnedKeys, clock }, {
      async consumeJti() { throw new Error("synthetic storage failure"); },
    });
    const peer = new FakePeer();
    await authenticate(failingCore, peer, await keys.signTicket());
    expect(peer.open).toBe(false);
    expect(peer.closeCode).toBe(HUB_CLOSE_CODES.internal);
  });
});
