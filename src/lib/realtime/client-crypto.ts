import {
  buildRealtimeAad,
  buildYUpdateMacInput,
  computeHmacSha256,
  decodeBase64Url,
  encodeBase64Url,
  verifyHmacSha256,
  verifyProtocolJws,
  type JwsPinnedKeySets,
} from "./protocol";

const encoder = new TextEncoder();
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type RealtimeCipherContext = {
  roomId: string;
  generation: number;
  messageType: "y-update" | "presence";
  senderId: string;
  sessionId: string;
  counter: number;
};

export type RealtimeCipherPayload = {
  sender_id: string;
  session_id: string;
  counter: number;
  nonce: string;
  ciphertext: string;
  mac?: string;
};

export type SavedAckExpectation = {
  roomId: string;
  generation: number;
  permissionEpoch: number;
  revision: number;
  stateVector: Uint8Array;
};

export async function importRelayDerivationKey(rawWriteMacKey: Uint8Array): Promise<CryptoKey> {
  if (rawWriteMacKey.byteLength !== 32) throw new Error("invalid realtime key material");
  return crypto.subtle.importKey("raw", rawWriteMacKey as BufferSource, "HKDF", false, ["deriveBits"]);
}

async function deriveKeyMaterial(
  key: CryptoKey,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function deriveRealtimeSenderKey(
  relayDerivationKey: CryptoKey,
  context: Pick<RealtimeCipherContext, "roomId" | "generation" | "senderId" | "sessionId">,
): Promise<CryptoKey> {
  const relaySalt = encoder.encode("syrin:realtime:relay-key-salt:v1");
  const roomInfo = encoder.encode(`${context.roomId}\u0000${context.generation}`);
  const relayRoot = await deriveKeyMaterial(relayDerivationKey, relaySalt, roomInfo);
  const relayRootKey = await crypto.subtle.importKey(
    "raw",
    relayRoot as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const sessionSalt = encoder.encode("syrin:realtime:sender-key-salt:v1");
  const sessionInfo = encoder.encode(`${context.senderId}\u0000${context.sessionId}`);
  const senderKeyBytes = await deriveKeyMaterial(relayRootKey, sessionSalt, sessionInfo);
  return crypto.subtle.importKey(
    "raw",
    senderKeyBytes as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function nonceForCounter(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 1) throw new Error("invalid realtime counter");
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

function counterMatchesNonce(nonce: Uint8Array, counter: number): boolean {
  if (nonce.byteLength !== NONCE_BYTES || !Number.isSafeInteger(counter) || counter < 1) return false;
  const value = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(4, false);
  return value === BigInt(counter);
}

export async function encryptRealtimePayload(
  plaintext: Uint8Array,
  context: RealtimeCipherContext,
  relayDerivationKey: CryptoKey,
  writeMacKey: CryptoKey,
): Promise<RealtimeCipherPayload> {
  if (plaintext.byteLength === 0) throw new Error("empty realtime payload");
  const nonce = nonceForCounter(context.counter);
  const senderKey = await deriveRealtimeSenderKey(relayDerivationKey, context);
  const aad = buildRealtimeAad({
    opaqueRoomId: context.roomId,
    generation: context.generation,
    messageType: context.messageType,
    senderId: context.senderId,
  });
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    senderKey,
    plaintext as BufferSource,
  ));
  const payload: RealtimeCipherPayload = {
    sender_id: context.senderId,
    session_id: context.sessionId,
    counter: context.counter,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(encrypted),
  };
  if (context.messageType === "y-update") {
    const macInput = await buildYUpdateMacInput({
      opaqueRoomId: context.roomId,
      generation: context.generation,
      messageType: "y-update",
      senderId: context.senderId,
      sessionId: context.sessionId,
      counter: context.counter,
      ciphertext: encrypted,
    });
    payload.mac = encodeBase64Url(await computeHmacSha256(writeMacKey, macInput));
  }
  return payload;
}

export async function decryptRealtimePayload(
  payload: RealtimeCipherPayload,
  context: Omit<RealtimeCipherContext, "senderId" | "sessionId" | "counter">,
  relayDerivationKey: CryptoKey,
  writeMacKey: CryptoKey,
  lastAcceptedCounter: number,
): Promise<{ plaintext: Uint8Array; context: RealtimeCipherContext }> {
  if (
    !payload || typeof payload.sender_id !== "string" || payload.sender_id.length < 8
    || typeof payload.session_id !== "string" || payload.session_id.length < 8
    || !Number.isSafeInteger(payload.counter) || payload.counter < 1
    || payload.counter <= lastAcceptedCounter
    || typeof payload.nonce !== "string" || typeof payload.ciphertext !== "string"
  ) throw new Error("invalid or replayed realtime payload");
  const messageType = context.messageType;
  const fullContext: RealtimeCipherContext = {
    ...context,
    messageType,
    senderId: payload.sender_id,
    sessionId: payload.session_id,
    counter: payload.counter,
  };
  const nonce = decodeBase64Url(payload.nonce);
  const ciphertext = decodeBase64Url(payload.ciphertext);
  if (!counterMatchesNonce(nonce, payload.counter) || ciphertext.byteLength <= GCM_TAG_BYTES) {
    throw new Error("invalid realtime ciphertext envelope");
  }
  if (messageType === "y-update") {
    if (typeof payload.mac !== "string") throw new Error("missing realtime update MAC");
    const mac = decodeBase64Url(payload.mac);
    const macInput = await buildYUpdateMacInput({
      opaqueRoomId: context.roomId,
      generation: context.generation,
      messageType: "y-update",
      senderId: payload.sender_id,
      sessionId: payload.session_id,
      counter: payload.counter,
      ciphertext,
    });
    if (!(await verifyHmacSha256(writeMacKey, mac, macInput))) {
      throw new Error("invalid realtime update MAC");
    }
  }
  const senderKey = await deriveRealtimeSenderKey(relayDerivationKey, fullContext);
  const aad = buildRealtimeAad({
    opaqueRoomId: context.roomId,
    generation: context.generation,
    messageType,
    senderId: payload.sender_id,
  });
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    senderKey,
    ciphertext as BufferSource,
  ));
  return { plaintext, context: fullContext };
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export async function verifySavedAck(
  token: string,
  expected: SavedAckExpectation,
  pinnedKeys: JwsPinnedKeySets,
): Promise<boolean> {
  try {
    const claims = await verifyProtocolJws(token, {
      tokenType: "saved-ack",
      pinnedKeys,
    });
    return claims.room_id === expected.roomId
      && claims.generation === expected.generation
      && claims.permission_epoch === expected.permissionEpoch
      && claims.revision === expected.revision
      && claims.state_vector === encodeBase64Url(expected.stateVector)
      && claims.state_vector_hash === await sha256Base64Url(expected.stateVector);
  } catch {
    return false;
  }
}
