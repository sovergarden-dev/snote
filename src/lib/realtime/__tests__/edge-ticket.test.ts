import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  encodeBase64Url,
  importEd25519VerificationKey,
  verifyProtocolJws,
} from "../protocol";
import {
  decodeStandardBase64,
  deriveOpaqueRoomId,
  deriveRelayKey,
  deriveWriteMacKey,
  issueRealtimeHealthProbeToken,
  issueRealtimeTicket,
  issueRealtimeTicketFromContext,
  loadRealtimeSigningConfig,
  mergePlainYjsSnapshot,
  savedAckForCommittedCas,
  stateVectorsEqual,
  verifyRealtimeTicketClaims,
  type RealtimeConfigInput,
  type RealtimeSigningConfig,
  type YjsAdapter,
} from "../../../../supabase/functions/_shared/realtime-edge";

const NOW = 1_800_000_000;
const base64url = (bytes: Uint8Array) => encodeBase64Url(bytes);

async function makeConfigInput(): Promise<{
  input: RealtimeConfigInput;
  ticketPair: CryptoKeyPair;
  ackPair: CryptoKeyPair;
}> {
  const [ticketPair, ackPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  ]);
  const [ticketJwk, ackJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", ticketPair.privateKey),
    crypto.subtle.exportKey("jwk", ackPair.privateKey),
  ]);
  return {
    input: {
      ticketPrivateJwk: JSON.stringify(ticketJwk),
      ticketKid: "edge-ticket-test-v1",
      savedAckPrivateJwk: JSON.stringify(ackJwk),
      savedAckKid: "edge-ack-test-v1",
      hubId: "hub-east",
      assignmentEpoch: "9",
      roomHmacKey: base64url(new Uint8Array(32).fill(11)),
      writeMacMasterKey: base64url(new Uint8Array(32).fill(23)),
      relayMasterKey: base64url(new Uint8Array(32).fill(37)),
      relayKeyKid: "relay-test-v1",
    },
    ticketPair,
    ackPair,
  };
}

async function pin(pair: CryptoKeyPair, kid: string): Promise<Readonly<Record<string, CryptoKey>>> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { [kid]: await importEd25519VerificationKey(raw) };
}

async function config(): Promise<{
  signing: RealtimeSigningConfig;
  ticketPair: CryptoKeyPair;
  ackPair: CryptoKeyPair;
}> {
  const material = await makeConfigInput();
  return {
    signing: await loadRealtimeSigningConfig(material.input),
    ticketPair: material.ticketPair,
    ackPair: material.ackPair,
  };
}

describe("Edge realtime ticket and saved-ack signing", () => {
  it("issues an EdDSA edit ticket with a random jti, current epochs, relay key and separate write key", async () => {
    const { signing, ticketPair, ackPair } = await config();
    const roomId = await deriveOpaqueRoomId(signing.roomHmacKey, "note-uuid-1", 4);
    const issued = await issueRealtimeTicket({
      roomId,
      generation: 4,
      permissionEpoch: 7,
      permission: "edit",
      sessionId: "session-01",
      nowSeconds: NOW,
    }, signing);
    const payload = await verifyProtocolJws(issued.ticket, {
      tokenType: "ticket",
      expectedAudience: "hub-east",
      nowSeconds: NOW,
      pinnedKeys: {
        ticketAndProbe: await pin(ticketPair, signing.ticketKid),
        savedAck: await pin(ackPair, signing.savedAckKid),
      },
    });

    expect(payload).toMatchObject({
      purpose: "syrin:ticket:v1",
      aud: "hub-east",
      hub_id: "hub-east",
      room_id: roomId,
      generation: 4,
      permission_epoch: 7,
      assignment_epoch: 9,
      permission: "edit",
      permissions: ["read", "write"],
      iat: NOW,
      exp: NOW + 300,
      session_id: "session-01",
      relay_key_kid: "relay-test-v1",
    });
    expect(decodeBase64Url(payload.jti as string)).toHaveLength(16);
    expect(issued.relay_key_kid).toBe("relay-test-v1");
    expect(decodeBase64Url(issued.relay_key!)).toHaveLength(32);
    expect(issued.write_mac_key).toBeTruthy();
    expect(decodeBase64Url(issued.write_mac_key!)).toHaveLength(32);
  });

  it("returns relay key but no write_mac_key for a read-only ticket", async () => {
    const { signing } = await config();
    const ticket = await issueRealtimeTicket({
      roomId: "room-read-only",
      generation: 2,
      permissionEpoch: 3,
      permission: "read",
      sessionId: "session-01",
      nowSeconds: NOW,
    }, signing);
    expect(ticket.relay_key).toBeTruthy();
    expect(ticket.relay_key_kid).toBe("relay-test-v1");
    expect(Object.hasOwn(ticket, "write_mac_key")).toBe(false);
  });

  it("binds routed tickets to a hub and room-local epoch and verifies them before report handling", async () => {
    const { signing, ticketPair, ackPair } = await config();
    const roomId = await deriveOpaqueRoomId(signing.roomHmacKey, "note-route", 8);
    const route = { hubId: "rt2", assignmentEpoch: 4, topologyEpoch: 12 };
    const issued = await issueRealtimeTicket({
      roomId,
      generation: 8,
      permissionEpoch: 3,
      permission: "edit",
      sessionId: "session-route-1",
      nowSeconds: NOW,
      routing: route,
    }, signing);
    expect(issued).toMatchObject({
      hub_id: "rt2",
      assignment_epoch: 4,
      topology_epoch: 12,
    });
    const claims = await verifyProtocolJws(issued.ticket, {
      tokenType: "ticket",
      expectedAudience: "rt2",
      nowSeconds: NOW,
      pinnedKeys: {
        ticketAndProbe: await pin(ticketPair, signing.ticketKid),
        savedAck: await pin(ackPair, signing.savedAckKid),
      },
    });
    expect(claims).toMatchObject({
      hub_id: "rt2",
      aud: "rt2",
      assignment_epoch: 4,
      topology_epoch: 12,
    });
    await expect(verifyRealtimeTicketClaims(issued.ticket, signing, NOW))
      .resolves.toMatchObject({ ok: true, claims: { assignment_epoch: 4, topology_epoch: 12 } });
    await expect(verifyRealtimeTicketClaims(issued.ticket, signing, NOW + 300))
      .resolves.toEqual({ ok: false, status: "expired" });
    const [headerPart, payloadPart, signaturePart] = issued.ticket.split(".");
    await expect(verifyRealtimeTicketClaims(
      `${headerPart}.${payloadPart}.A${signaturePart.slice(1)}`,
      signing,
      NOW,
    )).resolves.toEqual({ ok: false, status: "invalid" });
  });

  it("signs a short-lived health probe token without room, session, or JTI claims", async () => {
    const { signing } = await config();
    const token = await issueRealtimeHealthProbeToken("rt2", signing, NOW);
    const [headerPart, claimsPart, signaturePart] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerPart)));
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(claimsPart)));
    const signatureValid = await crypto.subtle.verify(
      { name: "Ed25519" },
      signing.ticketPublicKey,
      decodeBase64Url(signaturePart) as BufferSource,
      new TextEncoder().encode(`${headerPart}.${claimsPart}`),
    );
    expect(header).toMatchObject({ alg: "EdDSA", kid: signing.ticketKid, typ: "syrin-health-probe+jwt" });
    expect(claims).toMatchObject({
      purpose: "syrin:healthz:v1",
      aud: "rt2",
      hub_id: "rt2",
      iat: NOW,
      exp: NOW + 30,
    });
    expect(signatureValid).toBe(true);
    expect(claims).not.toHaveProperty("room_id");
    expect(claims).not.toHaveProperty("session_id");
    expect(claims).not.toHaveProperty("jti");
  });

  it("validates the client session binding before signing", async () => {
    const { signing } = await config();
    await expect(issueRealtimeTicket({
      roomId: "room-session",
      generation: 1,
      permissionEpoch: 0,
      permission: "read",
      sessionId: "short",
      nowSeconds: NOW,
    }, signing)).rejects.toThrow("session ID");
  });

  it("returns ticket context metadata alongside the ticket", async () => {
    const { signing } = await config();
    const result = await issueRealtimeTicketFromContext({
      status: "ok",
      noteId: "note-uuid-1",
      revision: 12,
      generation: 4,
      permissionEpoch: 7,
      ydocState: "AQID",
      sessionId: "session-01",
    }, signing, NOW);
    expect(result).toMatchObject({ ok: true, ticket: {
      noteId: "note-uuid-1", revision: 12, generation: 4,
      permissionEpoch: 7, ydocState: "AQID",
    } });
  });

  it("does not issue any ticket when the slug context is invalid or absent", async () => {
    const invalid = await issueRealtimeTicketFromContext(
      { status: "invalid" },
      {} as RealtimeSigningConfig,
      NOW,
    );
    const missing = await issueRealtimeTicketFromContext(
      { status: "not_found" },
      {} as RealtimeSigningConfig,
      NOW,
    );
    const unauthorized = await issueRealtimeTicketFromContext(
      { status: "unauthorized" },
      {} as RealtimeSigningConfig,
      NOW,
    );
    expect(invalid).toEqual({ ok: false, status: "invalid" });
    expect(missing).toEqual({ ok: false, status: "not_found" });
    expect(unauthorized).toEqual({ ok: false, status: "unauthorized" });
  });

  it("derives distinct write MAC keys by opaque room and generation", async () => {
    const masterKey = new Uint8Array(32).fill(5);
    const [roomOne, roomTwo, nextGeneration] = await Promise.all([
      deriveWriteMacKey(masterKey, "room-a", 1),
      deriveWriteMacKey(masterKey, "room-b", 1),
      deriveWriteMacKey(masterKey, "room-a", 2),
    ]);
    expect(roomOne).toHaveLength(32);
    expect(roomOne).not.toEqual(roomTwo);
    expect(roomOne).not.toEqual(nextGeneration);
  });

  it("derives distinct relay keys by room and generation, independently of the write MAC key", async () => {
    const relayMaster = new Uint8Array(32).fill(31);
    const writeMaster = new Uint8Array(32).fill(32);
    const [roomOne, roomTwo, nextGeneration, writeMacKey] = await Promise.all([
      deriveRelayKey(relayMaster, "room-a", 1),
      deriveRelayKey(relayMaster, "room-b", 1),
      deriveRelayKey(relayMaster, "room-a", 2),
      deriveWriteMacKey(writeMaster, "room-a", 1),
    ]);
    expect(roomOne).toHaveLength(32);
    expect(roomOne).not.toEqual(roomTwo);
    expect(roomOne).not.toEqual(nextGeneration);
    expect(roomOne).not.toEqual(writeMacKey);
  });

  it("fails closed when the separate relay master key or key ID is missing or reused", async () => {
    const { input } = await makeConfigInput();
    await expect(loadRealtimeSigningConfig({ ...input, relayMasterKey: "" }))
      .rejects.toThrow("Invalid realtime key configuration");
    await expect(loadRealtimeSigningConfig({ ...input, relayKeyKid: "" }))
      .rejects.toThrow("Invalid relay key ID");
    await expect(loadRealtimeSigningConfig({ ...input, relayMasterKey: input.writeMacMasterKey }))
      .rejects.toThrow("relay and write MAC master keys must be distinct");
  });

  it("rejects a shared ticket/ACK signing pair or kid", async () => {
    const { input } = await makeConfigInput();
    const shared = { ...input, savedAckPrivateJwk: input.ticketPrivateJwk };
    await expect(loadRealtimeSigningConfig(shared)).rejects.toThrow("pairs must be distinct");
    await expect(loadRealtimeSigningConfig({ ...input, savedAckKid: input.ticketKid }))
      .rejects.toThrow("key IDs must be distinct");
  });

  it("signs saved-ack over the committed vector and its SHA-256, using the separate ACK key", async () => {
    const { signing, ticketPair, ackPair } = await config();
    const response = await savedAckForCommittedCas({
      status: "ok",
      noteId: "note-uuid-2",
      generation: 5,
      revision: 12,
      permissionEpoch: 8,
      stateVectorHex: "01020304",
    }, signing, NOW);
    expect(response).toMatchObject({ status: "ok", generation: 5, revision: 12 });
    expect(response.savedAck).toBeTruthy();
    const payload = await verifyProtocolJws(response.savedAck!, {
      tokenType: "saved-ack",
      nowSeconds: NOW + 86_400,
      pinnedKeys: {
        ticketAndProbe: await pin(ticketPair, signing.ticketKid),
        savedAck: await pin(ackPair, signing.savedAckKid),
      },
    });
    const vector = new Uint8Array([1, 2, 3, 4]);
    const vectorHash = new Uint8Array(await crypto.subtle.digest("SHA-256", vector));
    expect(payload).toMatchObject({
      purpose: "syrin:saved-ack:v1",
      room_id: response.roomId,
      generation: 5,
      revision: 12,
      permission_epoch: 8,
      state_vector: encodeBase64Url(vector),
      state_vector_hash: encodeBase64Url(vectorHash),
    });
    expect(payload).not.toHaveProperty("exp");
  });

  it("never signs an ACK for any non-committed CAS result", async () => {
    for (const status of [
      "capability_managed",
      "not_found",
      "stale_permission_epoch",
      "invalid_mac",
      "invalid_state_vector",
      "version_conflict",
    ]) {
      const result = await savedAckForCommittedCas(
        { status },
        {} as RealtimeSigningConfig,
        NOW,
      );
      expect(result).toEqual({ status });
      expect(result).not.toHaveProperty("savedAck");
    }
  });

  it("merges plaintext Yjs snapshots and lets the Edge compare the canonical vector", () => {
    const first = new Y.Doc();
    first.getText("content").insert(0, "first");
    const stored = Y.encodeStateAsUpdate(first);
    const client = new Y.Doc();
    Y.applyUpdate(client, stored);
    client.getText("content").insert(5, " update");
    const incoming = Y.encodeStateAsUpdate(client);
    const requestedVector = Y.encodeStateVector(client);
    const result = mergePlainYjsSnapshot(
      stored,
      incoming,
      Y as unknown as YjsAdapter,
    );
    expect(result.content).toBe("first update");
    expect(result.payload).toEqual(incoming);
    expect(stateVectorsEqual(result.stateVector, requestedVector)).toBe(true);
    expect(stateVectorsEqual(result.stateVector, new Uint8Array([0]))).toBe(false);
    first.destroy();
    client.destroy();
  });

  it("accepts canonical standard base64 snapshots only", () => {
    expect(decodeStandardBase64("YQ==", 4)).toEqual(new Uint8Array([97]));
    expect(decodeStandardBase64("", 4)).toEqual(new Uint8Array());
    expect(() => decodeStandardBase64("YQ", 4)).toThrow();
    expect(() => decodeStandardBase64("YQ==$", 4)).toThrow();
  });
});
