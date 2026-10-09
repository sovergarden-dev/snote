import {
  decodeBase64Url,
  importEd25519VerificationKey,
  type JwsPinnedKeySets,
} from "../protocol";

export interface HubKeyBindings {
  HUB_ID: string;
  TICKET_PROBE_PUBLIC_KEYS_JSON: string;
  SAVED_ACK_PUBLIC_KEYS_JSON: string;
}

function parseRawKeySet(encoded: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("Invalid public key configuration");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid public key configuration");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([kid, key]) =>
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(kid) || typeof key !== "string" || key.length === 0
  )) {
    throw new Error("Invalid public key configuration");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function importHubPinnedKeys(bindings: HubKeyBindings): Promise<JwsPinnedKeySets> {
  if (typeof bindings.HUB_ID !== "string" || bindings.HUB_ID.length === 0 || bindings.HUB_ID.length > 128) {
    throw new Error("Invalid hub ID configuration");
  }
  const ticketRaw = parseRawKeySet(bindings.TICKET_PROBE_PUBLIC_KEYS_JSON);
  const ackRaw = parseRawKeySet(bindings.SAVED_ACK_PUBLIC_KEYS_JSON);
  const ticketKids = new Set(Object.keys(ticketRaw));
  if (Object.keys(ackRaw).some((kid) => ticketKids.has(kid))) {
    throw new Error("Public key IDs must be distinct by token purpose");
  }
  const [ticketEntries, ackEntries] = await Promise.all([
    Promise.all(Object.entries(ticketRaw).map(async ([kid, encoded]) => {
      const raw = decodeBase64Url(encoded);
      return [kid, await importEd25519VerificationKey(raw)] as const;
    })),
    Promise.all(Object.entries(ackRaw).map(async ([kid, encoded]) => {
      const raw = decodeBase64Url(encoded);
      return [kid, await importEd25519VerificationKey(raw)] as const;
    })),
  ]);
  const ticketAndProbe = Object.fromEntries(ticketEntries);
  const savedAck = Object.fromEntries(ackEntries);
  const ticketKeyBytes = new Set(Object.values(ticketRaw));
  if (Object.values(ackRaw).some((key) => ticketKeyBytes.has(key))) {
    throw new Error("Public key sets must be distinct by token purpose");
  }
  return { ticketAndProbe, savedAck };
}
