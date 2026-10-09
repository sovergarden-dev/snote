import { encodeBase64Url, type JwsPinnedKeySets } from "../../protocol";

export const TEST_NOW_SECONDS = 1_800_000_001;
export const TEST_HUB_ID = "hub-contract-test";
export const TEST_ROOM_ID = "room_01";
const encoder = new TextEncoder();

interface SigningPair {
  kid: string;
  typ: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicRawBase64Url: string;
}

async function makePair(kid: string, typ: string): Promise<SigningPair> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = pair.publicKey;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  return {
    kid,
    typ,
    privateKey: pair.privateKey,
    publicKey,
    publicRawBase64Url: encodeBase64Url(publicRaw),
  };
}

async function signCompact(pair: SigningPair, claims: Record<string, unknown>): Promise<string> {
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: "EdDSA", kid: pair.kid, typ: pair.typ })));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const input = encoder.encode(`${header}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, input));
  return `${header}.${payload}.${encodeBase64Url(signature)}`;
}

export interface TestSigningKeys {
  pinnedKeys: JwsPinnedKeySets;
  ticketPublicKeyBase64Url: string;
  savedAckPublicKeyBase64Url: string;
  signTicket(overrides?: Partial<Record<string, unknown>>): Promise<string>;
  signProbe(overrides?: Partial<Record<string, unknown>>): Promise<string>;
  signSavedAck(overrides?: Partial<Record<string, unknown>>): Promise<string>;
}

export async function createTestSigningKeys(): Promise<TestSigningKeys> {
  const ticketAndProbe = await makePair("test-ticket-probe", "syrin-ticket+jwt");
  const savedAck = await makePair("test-saved-ack", "syrin-saved-ack+jwt");
  return {
    pinnedKeys: {
      ticketAndProbe: { [ticketAndProbe.kid]: ticketAndProbe.publicKey },
      savedAck: { [savedAck.kid]: savedAck.publicKey },
    },
    ticketPublicKeyBase64Url: ticketAndProbe.publicRawBase64Url,
    savedAckPublicKeyBase64Url: savedAck.publicRawBase64Url,
    signTicket: (overrides = {}) => signCompact(ticketAndProbe, {
      purpose: "syrin:ticket:v1",
      aud: TEST_HUB_ID,
      iat: TEST_NOW_SECONDS,
      exp: TEST_NOW_SECONDS + 300,
      jti: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      hub_id: TEST_HUB_ID,
      assignment_epoch: 4,
      room_id: TEST_ROOM_ID,
      session_id: "session-01",
      generation: 3,
      permission_epoch: 7,
      permission: "edit",
      permissions: ["read", "write"],
      ...overrides,
    }),
    signProbe: (overrides = {}) => signCompact({ ...ticketAndProbe, typ: "syrin-healthz+jwt" }, {
      purpose: "syrin:healthz:v1",
      aud: TEST_HUB_ID,
      iat: TEST_NOW_SECONDS,
      exp: TEST_NOW_SECONDS + 30,
      ...overrides,
    }),
    signSavedAck: (overrides = {}) => signCompact(savedAck, {
      purpose: "syrin:saved-ack:v1",
      room_id: TEST_ROOM_ID,
      generation: 3,
      revision: 12,
      permission_epoch: 7,
      state_vector: "AQID",
      state_vector_hash: "BAUG",
      ...overrides,
    }),
  };
}

export function authFrame(ticket: string, sessionId = "session-01", roomId = TEST_ROOM_ID, version = 2): string {
  return JSON.stringify({
    v: version,
    message_type: "hub-auth",
    opaque_room_id: roomId,
    payload: { ticket, session_id: sessionId },
  });
}

export function relayFrame(
  messageType: string,
  payload: unknown,
  roomId = TEST_ROOM_ID,
  version = 2,
): string {
  return JSON.stringify({ v: version, message_type: messageType, opaque_room_id: roomId, payload });
}

export function keyringBindings(keys: TestSigningKeys): {
  HUB_ID: string;
  TICKET_PROBE_PUBLIC_KEYS_JSON: string;
  SAVED_ACK_PUBLIC_KEYS_JSON: string;
} {
  return {
    HUB_ID: TEST_HUB_ID,
    TICKET_PROBE_PUBLIC_KEYS_JSON: JSON.stringify({ "test-ticket-probe": keys.ticketPublicKeyBase64Url }),
    SAVED_ACK_PUBLIC_KEYS_JSON: JSON.stringify({ "test-saved-ack": keys.savedAckPublicKeyBase64Url }),
  };
}
