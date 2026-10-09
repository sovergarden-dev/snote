import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  buildCasSaveMacInput,
  computeHmacSha256,
  encodeBase64Url,
  importEd25519VerificationKey,
  importHmacSha256Key,
  verifyProtocolJws,
} from "../protocol";
import {
  deriveOpaqueRoomId,
  deriveWriteMacKey,
  encodeStandardBase64,
  loadRealtimeSigningConfig,
  mergePlainYjsSnapshot,
  type RealtimeSigningConfig,
  type YjsAdapter,
} from "../../../../supabase/functions/_shared/realtime-edge";
import {
  handleRealtimeCasRequest,
  type RealtimeCasHandlerDependencies,
} from "../../../../supabase/functions/note-session/realtime-cas-handler";
import { encryptBytes } from "../../crypto";

const NOTE_ID = "f49c87a3-1bdf-4d1b-9d45-6e8c9cf2b21a";
const SLUG = "handler-regression";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = 4;
const PERMISSION_EPOCH = 3;
const REVISION = 7;

async function makeSigningFixture(): Promise<{
  signing: RealtimeSigningConfig;
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
    signing: await loadRealtimeSigningConfig({
      ticketPrivateJwk: JSON.stringify(ticketJwk),
      ticketKid: "handler-ticket-key-v1",
      savedAckPrivateJwk: JSON.stringify(ackJwk),
      savedAckKid: "handler-ack-key-v1",
      hubId: "hub-east",
      assignmentEpoch: "9",
      roomHmacKey: encodeBase64Url(new Uint8Array(32).fill(11)),
      writeMacMasterKey: encodeBase64Url(new Uint8Array(32).fill(23)),
      relayMasterKey: encodeBase64Url(new Uint8Array(32).fill(37)),
      relayKeyKid: "handler-relay-key-v1",
    }),
    ticketPair,
    ackPair,
  };
}

async function pin(pair: CryptoKeyPair, kid: string): Promise<Readonly<Record<string, CryptoKey>>> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { [kid]: await importEd25519VerificationKey(raw) };
}

function byteaHex(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function failureResponse(status: string): Response {
  const httpStatus = status === "unauthorized" ? 401 : status === "invalid_state" ? 409 : 503;
  return jsonResponse({ error: status, code: status }, httpStatus);
}

async function clientMac(input: {
  signing: RealtimeSigningConfig;
  payload: Uint8Array;
  stateVector: Uint8Array;
  expectedRevision: number;
  generation: number;
}): Promise<Uint8Array> {
  const roomId = await deriveOpaqueRoomId(input.signing.roomHmacKey, NOTE_ID, input.generation);
  const writeMacKey = await deriveWriteMacKey(
    input.signing.writeMacMasterKey,
    roomId,
    input.generation,
  );
  const macInput = await buildCasSaveMacInput({
    opaqueRoomId: roomId,
    generation: input.generation,
    expectedRevision: input.expectedRevision,
    payload: input.payload,
    permissionEpoch: PERMISSION_EPOCH,
    stateVector: input.stateVector,
  });
  return computeHmacSha256(await importHmacSha256Key(writeMacKey), macInput);
}

function makePlainClientUpdate(concurrentServerUpdate = false): {
  storedBytes: Uint8Array;
  incomingBytes: Uint8Array;
  stateVector: Uint8Array;
  mergedBytes: Uint8Array;
} {
  const base = new Y.Doc();
  const client = new Y.Doc();
  const server = new Y.Doc();
  try {
    base.getText("content").insert(0, "seed");
    const baseSnapshot = Y.encodeStateAsUpdate(base);
    const baseVector = Y.encodeStateVector(base);

    Y.applyUpdate(client, baseSnapshot);
    client.getText("content").insert(4, " client");
    const incomingBytes = Y.encodeStateAsUpdate(client, baseVector);
    const stateVector = Y.encodeStateVector(client);

    let storedBytes = baseSnapshot;
    if (concurrentServerUpdate) {
      Y.applyUpdate(server, baseSnapshot);
      server.getText("content").insert(4, " server");
      storedBytes = Y.encodeStateAsUpdate(server);
    }
    const merged = mergePlainYjsSnapshot(
      storedBytes,
      incomingBytes,
      Y as unknown as YjsAdapter,
    );
    return {
      storedBytes,
      incomingBytes,
      stateVector,
      mergedBytes: merged.payload,
    };
  } finally {
    base.destroy();
    client.destroy();
    server.destroy();
  }
}

async function makeEncryptedClientPayload(): Promise<{
  storedBytes: Uint8Array;
  incomingBytes: Uint8Array;
  stateVector: Uint8Array;
}> {
  const storedDoc = new Y.Doc();
  const clientDoc = new Y.Doc();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  try {
    storedDoc.getText("content").insert(0, "seed");
    const storedSnapshot = Y.encodeStateAsUpdate(storedDoc);
    Y.applyUpdate(clientDoc, storedSnapshot);
    clientDoc.getText("content").insert(4, " encrypted");
    const stateVector = Y.encodeStateVector(clientDoc);
    const incomingSnapshot = Y.encodeStateAsUpdate(clientDoc);
    return {
      storedBytes: await encryptBytes(key, storedSnapshot),
      incomingBytes: await encryptBytes(key, incomingSnapshot),
      stateVector,
    };
  } finally {
    storedDoc.destroy();
    clientDoc.destroy();
  }
}

function makeDependencies(input: {
  signing: RealtimeSigningConfig;
  storedBytes: Uint8Array;
  isEncrypted: boolean;
  currentRevision?: number;
  currentGeneration?: number;
}): {
  dependencies: RealtimeCasHandlerDependencies;
  rpc: ReturnType<typeof vi.fn>;
  getWrites: () => number;
  getSaveArgs: () => Record<string, unknown> | undefined;
  getStoredBytes: () => string;
} {
  const currentRevision = input.currentRevision ?? REVISION;
  const currentGeneration = input.currentGeneration ?? GENERATION;
  let writes = 0;
  let storedBytes = encodeStandardBase64(input.storedBytes);
  let saveArgs: Record<string, unknown> | undefined;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "capability_note_realtime_ticket_context") {
      return {
        data: {
          status: "ok",
          noteId: NOTE_ID,
          revision: currentRevision,
          generation: currentGeneration,
          permissionEpoch: PERMISSION_EPOCH,
          isEncrypted: input.isEncrypted,
          ydocState: storedBytes,
        },
        error: null,
      };
    }
    if (name !== "capability_note_realtime_save") {
      return { data: null, error: new Error(`unexpected RPC ${name}`) };
    }

    saveArgs = args;
    if (args.p_permission_epoch !== PERMISSION_EPOCH) {
      return { data: { status: "stale_permission_epoch" }, error: null };
    }
    if (args.p_expected_mac !== args.p_presented_mac) {
      return { data: { status: "invalid_mac" }, error: null };
    }
    if (args.p_generation !== currentGeneration) {
      return { data: { status: "generation_conflict" }, error: null };
    }
    if (args.p_expected_revision !== currentRevision) {
      return {
        data: { status: "version_conflict", revision: currentRevision, generation: currentGeneration },
        error: null,
      };
    }
    if (args.p_state_vector_matches !== true) {
      return { data: { status: "invalid_state_vector" }, error: null };
    }

    writes += 1;
    storedBytes = String(args.p_ydoc_state);
    const nextGeneration = args.p_replace_generation === true
      ? currentGeneration + 1
      : currentGeneration;
    return {
      data: {
        status: "ok",
        noteId: NOTE_ID,
        revision: currentRevision + 1,
        generation: nextGeneration,
        permissionEpoch: PERMISSION_EPOCH,
        stateVectorHex: String(args.p_state_vector).slice(2),
      },
      error: null,
    };
  });

  return {
    dependencies: {
      rpc,
      verifyRealtimeAuth: vi.fn(async () => ({ mode: "private-realtime", userId: USER_ID })),
      realtimeSigningConfig: async () => input.signing,
      capabilityJson: jsonResponse,
      capabilityFailure: failureResponse,
    },
    rpc,
    getWrites: () => writes,
    getSaveArgs: () => saveArgs,
    getStoredBytes: () => storedBytes,
  };
}

async function invokeHandler(input: {
  action: "realtime-cas-save" | "realtime-replace";
  signing: RealtimeSigningConfig;
  storedBytes: Uint8Array;
  incomingBytes: Uint8Array;
  stateVector: Uint8Array;
  isEncrypted: boolean;
  expectedRevision?: number;
  currentRevision?: number;
  generation?: number;
  currentGeneration?: number;
  mac?: Uint8Array;
}) {
  const expectedRevision = input.expectedRevision ?? REVISION;
  const generation = input.generation ?? GENERATION;
  const mac = input.mac ?? await clientMac({
    signing: input.signing,
    payload: input.incomingBytes,
    stateVector: input.stateVector,
    expectedRevision,
    generation,
  });
  const metadata = input.isEncrypted
    ? { salt: "s".repeat(16), check: "c".repeat(16), iterations: 100_000 }
    : { salt: null, check: null, iterations: null };
  const body = {
    action: input.action,
    slug: SLUG,
    ydocState: encodeStandardBase64(input.incomingBytes),
    stateVector: encodeBase64Url(input.stateVector),
    mac: encodeBase64Url(mac),
    expectedRevision,
    generation,
    permissionEpoch: PERMISSION_EPOCH,
    isEncrypted: input.isEncrypted,
    ...metadata,
  };
  const backend = makeDependencies({
    signing: input.signing,
    storedBytes: input.storedBytes,
    isEncrypted: input.isEncrypted,
    currentRevision: input.currentRevision,
    currentGeneration: input.currentGeneration,
  });
  const request = new Request("https://edge.test/functions/v1/note-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleRealtimeCasRequest(request, body, SLUG, backend.dependencies);
  return { response, backend, body };
}

async function verifyAck(
  token: string,
  input: { ticketPair: CryptoKeyPair; ackPair: CryptoKeyPair; signing: RealtimeSigningConfig },
) {
  return verifyProtocolJws(token, {
    tokenType: "saved-ack",
    nowSeconds: Math.floor(Date.now() / 1000) + 86_400,
    pinnedKeys: {
      ticketAndProbe: await pin(input.ticketPair, input.signing.ticketKid),
      savedAck: await pin(input.ackPair, input.signing.savedAckKid),
    },
  });
}

describe("note-session realtime CAS HTTP handler", () => {
  it("uses client-sent bytes for plaintext MAC and verifies the committed saved-ack", async () => {
    const keys = await makeSigningFixture();
    const client = makePlainClientUpdate();
    expect(client.mergedBytes).not.toEqual(client.incomingBytes);

    const { response, backend } = await invokeHandler({
      action: "realtime-cas-save",
      signing: keys.signing,
      storedBytes: client.storedBytes,
      incomingBytes: client.incomingBytes,
      stateVector: client.stateVector,
      isEncrypted: false,
    });
    expect(response.status).toBe(200);
    expect(backend.getWrites()).toBe(1);
    const saveArgs = backend.getSaveArgs()!;
    const expectedMac = await clientMac({
      signing: keys.signing,
      payload: client.incomingBytes,
      stateVector: client.stateVector,
      expectedRevision: REVISION,
      generation: GENERATION,
    });
    expect(saveArgs.p_expected_mac).toBe(byteaHex(expectedMac));
    expect(saveArgs.p_presented_mac).toBe(byteaHex(expectedMac));
    expect(saveArgs.p_ydoc_state).toBe(encodeStandardBase64(client.mergedBytes));
    expect(saveArgs.p_state_vector_matches).toBe(true);

    const responseBody = await response.json();
    const ack = await verifyAck(responseBody.savedAck, keys);
    expect(ack).toMatchObject({
      purpose: "syrin:saved-ack:v1",
      room_id: responseBody.roomId,
      generation: GENERATION,
      revision: REVISION + 1,
      permission_epoch: PERMISSION_EPOCH,
      state_vector: encodeBase64Url(client.stateVector),
    });
    expect(ack).not.toHaveProperty("exp");
  });

  it("uses the encrypted client payload, increments replacement generation, and verifies ACK with the ACK key", async () => {
    const keys = await makeSigningFixture();
    const client = await makeEncryptedClientPayload();
    const { response, backend } = await invokeHandler({
      action: "realtime-replace",
      signing: keys.signing,
      storedBytes: client.storedBytes,
      incomingBytes: client.incomingBytes,
      stateVector: client.stateVector,
      isEncrypted: true,
    });
    expect(response.status).toBe(200);
    expect(backend.getWrites()).toBe(1);
    const saveArgs = backend.getSaveArgs()!;
    const expectedMac = await clientMac({
      signing: keys.signing,
      payload: client.incomingBytes,
      stateVector: client.stateVector,
      expectedRevision: REVISION,
      generation: GENERATION,
    });
    expect(saveArgs.p_expected_mac).toBe(byteaHex(expectedMac));
    expect(saveArgs.p_presented_mac).toBe(byteaHex(expectedMac));
    expect(saveArgs.p_ydoc_state).toBe(encodeStandardBase64(client.incomingBytes));
    expect(saveArgs.p_replace_generation).toBe(true);

    const responseBody = await response.json();
    const ack = await verifyAck(responseBody.savedAck, keys);
    expect(ack).toMatchObject({
      purpose: "syrin:saved-ack:v1",
      room_id: responseBody.roomId,
      generation: GENERATION + 1,
      revision: REVISION + 1,
      permission_epoch: PERMISSION_EPOCH,
      state_vector: encodeBase64Url(client.stateVector),
    });
    expect(ack).not.toHaveProperty("exp");
  });

  it("returns 401 and does not write or ACK when the client MAC is wrong", async () => {
    const keys = await makeSigningFixture();
    const client = makePlainClientUpdate();
    const { response, backend } = await invokeHandler({
      action: "realtime-cas-save",
      signing: keys.signing,
      storedBytes: client.storedBytes,
      incomingBytes: client.incomingBytes,
      stateVector: client.stateVector,
      isEncrypted: false,
      mac: new Uint8Array(32).fill(0),
    });
    expect(response.status).toBe(401);
    const errorBody = await response.json();
    expect(errorBody).toMatchObject({ code: "INVALID_MAC" });
    expect(errorBody).not.toHaveProperty("savedAck");
    expect(backend.getWrites()).toBe(0);
    expect(backend.getStoredBytes()).toBe(encodeStandardBase64(client.storedBytes));
  });

  it("returns version_conflict, not invalid_mac, when the snapshot changed after client read", async () => {
    const keys = await makeSigningFixture();
    const staleClient = makePlainClientUpdate(true);
    const { response, backend } = await invokeHandler({
      action: "realtime-cas-save",
      signing: keys.signing,
      storedBytes: staleClient.storedBytes,
      incomingBytes: staleClient.incomingBytes,
      stateVector: staleClient.stateVector,
      isEncrypted: false,
      expectedRevision: REVISION,
      currentRevision: REVISION + 1,
    });
    expect(response.status).toBe(409);
    const errorBody = await response.json();
    expect(errorBody).toMatchObject({ code: "version_conflict" });
    expect(errorBody).not.toHaveProperty("savedAck");
    expect(backend.getSaveArgs()?.p_expected_mac).toBe(backend.getSaveArgs()?.p_presented_mac);
    expect(backend.getSaveArgs()?.p_state_vector_matches).toBe(false);
    expect(backend.getWrites()).toBe(0);
    expect(backend.getStoredBytes()).toBe(encodeStandardBase64(staleClient.storedBytes));
  });
});
