import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.104.1";
import {
  type CapabilityScope,
  hashCapabilityToken,
} from "./capability.ts";
import {
  assessVerifiedClaims,
  classifyGetUserError,
  decodeUntrustedJwtPayload,
  readSnoteAuthHeader,
  type VerifiedRealtimeAuth,
} from "./capability-auth.ts";

export const capabilityCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-snote-auth, x-legacy-share",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After",
};

type CapabilityRpcResponse = {
  status: string;
  session?: unknown;
  acknowledgements?: unknown;
  [key: string]: unknown;
};

type CapabilityDatabase = {
  __InternalSupabase: { PostgrestVersion: "14.5" };
  public: {
    Tables: {
      note_shares: {
        Row: { token: string; slug: string; created_at: string };
        Insert: { token: string; slug: string; created_at?: string };
        Update: { token?: string; slug?: string; created_at?: string };
        Relationships: [];
      };
      notes: {
        Row: {
          slug: string;
          capability_managed: boolean;
          content: string;
          ydoc_state: string;
          is_encrypted: boolean;
          enc_salt: string | null;
          enc_check: string | null;
          enc_iterations: number;
          updated_at: string;
        };
        Insert: { slug: string };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      capability_note_create: {
        Args: {
          p_slug: string;
          p_owner_token_hash: string;
          p_edit_token_hash: string;
          p_view_token_hash: string;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_import_legacy: {
        Args: {
          p_slug: string;
          p_owner_token_hash: string;
          p_edit_token_hash: string;
          p_view_token_hash: string;
          p_checkpoint_id: string;
          p_payload_text: string;
          p_is_encrypted: boolean;
          p_salt: string | null;
          p_check: string | null;
          p_iterations: number | null;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_convert_legacy: {
        Args: {
          p_slug: string;
          p_owner_token_hash: string;
          p_edit_token_hash: string;
          p_view_token_hash: string;
          p_checkpoint_id: string;
          p_payload_text: string;
          p_is_encrypted: boolean;
          p_salt: string | null;
          p_check: string | null;
          p_iterations: number | null;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_plain_upsert: {
        Args: {
          p_slug: string;
          p_ydoc_state: string;
          p_content: string;
          p_char_count: number;
          p_tags: string[];
          p_is_encrypted: boolean;
          p_salt: string | null;
          p_check: string | null;
          p_iterations: number | null;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_realtime_ticket_context: {
        Args: { p_slug: string; p_auth_user_id: string };
        Returns: CapabilityRpcResponse;
      };
      capability_note_realtime_save: {
        Args: {
          p_slug: string;
          p_auth_user_id: string;
          p_expected_revision: number;
          p_generation: number;
          p_permission_epoch: number;
          p_ydoc_state: string;
          p_content: string;
          p_char_count: number;
          p_tags: string[];
          p_is_encrypted: boolean;
          p_salt: string | null;
          p_check: string | null;
          p_iterations: number | null;
          p_expected_mac: string;
          p_presented_mac: string;
          p_state_vector: string;
          p_state_vector_matches: boolean;
          p_replace_generation: boolean;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_disable_secure: {
        Args: {
          p_owner_token_hash: string;
          p_slug: string;
          p_ydoc_state: string;
          p_content: string;
          p_char_count: number;
          p_tags: string[];
          p_is_encrypted: boolean;
          p_salt: string | null;
          p_check: string | null;
          p_iterations: number | null;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_admission_consume: {
        Args: {
          p_operation: "create" | "sync" | "membership";
          p_subject_hash: string;
          p_request_cost?: number;
          p_byte_cost?: number;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_session_open: {
        Args: { p_token_hash: string; p_after_seq?: number; p_limit?: number };
        Returns: CapabilityRpcResponse;
      };
      capability_updates_append: {
        Args: {
          p_token_hash: string;
          p_updates: Array<{ updateId: string; payload: string }>;
          p_expected_encryption_version: number;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_note_manage: {
        Args: { p_token_hash: string; p_action: string; p_params?: Record<string, unknown> };
        Returns: CapabilityRpcResponse;
      };
      capability_checkpoint_append: {
        Args: {
          p_token_hash: string;
          p_checkpoint: { checkpointId: string; payload: string; throughSequence: number };
          p_expected_checkpoint_version: number;
          p_expected_encryption_version: number;
        };
        Returns: CapabilityRpcResponse;
      };
      capability_realtime_membership_bind: {
        Args: {
          p_token_hash: string;
          p_auth_user_id: string;
          p_expires_at: string;
        };
        Returns: CapabilityRpcResponse;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export function capabilityJson(
  body: unknown,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...capabilityCorsHeaders,
      ...additionalHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Vary": "Authorization, X-Snote-Auth, X-Legacy-Share",
    },
  });
}

export type CapabilityEnvironment = {
  supabaseUrl: string;
  hmacSecret: string;
  client: SupabaseClient<CapabilityDatabase>;
};

export function capabilityEnvironment():
  | { ok: false }
  | ({ ok: true } & CapabilityEnvironment) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const hmacSecret = Deno.env.get("CAPABILITY_HMAC_SECRET") ?? "";
  if (
    !supabaseUrl
    || !serviceRoleKey
    || new TextEncoder().encode(hmacSecret).byteLength < 32
  ) return { ok: false };

  return {
    ok: true,
    supabaseUrl,
    hmacSecret,
    client: createClient<CapabilityDatabase>(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

export async function capabilityTokenHash(
  token: string,
  hmacSecret: string,
): Promise<string | null> {
  try {
    return await hashCapabilityToken(token, hmacSecret);
  } catch {
    return null;
  }
}

export async function verifyRealtimeAuth(
  req: Request,
  environment: CapabilityEnvironment,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedRealtimeAuth> {
  const token = readSnoteAuthHeader(req);
  if (!token) return { mode: "polling" };

  try {
    const { data, error } = await environment.client.auth.getUser(token);
    if (error) {
      return classifyGetUserError((error as { status?: unknown }).status);
    }

    const user = data.user;
    const claims = decodeUntrustedJwtPayload(token);
    if (
      !user
      || !claims
      || claims.sub !== user.id
      || (user as { is_anonymous?: unknown }).is_anonymous !== true
    ) return { mode: "polling" };

    return assessVerifiedClaims(
      token,
      claims,
      `${environment.supabaseUrl.replace(/\/$/, "")}/auth/v1`,
      nowSeconds,
    );
  } catch {
    return { mode: "unavailable" };
  }
}

type StoredSession = {
  capabilityId: string;
  noteId: string;
  slug: string;
  scope: CapabilityScope;
  generation: number;
  syncStatus: "active" | "read_only_quarantine";
  currentSequence: number;
  payloadLimitBytes: number;
  checkpointSequence: number;
  checkpointVersion: number | null;
  checkpointPayload: string | null;
  checkpointEncryptionVersion: number | null;
  missingUpdates: Array<{
    updateId: string;
    payload: string;
    sequence: number;
    encryptionVersion: number;
  }>;
  encryption: {
    enabled: boolean;
    version: number;
    salt: string | null;
    check: string | null;
    iterations: number;
  };
};

function isStoredSession(value: unknown): value is StoredSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSession>;
  return typeof candidate.capabilityId === "string"
    && typeof candidate.noteId === "string"
    && typeof candidate.slug === "string"
    && ["owner", "edit", "view"].includes(candidate.scope ?? "")
    && Number.isSafeInteger(candidate.generation)
    && typeof candidate.syncStatus === "string"
    && Array.isArray(candidate.missingUpdates)
    && !!candidate.encryption
    && typeof candidate.encryption === "object";
}

export type SessionMaterialization =
  | { status: "ok"; session: Record<string, unknown> }
  | { status: "identity_conflict" | "unauthorized" | "unavailable" };

function materializedSession(
  stored: StoredSession,
  transport:
    | { syncTransport: "polling"; realtimeToken: null; realtimeExpiresAt: null }
    | {
      syncTransport: "private-realtime";
      realtimeToken: string;
      realtimeExpiresAt: string;
    },
): Record<string, unknown> {
  return {
    noteId: stored.noteId,
    slug: stored.slug,
    scope: stored.scope,
    ...transport,
    realtimeTopic: `note:${stored.noteId}`,
    generation: stored.generation,
    syncStatus: stored.syncStatus,
    currentSequence: stored.currentSequence,
    payloadLimitBytes: stored.payloadLimitBytes,
    checkpointSequence: stored.checkpointSequence,
    checkpointVersion: stored.checkpointVersion,
    checkpointPayload: stored.checkpointPayload,
    checkpointEncryptionVersion: stored.checkpointEncryptionVersion,
    missingUpdates: stored.missingUpdates,
    encryption: stored.encryption,
  };
}

export async function materializeNoteSession(
  storedValue: unknown,
  tokenHash: string,
  auth: VerifiedRealtimeAuth,
  environment: CapabilityEnvironment,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SessionMaterialization> {
  if (!isStoredSession(storedValue)) return { status: "unavailable" };
  const stored = storedValue;
  const polling = (): SessionMaterialization => ({
    status: "ok",
    session: materializedSession(stored, {
      syncTransport: "polling",
      realtimeToken: null,
      realtimeExpiresAt: null,
    }),
  });

  if (auth.mode === "polling") return polling();
  if (auth.mode === "unavailable") return { status: "unavailable" };

  const expiresAtSeconds = Math.min(auth.expiresAt, nowSeconds + 300);
  if (!Number.isSafeInteger(nowSeconds) || expiresAtSeconds <= nowSeconds) return polling();
  const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();

  try {
    const { data, error } = await environment.client.rpc(
      "capability_realtime_membership_bind",
      {
        p_token_hash: tokenHash,
        p_auth_user_id: auth.userId,
        p_expires_at: expiresAt,
      },
    );
    if (error) return { status: "unavailable" };

    const status = rpcStatus(data);
    if (status === "polling") return polling();
    if (status === "identity_conflict" || status === "unauthorized") return { status };
    if (
      status !== "ok"
      || data?.noteId !== stored.noteId
      || data?.capabilityId !== stored.capabilityId
      || data?.scope !== stored.scope
    ) return { status: "unavailable" };

    return {
      status: "ok",
      session: materializedSession(stored, {
        syncTransport: "private-realtime",
        realtimeToken: auth.token,
        realtimeExpiresAt: expiresAt,
      }),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function rpcStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "unavailable";
  return typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status
    : "unavailable";
}

export function capabilityFailure(status: string): Response {
  const body = (error: string) => ({ error, code: status });
  if (status === "unauthorized") return capabilityJson(body("unauthorized"), 401);
  if (status === "identity_conflict") {
    return capabilityJson(body("realtime identity conflict"), 409);
  }
  if (status === "writes_disabled") {
    return capabilityJson(body("temporarily unavailable"), 503);
  }
  if (status === "read_only") return capabilityJson(body("read only"), 409);
  if (
    status === "version_conflict"
    || status === "append_encryption_conflict"
    || status === "checkpoint_encryption_conflict"
    || status === "checkpoint_version_conflict"
  ) return capabilityJson(body("version conflict"), 409);
  if (status === "slug_unavailable") return capabilityJson(body("slug unavailable"), 409);
  if (status === "capability_managed") {
    return capabilityJson(body("capability managed"), 409);
  }
  if (status === "invalid_state") {
    return capabilityJson(body("invalid state"), 409);
  }
  if (status === "not_found") return capabilityJson(body("not found"), 404);
  if (status === "quota_exceeded") {
    // Storage/update quota transitions the note to read-only quarantine. It is
    // not an admission window, so raw clients must not treat it as retryable.
    return capabilityJson(
      body("note is read only"),
      409,
    );
  }
  if (status === "rate_limited") {
    return capabilityJson(
      body("capacity temporarily exceeded"),
      429,
      { "Retry-After": "3600" },
    );
  }
  if (status === "invalid" || status === "payload_too_large") {
    return capabilityJson(body("invalid request"), 400);
  }
  return capabilityJson(body("temporarily unavailable"), 503);
}

/**
 * The admission RPC predates note-size quarantine and also returns
 * quota_exceeded for a short-lived request window. Normalize only that edge
 * boundary so clients can retry a rate limit, while a quota_exceeded returned
 * by append/checkpoint remains a terminal read-only fence.
 */
export function capabilityAdmissionFailure(status: string): Response {
  return capabilityFailure(status === "quota_exceeded" ? "rate_limited" : status);
}

export function resolveMaterialization(
  result: SessionMaterialization,
):
  | { ok: true; session: Record<string, unknown> }
  | { ok: false; response: Response } {
  return result.status === "ok"
    ? { ok: true, session: result.session }
    : { ok: false, response: capabilityFailure(result.status) };
}
