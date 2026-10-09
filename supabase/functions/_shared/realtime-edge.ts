import {
  buildCasSaveMacInput,
  computeHmacSha256,
  decodeBase64Url,
  encodeBase64Url,
  encodeCanonicalTuple,
  importHmacSha256Key,
} from "../../../src/lib/realtime/protocol.ts";

const utf8 = new TextEncoder();
const MAX_TICKET_TTL_SECONDS = 300;
const WRITE_MAC_HKDF_SALT = utf8.encode("syrin:realtime:write-mac-key:salt:v1");
const WRITE_MAC_HKDF_LABEL = "syrin:realtime:write-mac-key:v1";
const ROOM_ID_LABEL = "syrin:realtime:opaque-room-id:v1";

export type RealtimePermission = "read" | "edit";

export interface RealtimeSigningConfig {
  ticketPrivateKey: CryptoKey;
  ticketKid: string;
  savedAckPrivateKey: CryptoKey;
  savedAckKid: string;
  hubId: string;
  assignmentEpoch: number;
  roomHmacKey: Uint8Array;
  writeMacMasterKey: Uint8Array;
}

export interface RealtimeConfigInput {
  ticketPrivateJwk: string;
  ticketKid: string;
  savedAckPrivateJwk: string;
  savedAckKid: string;
  hubId: string;
  assignmentEpoch: string;
  roomHmacKey: string;
  writeMacMasterKey: string;
}

export interface RealtimeTicketContext {
  status: string;
  noteId?: string;
  generation?: number;
  permissionEpoch?: number;
}

export interface RealtimeTicket {
  ticket: string;
  roomId: string;
  write_mac_key?: string;
}

export interface YDocLike {
  getText(name: string): { toString(): string };
  destroy?(): void;
}

export interface YjsAdapter {
  Doc: new () => YDocLike;
  applyUpdate(doc: YDocLike, update: Uint8Array): void;
  encodeStateAsUpdate(doc: YDocLike): Uint8Array;
  encodeStateVector(doc: YDocLike): Uint8Array;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) fail(`Invalid ${name}`);
}

function assertSafeNonNegativeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`Invalid ${name}`);
  }
}

function assertSafePositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`Invalid ${name}`);
  }
}

function bytesFromHex(value: string): Uint8Array {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(value)) {
    fail("Invalid committed state vector");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function jsonSegment(value: unknown): string {
  return encodeBase64Url(utf8.encode(JSON.stringify(value)));
}

async function signJws(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
  typ: "syrin-ticket+jwt" | "syrin-saved-ack+jwt",
): Promise<string> {
  assertNonEmptyString(kid, "JWS key ID");
  if (privateKey.type !== "private" || privateKey.algorithm.name !== "Ed25519") {
    fail("Invalid Ed25519 signing key");
  }
  const protectedHeader = jsonSegment({ alg: "EdDSA", kid, typ });
  const body = jsonSegment(payload);
  const signingInput = `${protectedHeader}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    utf8.encode(signingInput) as BufferSource,
  ));
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

async function importPrivateEd25519Jwk(serialized: string): Promise<{ key: CryptoKey; x: string }> {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(serialized) as JsonWebKey;
  } catch {
    return fail("Invalid realtime signing configuration");
  }
  if (
    jwk.kty !== "OKP"
    || jwk.crv !== "Ed25519"
    || typeof jwk.d !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)
    || typeof jwk.x !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x)
  ) return fail("Invalid realtime signing configuration");
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    return { key, x: jwk.x };
  } catch {
    return fail("Invalid realtime signing configuration");
  }
}

function readSecret(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch {
    return fail("Invalid realtime key configuration");
  }
  if (bytes.byteLength < 32) fail("Invalid realtime key configuration");
  return bytes;
}

export async function loadRealtimeSigningConfig(
  input: RealtimeConfigInput,
): Promise<RealtimeSigningConfig> {
  for (const [value, name] of [
    [input.ticketKid, "ticket key ID"],
    [input.savedAckKid, "saved-ack key ID"],
    [input.hubId, "hub ID"],
  ] as const) assertNonEmptyString(value, name);
  if (input.ticketKid === input.savedAckKid) fail("Realtime signing key IDs must be distinct");
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.ticketKid)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.savedAckKid)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.hubId)) {
    fail("Invalid realtime key configuration");
  }
  if (!/^\d+$/u.test(input.assignmentEpoch)) fail("Invalid assignment epoch");
  const assignmentEpoch = Number(input.assignmentEpoch);
  assertSafeNonNegativeInteger(assignmentEpoch, "assignment epoch");

  const [ticket, savedAck] = await Promise.all([
    importPrivateEd25519Jwk(input.ticketPrivateJwk),
    importPrivateEd25519Jwk(input.savedAckPrivateJwk),
  ]);
  if (ticket.x === savedAck.x) fail("Realtime signing key pairs must be distinct");

  return {
    ticketPrivateKey: ticket.key,
    ticketKid: input.ticketKid,
    savedAckPrivateKey: savedAck.key,
    savedAckKid: input.savedAckKid,
    hubId: input.hubId,
    assignmentEpoch,
    roomHmacKey: readSecret(input.roomHmacKey),
    writeMacMasterKey: readSecret(input.writeMacMasterKey),
  };
}

export async function deriveOpaqueRoomId(
  roomHmacKey: Uint8Array,
  noteId: string,
  generation: number,
): Promise<string> {
  assertNonEmptyString(noteId, "note ID");
  assertSafePositiveInteger(generation, "generation");
  const key = await importHmacSha256Key(roomHmacKey);
  const input = encodeCanonicalTuple(ROOM_ID_LABEL, [noteId, generation]);
  return encodeBase64Url(await computeHmacSha256(key, input));
}

export async function deriveWriteMacKey(
  masterKey: Uint8Array,
  roomId: string,
  generation: number,
): Promise<Uint8Array> {
  if (!(masterKey instanceof Uint8Array) || masterKey.byteLength < 32) {
    fail("Invalid write MAC master key");
  }
  assertNonEmptyString(roomId, "room ID");
  assertSafePositiveInteger(generation, "generation");
  const key = await crypto.subtle.importKey(
    "raw",
    masterKey as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const info = encodeCanonicalTuple(WRITE_MAC_HKDF_LABEL, [roomId, generation]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: WRITE_MAC_HKDF_SALT, info: info as BufferSource },
    key,
    256,
  ));
}

export async function issueRealtimeTicket(
  input: {
    roomId: string;
    generation: number;
    permissionEpoch: number;
    permission: RealtimePermission;
    nowSeconds?: number;
    ttlSeconds?: number;
  },
  config: RealtimeSigningConfig,
): Promise<RealtimeTicket> {
  assertNonEmptyString(input.roomId, "room ID");
  assertSafePositiveInteger(input.generation, "generation");
  assertSafeNonNegativeInteger(input.permissionEpoch, "permission epoch");
  if (input.permission !== "read" && input.permission !== "edit") fail("Invalid realtime permission");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  assertSafeNonNegativeInteger(nowSeconds, "ticket issue time");
  const ttlSeconds = input.ttlSeconds ?? MAX_TICKET_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TICKET_TTL_SECONDS) {
    fail("Ticket lifetime exceeds its limit");
  }
  assertSafeNonNegativeInteger(nowSeconds + ttlSeconds, "ticket expiration time");
  const jti = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const permissions = input.permission === "edit" ? ["read", "write"] : ["read"];
  const payload = {
    purpose: "syrin:ticket:v1",
    aud: config.hubId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti,
    hub_id: config.hubId,
    assignment_epoch: config.assignmentEpoch,
    room_id: input.roomId,
    generation: input.generation,
    permission_epoch: input.permissionEpoch,
    permission: input.permission,
    permissions,
  };
  const ticket = await signJws(payload, config.ticketPrivateKey, config.ticketKid, "syrin-ticket+jwt");
  if (input.permission === "read") return { ticket, roomId: input.roomId };
  const writeMacKey = await deriveWriteMacKey(
    config.writeMacMasterKey,
    input.roomId,
    input.generation,
  );
  return {
    ticket,
    roomId: input.roomId,
    write_mac_key: encodeBase64Url(writeMacKey),
  };
}

export async function issueRealtimeTicketFromContext(
  context: unknown,
  config: RealtimeSigningConfig,
  nowSeconds?: number,
): Promise<{ ok: true; ticket: RealtimeTicket } | { ok: false; status: string }> {
  if (!isRecord(context) || typeof context.status !== "string") {
    return { ok: false, status: "unavailable" };
  }
  if (context.status !== "ok") return { ok: false, status: context.status };
  if (
    typeof context.noteId !== "string"
    || typeof context.generation !== "number"
    || typeof context.permissionEpoch !== "number"
  ) return { ok: false, status: "unavailable" };
  const roomId = await deriveOpaqueRoomId(config.roomHmacKey, context.noteId, context.generation);
  const ticket = await issueRealtimeTicket({
    roomId,
    generation: context.generation,
    permissionEpoch: context.permissionEpoch,
    permission: "edit",
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
  }, config);
  return { ok: true, ticket };
}

export async function createSavedAck(
  input: {
    roomId: string;
    generation: number;
    revision: number;
    permissionEpoch: number;
    stateVector: Uint8Array;
    nowSeconds?: number;
  },
  config: RealtimeSigningConfig,
): Promise<string> {
  assertNonEmptyString(input.roomId, "room ID");
  assertSafePositiveInteger(input.generation, "generation");
  assertSafePositiveInteger(input.revision, "revision");
  assertSafeNonNegativeInteger(input.permissionEpoch, "permission epoch");
  if (!(input.stateVector instanceof Uint8Array)) fail("Invalid saved state vector");
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  assertSafeNonNegativeInteger(nowSeconds, "ACK issue time");
  const stateVectorHash = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    input.stateVector as BufferSource,
  ));
  return signJws({
    purpose: "syrin:saved-ack:v1",
    iat: nowSeconds,
    room_id: input.roomId,
    generation: input.generation,
    revision: input.revision,
    permission_epoch: input.permissionEpoch,
    state_vector: encodeBase64Url(input.stateVector),
    state_vector_hash: encodeBase64Url(stateVectorHash),
  }, config.savedAckPrivateKey, config.savedAckKid, "syrin-saved-ack+jwt");
}

/** Call only after the RPC has returned success; PostgREST commits before returning. */
export async function savedAckForCommittedCas(
  result: unknown,
  config: RealtimeSigningConfig,
  nowSeconds?: number,
): Promise<{ status: string; savedAck?: string; roomId?: string; generation?: number; revision?: number }> {
  if (!isRecord(result) || typeof result.status !== "string") return { status: "unavailable" };
  if (result.status !== "ok") return { status: result.status };
  if (
    typeof result.noteId !== "string"
    || typeof result.generation !== "number"
    || typeof result.revision !== "number"
    || typeof result.permissionEpoch !== "number"
    || typeof result.stateVectorHex !== "string"
  ) return { status: "unavailable" };
  const stateVector = bytesFromHex(result.stateVectorHex);
  const roomId = await deriveOpaqueRoomId(config.roomHmacKey, result.noteId, result.generation);
  const savedAck = await createSavedAck({
    roomId,
    generation: result.generation,
    revision: result.revision,
    permissionEpoch: result.permissionEpoch,
    stateVector,
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
  }, config);
  return {
    status: "ok",
    savedAck,
    roomId,
    generation: result.generation,
    revision: result.revision,
  };
}

export function decodeStandardBase64(value: string, maxBytes: number): Uint8Array {
  if (
    typeof value !== "string"
    || value.length > Math.ceil(maxBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) fail("Invalid standard base64 payload");
  const normalized = value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const bytes = decodeBase64Url(normalized);
  if (bytes.byteLength > maxBytes) fail("Payload exceeds its size limit");
  return bytes;
}

export function encodeStandardBase64(value: Uint8Array): string {
  const base64url = encodeBase64Url(value);
  const standard = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return standard + "=".repeat((4 - (standard.length % 4)) % 4);
}

export function mergePlainYjsSnapshot(
  storedSnapshot: Uint8Array,
  incomingSnapshot: Uint8Array,
  yjs: YjsAdapter,
): { payload: Uint8Array; stateVector: Uint8Array; content: string } {
  const doc = new yjs.Doc();
  try {
    if (storedSnapshot.byteLength > 0) yjs.applyUpdate(doc, storedSnapshot);
    if (incomingSnapshot.byteLength > 0) yjs.applyUpdate(doc, incomingSnapshot);
    const payload = yjs.encodeStateAsUpdate(doc);
    const stateVector = yjs.encodeStateVector(doc);
    return {
      payload,
      stateVector,
      content: doc.getText("content").toString(),
    };
  } finally {
    doc.destroy?.();
  }
}

export function stateVectorsEqual(computed: Uint8Array, requested: Uint8Array): boolean {
  return equalBytes(computed, requested);
}

export async function computeCasExpectedMac(input: {
  writeMacKey: Uint8Array;
  roomId: string;
  generation: number;
  expectedRevision: number;
  payload: Uint8Array;
  permissionEpoch: number;
  stateVector: Uint8Array;
}): Promise<Uint8Array> {
  const key = await importHmacSha256Key(input.writeMacKey);
  const macInput = await buildCasSaveMacInput({
    opaqueRoomId: input.roomId,
    generation: input.generation,
    expectedRevision: input.expectedRevision,
    payload: input.payload,
    permissionEpoch: input.permissionEpoch,
    stateVector: input.stateVector,
  });
  return computeHmacSha256(key, macInput);
}
