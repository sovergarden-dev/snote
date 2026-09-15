import { CAPABILITY_TOKEN_RE, type CapabilityScope } from "./url";
import { isUsableSlug } from "@/lib/slug";
import { decodeCapabilityPayload } from "./encoding";
import {
  createDefaultCapabilityAuthSource,
  type CapabilityAuthSource,
} from "./auth";

export type EncryptionMetadata = {
  enabled: boolean;
  version: number;
  salt: string | null;
  check: string | null;
  iterations: number;
};

export type NoteUpdate = {
  updateId: string;
  payload: string;
  sequence: number;
  encryptionVersion: number;
};

export type NoteSessionBase = {
  noteId: string;
  slug: string;
  scope: CapabilityScope;
  realtimeTopic: `note:${string}`;
  generation: number;
  syncStatus: "active" | "read_only_quarantine";
  currentSequence: number;
  payloadLimitBytes: number;
  checkpointSequence: number;
  checkpointVersion: number | null;
  checkpointPayload: string | null;
  checkpointEncryptionVersion: number | null;
  missingUpdates: NoteUpdate[];
  encryption: EncryptionMetadata;
};

export type PrivateRealtimeNoteSession = NoteSessionBase & {
  syncTransport: "private-realtime";
  realtimeToken: string;
  realtimeExpiresAt: string;
};

export type PollingNoteSession = NoteSessionBase & {
  syncTransport: "polling";
  realtimeToken: null;
  realtimeExpiresAt: null;
};

export type NoteSession =
  | PrivateRealtimeNoteSession
  | PollingNoteSession;

export type PendingUpdate = Omit<NoteUpdate, "sequence">;

export type CapabilityApi = ReturnType<typeof createCapabilityApi>;

/** A capability API failure with the transport metadata needed for safe retries. */
export class CapabilityApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  /** Stable, server-declared failure class. Never infer authorization from text. */
  readonly code: string | null;

  constructor(
    message: string,
    status: number,
    retryAfterMs: number | null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "CapabilityApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

type ApiOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  authSource?: CapabilityAuthSource;
};

const UPDATE_ID_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAYLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function endpoint(baseUrl: string, name: string) {
  return `${baseUrl.replace(/\/$/, "")}/functions/v1/${name}`;
}

function assertSession(value: unknown): NoteSession {
  if (!value || typeof value !== "object") throw new Error("invalid note session");
  const session = value as Partial<NoteSession>;
  const validTransport =
    session.syncTransport === "private-realtime"
      ? typeof session.realtimeToken === "string"
        && session.realtimeToken.length > 0
        && session.realtimeToken.length <= 8192
        && isCanonicalUtcTimestamp(session.realtimeExpiresAt)
      : session.syncTransport === "polling"
        && session.realtimeToken === null
        && session.realtimeExpiresAt === null;
  if (
    !UUID_RE.test(session.noteId ?? "")
    || typeof session.slug !== "string"
    || !isUsableSlug(session.slug)
    || !["owner", "edit", "view"].includes(session.scope ?? "")
    || !validTransport
    || session.realtimeTopic !== `note:${session.noteId}`
    || !Number.isSafeInteger(session.generation)
    || Number(session.generation) < 1
    || !["active", "read_only_quarantine"].includes(session.syncStatus ?? "")
    || !isNonNegativeInteger(session.currentSequence)
    || !isNonNegativeInteger(session.checkpointSequence)
    || session.checkpointSequence > session.currentSequence
    || !Number.isSafeInteger(session.payloadLimitBytes)
    || Number(session.payloadLimitBytes) < 1
    || Number(session.payloadLimitBytes) > MAX_PAYLOAD_LIMIT_BYTES
    || !Array.isArray(session.missingUpdates)
    || !session.encryption
  ) throw new Error("invalid note session");
  const checkpointVersionValid = session.checkpointVersion === null
    ? session.checkpointSequence === 0 && session.checkpointPayload === null && session.checkpointEncryptionVersion === null
    : Number.isSafeInteger(session.checkpointVersion)
      && Number(session.checkpointVersion) >= 1
      && typeof session.checkpointPayload === "string"
      && isNonNegativeInteger(session.checkpointEncryptionVersion);
  const encryption = session.encryption;
  if (
    !checkpointVersionValid
    || typeof encryption.enabled !== "boolean"
    || !isNonNegativeInteger(encryption.version)
    || !Number.isSafeInteger(encryption.iterations)
    || encryption.iterations < 1
    || (encryption.enabled && (
      typeof encryption.salt !== "string" || encryption.salt.length === 0
      || typeof encryption.check !== "string" || encryption.check.length === 0
    ))
  ) throw new Error("invalid note session");
  try {
    if (session.checkpointPayload) {
      const checkpoint = decodeCapabilityPayload(session.checkpointPayload);
      if (checkpoint.byteLength > session.payloadLimitBytes) {
        throw new Error("oversized checkpoint");
      }
    }
  } catch {
    throw new Error("invalid note session");
  }
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  for (const update of session.missingUpdates) {
    if (
      !UPDATE_ID_RE.test(update.updateId)
      || typeof update.payload !== "string"
      || !isNonNegativeInteger(update.sequence)
      || update.sequence <= session.checkpointSequence
      || update.sequence > session.currentSequence
      || !isNonNegativeInteger(update.encryptionVersion)
      || seenIds.has(update.updateId)
      || seenSequences.has(update.sequence)
    ) throw new Error("invalid note session");
    try {
      if (decodeCapabilityPayload(update.payload).byteLength > session.payloadLimitBytes) {
        throw new Error("oversized update");
      }
    } catch {
      throw new Error("invalid note session");
    }
    seenIds.add(update.updateId);
    seenSequences.add(update.sequence);
  }
  return session as NoteSession;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const milliseconds = Number(raw) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

async function readJson(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : `request failed (${response.status})`;
    const candidateCode = data && typeof data === "object" && "code" in data
      ? (data as { code: unknown }).code
      : null;
    const code = typeof candidateCode === "string" && /^[a-z][a-z_]{0,63}$/.test(candidateCode)
      ? candidateCode
      : null;
    throw new CapabilityApiError(message, response.status, retryAfterMs(response), code);
  }
  return data as Record<string, unknown>;
}

export function createCapabilityApi(options: ApiOptions = {}) {
  const baseUrl = options.baseUrl ?? import.meta.env.VITE_SUPABASE_URL;
  const fetcher = options.fetcher ?? fetch;
  const authSource = options.authSource ?? createDefaultCapabilityAuthSource();
  if (!baseUrl) throw new Error("capability API unavailable");

  const post = async (name: string, body: unknown, token?: string, keepalive = false) => {
    if (import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED !== "true") {
      throw new Error("capability API unavailable");
    }
    if (token && !CAPABILITY_TOKEN_RE.test(token)) throw new Error("invalid capability");
    let authToken: string | null = null;
    if (token) {
      try {
        authToken = await authSource.accessTokenFor(
          token,
          keepalive ? "cached-only" : "ensure",
        );
      } catch {
        authToken = null;
      }
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (authToken && authToken.length <= 8192) {
      headers["X-Snote-Auth"] = authToken;
    }
    const response = await fetcher(endpoint(baseUrl, name), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      keepalive,
    });
    return readJson(response);
  };

  return {
    async createNote(slug: string, ownerCandidate: string) {
      if (!CAPABILITY_TOKEN_RE.test(ownerCandidate)) throw new Error("invalid capability");
      const data = await post("note-session", { action: "create", slug }, ownerCandidate);
      const capabilities = data.capabilities as Record<string, unknown> | undefined;
      if (
        !capabilities
        || !CAPABILITY_TOKEN_RE.test(String(capabilities.owner ?? ""))
        || String(capabilities.owner) !== ownerCandidate
        || !(capabilities.edit === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.edit)))
        || !(capabilities.view === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.view)))
      ) throw new Error("invalid capabilities");
      return {
        session: assertSession(data.session),
        capabilities: {
          owner: String(capabilities.owner),
          ...(capabilities.edit === undefined ? {} : { edit: String(capabilities.edit) }),
          ...(capabilities.view === undefined ? {} : { view: String(capabilities.view) }),
        },
      };
    },

    async importLegacyNote(body: {
      slug: string;
      checkpointId: string;
      payload: string;
      isEncrypted: boolean;
      salt: string | null;
      check: string | null;
      iterations: number | null;
    }, ownerCandidate: string) {
      const data = await post("note-session", { action: "import-legacy", ...body }, ownerCandidate);
      const capabilities = data.capabilities as Record<string, unknown> | undefined;
      if (
        !capabilities
        || !CAPABILITY_TOKEN_RE.test(String(capabilities.owner ?? ""))
        || String(capabilities.owner) !== ownerCandidate
        || !(capabilities.edit === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.edit)))
        || !(capabilities.view === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.view)))
      ) throw new Error("invalid capabilities");
      return {
        session: assertSession(data.session),
        capabilities: {
          owner: String(capabilities.owner),
          ...(capabilities.edit === undefined ? {} : { edit: String(capabilities.edit) }),
          ...(capabilities.view === undefined ? {} : { view: String(capabilities.view) }),
        },
      };
    },

    async convertLegacyNote(body: {
      slug: string;
      checkpointId: string;
      payload: string;
      isEncrypted: boolean;
      salt: string | null;
      check: string | null;
      iterations: number | null;
    }, ownerCandidate: string) {
      const data = await post("note-session", { action: "convert-legacy", ...body }, ownerCandidate);
      const capabilities = data.capabilities as Record<string, unknown> | undefined;
      if (
        !capabilities
        || !CAPABILITY_TOKEN_RE.test(String(capabilities.owner ?? ""))
        || String(capabilities.owner) !== ownerCandidate
        || !(capabilities.edit === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.edit)))
        || !(capabilities.view === undefined || CAPABILITY_TOKEN_RE.test(String(capabilities.view)))
      ) throw new Error("invalid capabilities");
      return {
        session: assertSession(data.session),
        capabilities: {
          owner: String(capabilities.owner),
          ...(capabilities.edit === undefined ? {} : { edit: String(capabilities.edit) }),
          ...(capabilities.view === undefined ? {} : { view: String(capabilities.view) }),
        },
      };
    },

    async upsertPlainNote(body: {
      slug: string;
      ydocState: string;
      content: string;
      charCount: number;
      tags: string[];
      isEncrypted: boolean;
      salt: string | null;
      check: string | null;
      iterations: number | null;
    }, keepalive = false) {
      if (!isUsableSlug(body.slug)) throw new Error("invalid slug");
      const data = await post("note-session", { action: "plain-upsert", ...body }, undefined, keepalive);
      if (data.status !== "ok") throw new Error("invalid plain upsert");
      return {
        noteId: typeof data.noteId === "string" ? data.noteId : null,
        created: data.created === true,
      };
    },

    async disableSecureNote(body: {
      slug: string;
      ydocState: string;
      content: string;
      charCount: number;
      tags: string[];
      isEncrypted: boolean;
      salt: string | null;
      check: string | null;
      iterations: number | null;
    }, ownerToken: string) {
      if (!isUsableSlug(body.slug)) throw new Error("invalid slug");
      const data = await post("note-session", { action: "disable-secure", ...body }, ownerToken);
      if (data.status !== "ok") throw new Error("invalid disable secure");
      return {
        noteId: typeof data.noteId === "string" ? data.noteId : null,
        recovered: data.recovered === true,
      };
    },

    async openSession(token: string, initialAfterSequence = 0): Promise<NoteSession> {
      let afterSequence = initialAfterSequence;
      let aggregate: NoteSession | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page += 1) {
        const data = await post("note-session", { afterSequence }, token);
        const next = assertSession(data.session);
        if (aggregate && (
          aggregate.noteId !== next.noteId
          || aggregate.slug !== next.slug
          || aggregate.scope !== next.scope
          || aggregate.generation !== next.generation
          || aggregate.encryption.version !== next.encryption.version
        )) throw new Error("note session changed");
        const merged = [...(aggregate?.missingUpdates ?? [])];
        for (const update of next.missingUpdates) {
          if (!seen.has(update.updateId)) {
            seen.add(update.updateId);
            merged.push(update);
          }
        }
        aggregate = { ...next, missingUpdates: merged };
        const maxSequence = next.missingUpdates.reduce(
          (max, update) => Math.max(max, update.sequence),
          Math.max(afterSequence, next.checkpointSequence),
        );
        if (maxSequence >= next.currentSequence || next.missingUpdates.length === 0) return aggregate;
        if (maxSequence <= afterSequence) throw new Error("note session pagination stalled");
        afterSequence = maxSequence;
      }
      throw new Error("note session pagination limit exceeded");
    },

    async sync(
      token: string,
      body: {
        updates: PendingUpdate[];
        expectedEncryptionVersion: number;
        afterSequence: number;
        checkpoint?: {
          checkpointId: string;
          payload: string;
          throughSequence: number;
          expectedCheckpointVersion: number;
        };
      },
      keepalive = false,
    ) {
      const data = await post("note-sync", body, token, keepalive);
      const acknowledgements = data.acknowledgements;
      if (!Array.isArray(acknowledgements)) throw new Error("invalid acknowledgements");
      for (const acknowledgement of acknowledgements) {
        if (
          !acknowledgement
          || typeof acknowledgement !== "object"
          || !UPDATE_ID_RE.test(String((acknowledgement as { updateId?: unknown }).updateId ?? ""))
          || !isNonNegativeInteger((acknowledgement as { sequence?: unknown }).sequence)
          || Number((acknowledgement as { sequence: number }).sequence) < 1
        ) throw new Error("invalid acknowledgements");
      }
      return {
        acknowledgements: acknowledgements as Array<{ updateId: string; sequence: number }>,
        session: assertSession(data.session),
      };
    },

    async manage(token: string, body: Record<string, unknown>) {
      return post("note-manage", body, token);
    },
  };
}
