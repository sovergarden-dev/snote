import * as Y from "yjs";
import {
  computeCasExpectedMac,
  decodeStandardBase64,
  deriveOpaqueRoomId,
  deriveWriteMacKey,
  encodeStandardBase64,
  mergePlainYjsSnapshot,
  savedAckForCommittedCas,
  stateVectorsEqual,
  type RealtimeSigningConfig,
  type YjsAdapter,
} from "../_shared/realtime-edge.ts";
import { decodeBase64Url } from "../../../src/lib/realtime/protocol.ts";
import { extractTags } from "../../../src/lib/tags.ts";

const MAX_ENCODED_PAYLOAD_CHARS = 5_592_406;
const MAX_REALTIME_STATE_VECTOR_BYTES = 65_536;

type RealtimeAuth = { mode: string; userId?: string };
type RpcReply = { data: unknown; error: unknown };

export interface RealtimeCasHandlerDependencies {
  rpc: (
    name: "capability_note_realtime_ticket_context" | "capability_note_realtime_save",
    args: Record<string, unknown>,
  ) => Promise<RpcReply>;
  verifyRealtimeAuth: (req: Request) => Promise<RealtimeAuth>;
  realtimeSigningConfig: () => Promise<RealtimeSigningConfig>;
  capabilityJson: (body: unknown, status: number) => Response;
  capabilityFailure: (status: string) => Response;
}

export function realtimeFailure(
  status: string,
  helpers: Pick<RealtimeCasHandlerDependencies, "capabilityJson" | "capabilityFailure">,
): Response {
  if (status === "stale_permission_epoch") {
    return helpers.capabilityJson(
      { error: "stale permission epoch", code: "STALE_PERMISSION_EPOCH" },
      409,
    );
  }
  if (status === "invalid_mac") {
    return helpers.capabilityJson({ error: "invalid MAC", code: "INVALID_MAC" }, 401);
  }
  if (status === "invalid_state_vector") {
    return helpers.capabilityJson(
      { error: "invalid state vector", code: "INVALID_STATE_VECTOR" },
      409,
    );
  }
  if (status === "not_found") {
    return helpers.capabilityJson({ error: "not found", code: status }, 404);
  }
  if (status === "invalid") return helpers.capabilityFailure("invalid");
  if (status === "generation_conflict" || status === "version_conflict") {
    return helpers.capabilityJson({ error: "version conflict", code: status }, 409);
  }
  return helpers.capabilityFailure(status);
}

function rpcStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "unavailable";
  return typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status
    : "unavailable";
}

function byteaHex(value: Uint8Array): string {
  return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Request handler for the legacy-slug realtime save/replace Edge routes.
 * The client MAC authenticates the exact bytes in request.ydocState; a merged
 * plaintext snapshot is only the durable payload and source of the canonical
 * state vector.
 */
export async function handleRealtimeCasRequest(
  req: Request,
  bodyValue: unknown,
  slug: string,
  dependencies: RealtimeCasHandlerDependencies,
): Promise<Response> {
  const fail = (status: string) => realtimeFailure(status, dependencies);
  if (!isRecord(bodyValue)) return fail("invalid");
  const body = bodyValue;
  const replacing = body.action === "realtime-replace";
  if (!replacing && body.action !== "realtime-cas-save") return fail("invalid");

  const ydocState = typeof body.ydocState === "string" ? body.ydocState : "";
  const stateVectorText = typeof body.stateVector === "string" ? body.stateVector : "";
  const macText = typeof body.mac === "string" ? body.mac : "";
  const expectedRevision = Number(body.expectedRevision);
  const generation = Number(body.generation);
  const permissionEpoch = Number(body.permissionEpoch);
  const isEncrypted = body.isEncrypted;
  const salt = body.salt ?? null;
  const check = body.check ?? null;
  const iterations = body.iterations ?? null;
  if (
    ydocState.length > MAX_ENCODED_PAYLOAD_CHARS
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || !Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(permissionEpoch) || permissionEpoch < 0
    || stateVectorText.length > Math.ceil(MAX_REALTIME_STATE_VECTOR_BYTES * 4 / 3)
    || macText.length !== 43
    || (isEncrypted !== true && isEncrypted !== false)
  ) return fail("invalid");

  const auth = await dependencies.verifyRealtimeAuth(req);
  if (auth.mode === "unavailable") return fail("unavailable");
  if (auth.mode !== "private-realtime" || typeof auth.userId !== "string") {
    return fail("unauthorized");
  }

  const { data: context, error: contextError } = await dependencies.rpc(
    "capability_note_realtime_ticket_context",
    { p_slug: slug, p_auth_user_id: auth.userId },
  );
  if (contextError) return fail("unavailable");
  if (rpcStatus(context) !== "ok") return fail(rpcStatus(context));
  if (
    !isRecord(context)
    || typeof context.noteId !== "string"
    || typeof context.ydocState !== "string"
    || context.isEncrypted !== isEncrypted
  ) return fail("invalid_state");

  let incomingBytes: Uint8Array;
  let requestedStateVector: Uint8Array;
  let presentedMac: Uint8Array;
  let storedBytes: Uint8Array;
  try {
    incomingBytes = decodeStandardBase64(ydocState, 4_194_304);
    requestedStateVector = decodeBase64Url(stateVectorText);
    presentedMac = decodeBase64Url(macText);
    storedBytes = decodeStandardBase64(context.ydocState, 4_194_304);
  } catch {
    return fail("invalid");
  }
  if (
    requestedStateVector.byteLength > MAX_REALTIME_STATE_VECTOR_BYTES
    || presentedMac.byteLength !== 32
  ) return fail("invalid");

  let payloadBytes = incomingBytes;
  let storedPayload = ydocState;
  let content = "";
  let charCount = 0;
  let tags: string[] = [];
  let stateVectorMatches = true;
  if (isEncrypted) {
    if (
      typeof salt !== "string" || salt.length < 16 || salt.length > 512
      || typeof check !== "string" || check.length < 16 || check.length > 2048
      || !Number.isSafeInteger(iterations) || Number(iterations) < 100_000
      || Number(iterations) > 2_000_000
    ) return fail("invalid_state");
  } else {
    if (salt !== null || check !== null || iterations !== null) {
      return fail("invalid_state");
    }
    try {
      const merged = mergePlainYjsSnapshot(
        storedBytes,
        incomingBytes,
        Y as unknown as YjsAdapter,
      );
      payloadBytes = merged.payload;
      stateVectorMatches = stateVectorsEqual(merged.stateVector, requestedStateVector);
      content = merged.content;
      charCount = content.length;
      tags = extractTags(content);
      storedPayload = encodeStandardBase64(payloadBytes);
    } catch {
      return fail("invalid_state");
    }
  }
  if (payloadBytes.byteLength > 4_194_304 || storedPayload.length > MAX_ENCODED_PAYLOAD_CHARS) {
    return fail("invalid");
  }

  const config = await dependencies.realtimeSigningConfig();
  const roomId = await deriveOpaqueRoomId(config.roomHmacKey, context.noteId, generation);
  const writeMacKey = await deriveWriteMacKey(config.writeMacMasterKey, roomId, generation);
  const expectedMac = await computeCasExpectedMac({
    writeMacKey,
    roomId,
    generation,
    expectedRevision,
    // MAC authenticates the bytes supplied by the client. For plaintext notes,
    // payloadBytes may be a different canonical full snapshot after merge.
    payload: incomingBytes,
    permissionEpoch,
    stateVector: requestedStateVector,
  });

  const { data: saved, error: saveError } = await dependencies.rpc(
    "capability_note_realtime_save",
    {
      p_slug: slug,
      p_auth_user_id: auth.userId,
      p_expected_revision: expectedRevision,
      p_generation: generation,
      p_permission_epoch: permissionEpoch,
      p_ydoc_state: storedPayload,
      p_content: content,
      p_char_count: charCount,
      p_tags: tags,
      p_is_encrypted: isEncrypted,
      p_salt: salt,
      p_check: check,
      p_iterations: iterations,
      p_expected_mac: byteaHex(expectedMac),
      p_presented_mac: byteaHex(presentedMac),
      p_state_vector: byteaHex(requestedStateVector),
      p_state_vector_matches: stateVectorMatches,
      p_replace_generation: replacing,
    },
  );
  if (saveError) return fail("unavailable");
  if (rpcStatus(saved) !== "ok") return fail(rpcStatus(saved));

  // This is deliberately after the save RPC transaction has committed.
  const committed = await savedAckForCommittedCas(saved, config);
  if (committed.status !== "ok" || !committed.savedAck) return fail("unavailable");
  return dependencies.capabilityJson({
    status: "ok",
    savedAck: committed.savedAck,
    roomId: committed.roomId,
    generation: committed.generation,
    revision: committed.revision,
  }, 200);
}
