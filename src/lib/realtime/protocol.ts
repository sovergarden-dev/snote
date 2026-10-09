const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const CLOCK_SKEW_SECONDS = 120;

export const CURRENT_PROTOCOL_VERSION = 2;
export const MAX_REALTIME_FRAME_BYTES = 256 * 1024;
export const SUPPORTED_PROTOCOL_VERSIONS = [2, 1] as const;

export interface RealtimeFrame {
  v: number;
  message_type: string;
  opaque_room_id: string;
  /** Opaque, message-specific data; its fields must be validated by the consumer. */
  payload?: unknown;
}

export type JwsTokenType = "ticket" | "saved-ack" | "probe";

export interface JwsPinnedKeySets {
  /** Edge's Ed25519 pair is shared by ticket and health-probe tokens. */
  ticketAndProbe: Readonly<Record<string, CryptoKey>>;
  /** Edge's saved-ack Ed25519 pair must be different from its ticket pair. */
  savedAck: Readonly<Record<string, CryptoKey>>;
}

export interface VerifyProtocolJwsOptions {
  tokenType: JwsTokenType;
  /** Trusted, token-purpose-specific pinned keys; never populate from token data. */
  pinnedKeys: JwsPinnedKeySets;
  /** Required for tickets and health probes; compared with the signed `aud` claim. */
  expectedAudience?: string;
  /** Injectable seconds clock for deterministic verification and fake-clock tests. */
  nowSeconds?: number;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

export const STALE_PERMISSION_EPOCH_ERROR_CODE = "STALE_PERMISSION_EPOCH" as const;

export class StalePermissionEpochError extends ProtocolError {
  readonly code = STALE_PERMISSION_EPOCH_ERROR_CODE;

  constructor() {
    super("Permission epoch is stale");
    this.name = "StalePermissionEpochError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isByteArray(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  );
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function validateJsonNumbers(root: unknown): void {
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        fail("JSON contains an unsafe number");
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
}

function assertFrameEnvelope(frame: RealtimeFrame): void {
  if (!Number.isSafeInteger(frame.v) || !SUPPORTED_PROTOCOL_VERSIONS.includes(frame.v as 1 | 2)) {
    fail("Unsupported protocol version");
  }
  if (typeof frame.message_type !== "string" || frame.message_type.trim().length === 0) {
    fail("Invalid message type");
  }
  if (typeof frame.opaque_room_id !== "string" || frame.opaque_room_id.trim().length === 0) {
    fail("Invalid opaque room ID");
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(offset, offset + chunkSize) as unknown as number[],
    );
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    fail("Invalid base64url value");
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(base64 + padding);
  } catch {
    return fail("Invalid base64url value");
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) fail("Non-canonical base64url value");
  return bytes;
}

export function encodeRealtimeFrame(frame: RealtimeFrame): Uint8Array {
  assertFrameEnvelope(frame);
  const wire: RealtimeFrame = {
    v: frame.v,
    message_type: frame.message_type,
    opaque_room_id: frame.opaque_room_id,
    ...(frame.payload === undefined ? {} : { payload: frame.payload }),
  };
  validateJsonNumbers(wire);

  let encoded: string;
  try {
    encoded = JSON.stringify(wire);
  } catch {
    return fail("Frame is not JSON serializable");
  }
  const bytes = textEncoder.encode(encoded);
  if (bytes.byteLength > MAX_REALTIME_FRAME_BYTES) fail("Frame exceeds 256 KiB limit");
  return bytes;
}

export function decodeRealtimeFrame(frameBytes: Uint8Array): RealtimeFrame {
  if (!isByteArray(frameBytes)) fail("Frame must be raw bytes");
  const stableBytes = copyBytes(frameBytes);
  if (stableBytes.byteLength > MAX_REALTIME_FRAME_BYTES) fail("Frame exceeds 256 KiB limit");

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(stableBytes)) as unknown;
  } catch {
    return fail("Frame is not valid UTF-8 JSON");
  }
  if (!isRecord(parsed)) fail("Frame must be a JSON object");
  validateJsonNumbers(parsed);

  const frame = {
    v: parsed.v,
    message_type: parsed.message_type,
    opaque_room_id: parsed.opaque_room_id,
    ...(Object.prototype.hasOwnProperty.call(parsed, "payload") ? { payload: parsed.payload } : {}),
  } as RealtimeFrame;
  assertFrameEnvelope(frame);
  return frame;
}

export type CanonicalTupleField = string | number | bigint | Uint8Array;

function encodeU64(value: number | bigint): Uint8Array {
  let integer: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) fail("Tuple integer must be a non-negative safe integer");
    integer = BigInt(value);
  } else {
    integer = value;
  }
  if (integer < 0n || integer > U64_MAX) fail("Tuple integer is outside u64 range");
  if (integer > SAFE_INTEGER_MAX) fail("Tuple integer must be a safe integer");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, integer, false);
  return bytes;
}

function encodeField(value: CanonicalTupleField): Uint8Array {
  if (typeof value === "string") return textEncoder.encode(value);
  if (typeof value === "number" || typeof value === "bigint") return encodeU64(value);
  if (isByteArray(value)) return copyBytes(value);
  return fail("Unsupported canonical tuple field");
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function encodeCanonicalTuple(
  context: string,
  fields: readonly CanonicalTupleField[],
): Uint8Array {
  if (typeof context !== "string" || !/^.+:v[1-9][0-9]*$/u.test(context)) {
    fail("Canonical tuple context must be versioned");
  }
  const encodedFields = [textEncoder.encode(context), ...fields.map(encodeField)];
  const framed = encodedFields.map((field) => {
    if (field.byteLength > U32_MAX) fail("Canonical tuple field is too large");
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, field.byteLength, false);
    return concatenate([prefix, field]);
  });
  return concatenate(framed);
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail(`Invalid ${label}`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`Invalid ${label}`);
}

/** Call under the same permission-row lock as CAS; stale epochs must not produce a save ACK. */
export function assertCurrentPermissionEpoch(requestedEpoch: number, currentEpoch: number): void {
  assertNonNegativeSafeInteger(requestedEpoch, "requested permission epoch");
  assertNonNegativeSafeInteger(currentEpoch, "current permission epoch");
  if (requestedEpoch !== currentEpoch) throw new StalePermissionEpochError();
}

export interface RealtimeAadInput {
  opaqueRoomId: string;
  generation: number;
  messageType: string;
  senderId: string;
}

export function buildRealtimeAad(input: RealtimeAadInput): Uint8Array {
  assertNonEmptyString(input.opaqueRoomId, "opaque room ID");
  assertNonNegativeSafeInteger(input.generation, "generation");
  assertNonEmptyString(input.messageType, "message type");
  assertNonEmptyString(input.senderId, "sender ID");
  return encodeCanonicalTuple("syrin:realtime:aad:v1", [
    input.opaqueRoomId,
    input.generation,
    input.messageType,
    input.senderId,
  ]);
}

export interface YUpdateMacInput {
  opaqueRoomId: string;
  generation: number;
  messageType: "y-update";
  senderId: string;
  sessionId: string;
  counter: number;
  ciphertext: Uint8Array;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copyBytes(bytes) as BufferSource));
}

export async function buildYUpdateMacInput(input: YUpdateMacInput): Promise<Uint8Array> {
  assertNonEmptyString(input.opaqueRoomId, "opaque room ID");
  assertNonNegativeSafeInteger(input.generation, "generation");
  assertNonEmptyString(input.senderId, "sender ID");
  assertNonEmptyString(input.sessionId, "session ID");
  assertNonNegativeSafeInteger(input.counter, "counter");
  if (!isByteArray(input.ciphertext)) fail("Ciphertext must be raw bytes");
  return encodeCanonicalTuple("syrin:realtime:y-update-mac:v1", [
    input.opaqueRoomId,
    input.generation,
    "y-update",
    input.senderId,
    input.sessionId,
    input.counter,
    await sha256(input.ciphertext),
  ]);
}

export interface CasSaveMacInput {
  opaqueRoomId: string;
  generation: number;
  expectedRevision: number;
  payload: Uint8Array;
  permissionEpoch: number;
  stateVector: Uint8Array;
}

export async function buildCasSaveMacInput(input: CasSaveMacInput): Promise<Uint8Array> {
  assertNonEmptyString(input.opaqueRoomId, "opaque room ID");
  assertNonNegativeSafeInteger(input.generation, "generation");
  assertNonNegativeSafeInteger(input.expectedRevision, "expected revision");
  assertNonNegativeSafeInteger(input.permissionEpoch, "permission epoch");
  if (!isByteArray(input.payload)) fail("CAS payload must be raw bytes");
  if (!isByteArray(input.stateVector)) fail("CAS state vector must be raw bytes");
  // Canonical field order (L): room, generation, expected revision, payload hash, permission_epoch, state-vector hash.
  return encodeCanonicalTuple("syrin:realtime:cas-save-mac:v1", [
    input.opaqueRoomId,
    input.generation,
    input.expectedRevision,
    await sha256(input.payload),
    input.permissionEpoch,
    await sha256(input.stateVector),
  ]);
}

export async function importHmacSha256Key(rawKey: Uint8Array): Promise<CryptoKey> {
  if (!isByteArray(rawKey) || rawKey.byteLength === 0) fail("Invalid HMAC key bytes");
  return crypto.subtle.importKey(
    "raw",
    copyBytes(rawKey) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function computeHmacSha256(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (key.algorithm.name !== "HMAC" || !isByteArray(data)) fail("Invalid HMAC input");
  return new Uint8Array(
    await crypto.subtle.sign({ name: "HMAC" }, key, copyBytes(data) as BufferSource),
  );
}

export async function verifyHmacSha256(
  key: CryptoKey,
  mac: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (key.algorithm.name !== "HMAC" || !isByteArray(mac) || !isByteArray(data)) return false;
  try {
    return await crypto.subtle.verify(
      { name: "HMAC" },
      key,
      copyBytes(mac) as BufferSource,
      copyBytes(data) as BufferSource,
    );
  } catch {
    return false;
  }
}

export async function importEd25519VerificationKey(rawPublicKey: Uint8Array): Promise<CryptoKey> {
  if (!isByteArray(rawPublicKey) || rawPublicKey.byteLength !== 32) {
    fail("Ed25519 public keys must be 32 bytes");
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== "function") {
    throw new Ed25519UnsupportedError();
  }
  try {
    return await subtle.importKey(
      "raw",
      copyBytes(rawPublicKey) as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (isRecord(error) && error.name === "NotSupportedError") {
      throw new Ed25519UnsupportedError();
    }
    throw error;
  }
}

export const ED25519_UNSUPPORTED_ERROR_CODE = "ED25519_UNSUPPORTED" as const;

export class Ed25519UnsupportedError extends ProtocolError {
  readonly code = ED25519_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("Ed25519 verification is not supported by this runtime");
    this.name = "Ed25519UnsupportedError";
  }
}

const TOKEN_PROFILES: Record<
  JwsTokenType,
  { typ: string; purpose: string; maxLifetimeSeconds?: number }
> = {
  ticket: {
    typ: "syrin-ticket+jwt",
    purpose: "syrin:ticket:v1",
    maxLifetimeSeconds: 300,
  },
  "saved-ack": {
    typ: "syrin-saved-ack+jwt",
    purpose: "syrin:saved-ack:v1",
  },
  probe: {
    typ: "syrin-healthz+jwt",
    purpose: "syrin:healthz:v1",
    maxLifetimeSeconds: 30,
  },
};

const FORBIDDEN_JWS_HEADERS = ["crit", "jku", "jwk", "x5u", "x5c", "b64"] as const;
const ALLOWED_JWS_HEADERS = new Set(["alg", "kid", "typ"]);

function decodeJsonObject(segment: string): Record<string, unknown> {
  const decoded = decodeBase64Url(segment);
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(decoded)) as unknown;
  } catch {
    return fail("JWS segment is not UTF-8 JSON");
  }
  if (!isRecord(value)) fail("JWS segment must be a JSON object");
  validateJsonNumbers(value);
  return value;
}

export async function verifyProtocolJws(
  compact: string,
  options: VerifyProtocolJwsOptions,
): Promise<Record<string, unknown>> {
  if (
    typeof compact !== "string"
    || compact.length === 0
    || compact.length > MAX_REALTIME_FRAME_BYTES
  ) {
    fail("Invalid compact JWS serialization");
  }
  if (!Object.prototype.hasOwnProperty.call(TOKEN_PROFILES, options.tokenType)) {
    fail("Unsupported JWS token type");
  }
  const profile = TOKEN_PROFILES[options.tokenType];
  if (options.tokenType !== "saved-ack" && !options.expectedAudience) {
    fail("Expected audience is required");
  }
  if (!options.pinnedKeys?.ticketAndProbe || !options.pinnedKeys?.savedAck) {
    fail("Separate JWS key sets are required");
  }
  if (options.pinnedKeys.ticketAndProbe === options.pinnedKeys.savedAck) {
    fail("Separate JWS key sets are required");
  }
  const ticketKeyIds = new Set(Object.keys(options.pinnedKeys.ticketAndProbe));
  if (Object.keys(options.pinnedKeys.savedAck).some((kid) => ticketKeyIds.has(kid))) {
    fail("Separate JWS key sets are required");
  }
  const ticketKeys = new Set(Object.values(options.pinnedKeys.ticketAndProbe));
  if (Object.values(options.pinnedKeys.savedAck).some((key) => ticketKeys.has(key))) {
    fail("Separate JWS key sets are required");
  }
  const pinnedKeySet =
    options.tokenType === "saved-ack"
      ? options.pinnedKeys.savedAck
      : options.pinnedKeys.ticketAndProbe;

  const segments = compact.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    fail("Invalid compact JWS serialization");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJsonObject(encodedHeader);
  const payload = decodeJsonObject(encodedPayload);

  if (header.alg !== "EdDSA") fail("Unsupported JWS algorithm");
  for (const forbidden of FORBIDDEN_JWS_HEADERS) {
    if (Object.prototype.hasOwnProperty.call(header, forbidden)) {
      fail("Forbidden JWS header parameter");
    }
  }
  if (Object.keys(header).some((name) => !ALLOWED_JWS_HEADERS.has(name))) {
    fail("Unsupported JWS header parameter");
  }
  if (header.typ !== profile.typ) fail("JWS type mismatch");
  if (typeof header.kid !== "string" || header.kid.length === 0) fail("Invalid JWS key ID");
  if (!Object.prototype.hasOwnProperty.call(pinnedKeySet, header.kid)) {
    fail("Untrusted JWS key ID");
  }

  const key = pinnedKeySet[header.kid];
  if (key.type !== "public" || key.algorithm.name !== "Ed25519" || !key.usages.includes("verify")) {
    fail("Untrusted JWS key ID");
  }

  const signature = decodeBase64Url(encodedSignature);
  if (signature.byteLength !== 64) fail("Invalid Ed25519 signature length");
  const signingInput = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);
  let validSignature = false;
  try {
    validSignature = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature as BufferSource,
      signingInput as BufferSource,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) fail("Invalid JWS signature");

  if (payload.purpose !== profile.purpose) fail("JWS purpose mismatch");
  if (options.expectedAudience !== undefined && payload.aud !== options.expectedAudience) {
    fail("JWS audience mismatch");
  }

  if (profile.maxLifetimeSeconds !== undefined) {
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    if (
      typeof issuedAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt < 0 ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0 ||
      expiresAt <= issuedAt
    ) {
      fail("Invalid JWS time claims");
    }

    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) fail("Invalid verification clock");
    if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) fail("JWS issued-at is in the future");
    if (expiresAt < nowSeconds - CLOCK_SKEW_SECONDS) fail("JWS has expired");
    if (expiresAt - issuedAt > profile.maxLifetimeSeconds) fail("JWS lifetime exceeds its limit");
  }

  return payload;
}
