import {
  decodeBase64Url,
  Ed25519UnsupportedError,
  importEd25519VerificationKey,
  verifyProtocolJws,
  type JwsPinnedKeySets,
} from "./protocol";
import { createDefaultCapabilityAuthSource, type CapabilityAuthSource } from "@/lib/capability/auth";
import { isUsableSlug } from "@/lib/slug";
import { importRelayDerivationKey } from "./client-crypto";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/u;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

export type RealtimeHubConfig = {
  hubId: string;
  hubUrl: string;
};

export type RealtimeTicketBundle = {
  ticket: string;
  roomId: string;
  write_mac_key: string;
  noteId: string;
  revision: number;
  generation: number;
  permissionEpoch: number;
  ydocState: string;
};

export type CasSaveRequest = {
  slug: string;
  expectedRevision: number;
  generation: number;
  permissionEpoch: number;
  ydocState: string;
  stateVector: string;
  mac: string;
  isEncrypted: false;
  salt: null;
  check: null;
  iterations: null;
};

export type CasSaveResponse = {
  savedAck: string;
  roomId: string;
  generation: number;
  revision: number;
};

export interface RealtimeEdgeApi {
  issueTicket(slug: string, sessionId: string): Promise<RealtimeTicketBundle>;
  casSave(request: CasSaveRequest): Promise<CasSaveResponse>;
}

export class RealtimeEdgeApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "RealtimeEdgeApiError";
    this.status = status;
    this.code = code;
  }
}

export type RealtimePrelude = {
  slug: string;
  sessionId: string;
  ticket: RealtimeTicketBundle;
  claims: Record<string, unknown>;
  config: RealtimeHubConfig;
  pinnedKeys: JwsPinnedKeySets;
  writeMacKey: CryptoKey;
  relayDerivationKey: CryptoKey;
};

export type RealtimeClientOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  authSource?: CapabilityAuthSource;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInteger(value: unknown, min: number, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new Error(`invalid realtime ${field}`);
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function createRealtimeSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Use a non-capability, slug-scoped auth partition without ever sending the slug as an Auth key. */
export async function realtimeAuthNamespace(slug: string): Promise<string> {
  if (!isUsableSlug(slug)) throw new Error("invalid realtime slug");
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`syrin:realtime:plain-note-auth:v1:${slug}`),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function parseHubConfig(env: Record<string, unknown>): RealtimeHubConfig | null {
  const hubId = env.VITE_REALTIME_HUB_ID;
  const hubUrl = env.VITE_REALTIME_HUB_URL;
  if (
    typeof hubId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(hubId)
    || typeof hubUrl !== "string" || hubUrl.length > 512
  ) return null;
  try {
    const parsed = new URL(hubUrl);
    if (
      !["wss:", "ws:"].includes(parsed.protocol)
      || parsed.username || parsed.password
      || parsed.search || parsed.hash
      || (parsed.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    ) return null;
    return { hubId, hubUrl: parsed.toString() };
  } catch {
    return null;
  }
}

export function realtimeSyncFeatureEnabled(env: Record<string, unknown> = import.meta.env): boolean {
  return env.VITE_REALTIME_HUB_SYNC_ENABLED === "true"
    && env.VITE_CAPABILITY_ROUTES_ENABLED === "true"
    && env.VITE_CAPABILITY_AUTH_ENABLED === "true";
}

export function realtimeHubConfig(env: Record<string, unknown> = import.meta.env): RealtimeHubConfig | null {
  return parseHubConfig(env);
}

function parsePublicKeyMap(rawValue: unknown): Record<string, string> {
  if (typeof rawValue !== "string" || rawValue.length === 0 || rawValue.length > 16_384) {
    throw new Error("realtime verification keys are not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("realtime verification keys are invalid");
  }
  if (!isRecord(parsed)) throw new Error("realtime verification keys are invalid");
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 16) throw new Error("realtime verification keys are invalid");
  const output: Record<string, string> = {};
  for (const [kid, rawKey] of entries) {
    if (!KEY_ID_RE.test(kid) || typeof rawKey !== "string" || !BASE64URL_RE.test(rawKey)) {
      throw new Error("realtime verification keys are invalid");
    }
    const bytes = decodeBase64Url(rawKey);
    if (bytes.byteLength !== 32) throw new Error("realtime verification keys are invalid");
    output[kid] = rawKey;
  }
  return output;
}

export async function loadRealtimePinnedKeys(
  env: Record<string, unknown> = import.meta.env,
): Promise<JwsPinnedKeySets> {
  const ticketValues = parsePublicKeyMap(env.VITE_REALTIME_TICKET_PUBLIC_KEYS_JSON);
  const ackValues = parsePublicKeyMap(env.VITE_REALTIME_SAVED_ACK_PUBLIC_KEYS_JSON);
  if (Object.keys(ticketValues).some((kid) => Object.prototype.hasOwnProperty.call(ackValues, kid))) {
    throw new Error("realtime ticket and saved-ack keys must be distinct");
  }
  const [ticketEntries, ackEntries] = await Promise.all([
    Promise.all(Object.entries(ticketValues).map(async ([kid, value]) => [
      kid,
      await importEd25519VerificationKey(decodeBase64Url(value)),
    ] as const)),
    Promise.all(Object.entries(ackValues).map(async ([kid, value]) => [
      kid,
      await importEd25519VerificationKey(decodeBase64Url(value)),
    ] as const)),
  ]);
  const ticketAndProbe = Object.fromEntries(ticketEntries);
  const savedAck = Object.fromEntries(ackEntries);
  const ticketBytes = new Set(Object.values(ticketValues));
  if (Object.values(ackValues).some((value) => ticketBytes.has(value))) {
    throw new Error("realtime ticket and saved-ack keys must be distinct");
  }
  return { ticketAndProbe, savedAck };
}

async function readResponse(response: Response): Promise<JsonRecord> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string" ? body.error : `request failed (${response.status})`;
    const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
    throw new RealtimeEdgeApiError(message, response.status, code);
  }
  if (!isRecord(body)) throw new Error("invalid realtime Edge response");
  return body;
}

export function createRealtimeEdgeApi(options: RealtimeClientOptions = {}): RealtimeEdgeApi {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_SUPABASE_URL;
  const fetcher = options.fetcher ?? fetch;
  const authSource = options.authSource ?? createDefaultCapabilityAuthSource();
  if (typeof baseUrl !== "string" || !baseUrl) throw new Error("realtime Edge API unavailable");
  const endpoint = `${baseUrl.replace(/\/$/u, "")}/functions/v1/note-session`;

  const post = async (slug: string, body: JsonRecord): Promise<JsonRecord> => {
    if (!isUsableSlug(slug)) throw new Error("invalid realtime slug");
    const namespace = await realtimeAuthNamespace(slug);
    const token = await authSource.accessTokenFor(namespace, "ensure");
    if (!token || token.length > 8192) throw new Error("realtime Edge authorization unavailable");
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Snote-Auth": token,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
    });
    return readResponse(response);
  };

  return {
    async issueTicket(slug, sessionId) {
      if (!isSessionId(sessionId)) throw new Error("invalid realtime session ID");
      const data = await post(slug, { action: "realtime-ticket", slug, session_id: sessionId });
      if (
        typeof data.ticket !== "string" || data.ticket.length === 0 || data.ticket.length > 8192
        || typeof data.roomId !== "string" || data.roomId.length === 0
        || typeof data.write_mac_key !== "string"
        || typeof data.noteId !== "string"
        || typeof data.ydocState !== "string"
      ) throw new Error("invalid realtime ticket response");
      assertInteger(data.revision, 1, "revision");
      assertInteger(data.generation, 1, "generation");
      assertInteger(data.permissionEpoch, 0, "permission epoch");
      return data as unknown as RealtimeTicketBundle;
    },

    async casSave(request) {
      const data = await post(request.slug, { action: "realtime-cas-save", ...request });
      if (
        data.status !== "ok"
        || typeof data.savedAck !== "string" || data.savedAck.length === 0
        || typeof data.roomId !== "string"
      ) throw new RealtimeEdgeApiError("realtime CAS save was not committed", 409, typeof data.status === "string" ? data.status : null);
      assertInteger(data.generation, 1, "generation");
      assertInteger(data.revision, 1, "revision");
      return {
        savedAck: data.savedAck,
        roomId: data.roomId,
        generation: data.generation,
        revision: data.revision,
      };
    },
  };
}

export async function verifyRealtimeTicket(
  ticket: RealtimeTicketBundle,
  sessionId: string,
  config: RealtimeHubConfig,
  pinnedKeys: JwsPinnedKeySets,
): Promise<Record<string, unknown>> {
  if (!isSessionId(sessionId)) throw new Error("invalid realtime session ID");
  const claims = await verifyProtocolJws(ticket.ticket, {
    tokenType: "ticket",
    pinnedKeys,
    expectedAudience: config.hubId,
  });
  if (
    claims.room_id !== ticket.roomId
    || claims.session_id !== sessionId
    || claims.generation !== ticket.generation
    || claims.permission_epoch !== ticket.permissionEpoch
    || claims.permission !== "edit"
  ) throw new Error("realtime ticket claims do not match Edge metadata");
  const macKey = decodeBase64Url(ticket.write_mac_key);
  if (macKey.byteLength !== 32) throw new Error("invalid realtime write MAC key");
  const snapshotText = ticket.ydocState;
  if (snapshotText.length > Math.ceil(MAX_SNAPSHOT_BYTES * 4 / 3) + 4) {
    throw new Error("realtime snapshot exceeds its limit");
  }
  const normalized = snapshotText.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const snapshot = decodeBase64Url(normalized);
  if (snapshot.byteLength > MAX_SNAPSHOT_BYTES) throw new Error("realtime snapshot exceeds its limit");
  return claims;
}

export async function prepareRealtimeNote(
  slug: string,
  options: {
    api?: RealtimeEdgeApi;
    config?: RealtimeHubConfig | null;
    pinnedKeys?: JwsPinnedKeySets;
    loadKeys?: () => Promise<JwsPinnedKeySets>;
    sessionId?: string;
  } = {},
): Promise<RealtimePrelude> {
  if (!isUsableSlug(slug)) throw new Error("invalid realtime slug");
  const config = options.config === undefined ? realtimeHubConfig() : options.config;
  if (!config) throw new Error("realtime hub is not configured");
  const sessionId = options.sessionId ?? createRealtimeSessionId();
  const api = options.api ?? createRealtimeEdgeApi();
  const pinnedKeys = options.pinnedKeys ?? await (options.loadKeys ?? loadRealtimePinnedKeys)();
  const ticket = await api.issueTicket(slug, sessionId);
  const claims = await verifyRealtimeTicket(ticket, sessionId, config, pinnedKeys);
  const rawWriteMacKey = decodeBase64Url(ticket.write_mac_key);
  const writeMacKey = await crypto.subtle.importKey(
    "raw",
    rawWriteMacKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const relayDerivationKey = await importRelayDerivationKey(rawWriteMacKey);
  return { slug, sessionId, ticket, claims, config, pinnedKeys, writeMacKey, relayDerivationKey };
}

export type SafeRealtimePreparation =
  | { status: "ready"; prelude: RealtimePrelude }
  | { status: "fallback"; reason: "ed25519-unsupported" | "unavailable" };

export async function prepareRealtimeNoteSafely(
  slug: string,
  options: Parameters<typeof prepareRealtimeNote>[1] = {},
): Promise<SafeRealtimePreparation> {
  try {
    return { status: "ready", prelude: await prepareRealtimeNote(slug, options) };
  } catch (error) {
    return {
      status: "fallback",
      reason: isEd25519Unsupported(error) ? "ed25519-unsupported" : "unavailable",
    };
  }
}

export function isEd25519Unsupported(error: unknown): boolean {
  return error instanceof Ed25519UnsupportedError
    || (isRecord(error) && error.code === "ED25519_UNSUPPORTED");
}
