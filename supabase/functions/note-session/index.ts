import {
  createCapabilityToken,
  decodeCapabilityPayload,
  hashCapabilityAdmissionSubject,
  hashCapabilityToken,
  readCapabilityBearer,
} from "../_shared/capability.ts";
import {
  capabilityCorsHeaders,
  capabilityAdmissionFailure,
  capabilityEnvironment,
  capabilityFailure,
  capabilityJson,
  capabilityTokenHash,
  materializeNoteSession,
  resolveMaterialization,
  rpcStatus,
  verifyRealtimeAuth,
} from "../_shared/capability-edge.ts";
import {
  deriveOpaqueRoomId,
  issueRealtimeTicketFromContext,
  loadRealtimeSigningConfig,
  type RealtimeSigningConfig,
} from "../_shared/realtime-edge.ts";
import {
  handleRealtimeCasRequest,
  realtimeFailure as mapRealtimeFailure,
} from "./realtime-cas-handler.ts";
import { isUsableSlug } from "../_shared/slug.ts";
const UPDATE_ID_RE = /^[a-f0-9]{64}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_ENCODED_PAYLOAD_CHARS = 5_592_406;

function realtimeSigningConfig(): Promise<RealtimeSigningConfig> {
  return loadRealtimeSigningConfig({
    ticketPrivateJwk: Deno.env.get("SNOTE_REALTIME_TICKET_PRIVATE_JWK") ?? "",
    ticketKid: Deno.env.get("SNOTE_REALTIME_TICKET_KID") ?? "",
    savedAckPrivateJwk: Deno.env.get("SNOTE_REALTIME_SAVED_ACK_PRIVATE_JWK") ?? "",
    savedAckKid: Deno.env.get("SNOTE_REALTIME_SAVED_ACK_KID") ?? "",
    hubId: Deno.env.get("SNOTE_REALTIME_HUB_ID") ?? "",
    assignmentEpoch: Deno.env.get("SNOTE_REALTIME_ASSIGNMENT_EPOCH") ?? "",
    roomHmacKey: Deno.env.get("SNOTE_REALTIME_ROOM_HMAC_KEY") ?? "",
    writeMacMasterKey: Deno.env.get("SNOTE_REALTIME_WRITE_MAC_MASTER_KEY") ?? "",
  });
}

function realtimeFailure(status: string): Response {
  return mapRealtimeFailure(status, { capabilityJson, capabilityFailure });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: capabilityCorsHeaders });
  if (req.method !== "POST") return capabilityJson({ error: "method not allowed" }, 405);

  const environment = capabilityEnvironment();
  if (!environment.ok) return capabilityFailure("unavailable");

  try {
    const body = await req.json().catch(() => ({}));
    const bearer = readCapabilityBearer(req);

    if (body?.action === "realtime-ticket") {
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
      if (!isUsableSlug(slug) || !SESSION_ID_RE.test(sessionId)) return realtimeFailure("invalid");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");
      if (auth.mode !== "private-realtime") return realtimeFailure("unauthorized");

      const { data: context, error: contextError } = await environment.client.rpc(
        "capability_note_realtime_ticket_context",
        { p_slug: slug, p_auth_user_id: auth.userId },
      );
      if (contextError) return capabilityFailure("unavailable");
      if (rpcStatus(context) !== "ok") return realtimeFailure(rpcStatus(context));

      const config = await realtimeSigningConfig();
      const issued = await issueRealtimeTicketFromContext({ ...context, sessionId }, config);
      if (!issued.ok) return realtimeFailure(issued.status);
      return capabilityJson(issued.ticket, 200);
    }

    if (body?.action === "realtime-cas-save" || body?.action === "realtime-replace") {
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      if (!isUsableSlug(slug)) return realtimeFailure("invalid");
      return handleRealtimeCasRequest(req, body, slug, {
        rpc: async (name, args) => {
          const { data, error } = await environment.client.rpc(name, args as never);
          return { data, error };
        },
        verifyRealtimeAuth: (request) => verifyRealtimeAuth(request, environment),
        realtimeSigningConfig,
        capabilityJson,
        capabilityFailure,
      });
    }
    if (body?.action === "plain-upsert") {
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      const ydocState = typeof body?.ydocState === "string" ? body.ydocState : "";
      const content = typeof body?.content === "string" ? body.content : "";
      const charCount = Number(body?.charCount);
      const tags = body?.tags;
      const isEncrypted = body?.isEncrypted;
      const salt = body?.salt ?? null;
      const check = body?.check ?? null;
      const iterations = body?.iterations ?? null;
      const tagsValid = Array.isArray(tags)
        && tags.length <= 20
        && tags.every((tag) => typeof tag === "string" && /^[a-z0-9_-]{1,32}$/.test(tag));
      const encryptionMetadataValid = isEncrypted === true
        ? typeof salt === "string" && salt.length >= 16 && salt.length <= 512
          && typeof check === "string" && check.length >= 16 && check.length <= 2048
          && Number.isSafeInteger(iterations) && iterations >= 100_000 && iterations <= 2_000_000
          && content === ""
          && charCount === 0
          && Array.isArray(tags) && tags.length === 0
        : isEncrypted === false && salt === null && check === null && iterations === null;
      if (
        !isUsableSlug(slug)
        || ydocState.length > MAX_ENCODED_PAYLOAD_CHARS
        || content.length > 1_048_576
        || !Number.isSafeInteger(charCount)
        || charCount < 0
        || charCount > 1_048_576
        || !tagsValid
        || !encryptionMetadataValid
      ) return capabilityFailure("invalid");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");
      const subjectHash = await hashCapabilityAdmissionSubject(req, environment.hmacSecret);
      if (!subjectHash) return capabilityFailure("unavailable");
      const { data: admitted, error: admissionError } = await environment.client.rpc(
        "capability_admission_consume",
        {
          p_operation: "sync",
          p_subject_hash: subjectHash,
          p_request_cost: 1,
          p_byte_cost: ydocState.length,
        },
      );
      if (admissionError) return capabilityFailure("unavailable");
      if (rpcStatus(admitted) !== "ok") {
        return capabilityAdmissionFailure(rpcStatus(admitted));
      }
      const { data: upserted, error: upsertError } = await environment.client.rpc(
        "capability_note_plain_upsert",
        {
          p_slug: slug,
          p_ydoc_state: ydocState,
          p_content: content,
          p_char_count: charCount,
          p_tags: tags,
          p_is_encrypted: isEncrypted,
          p_salt: salt,
          p_check: check,
          p_iterations: iterations,
        },
      );
      if (upsertError || rpcStatus(upserted) !== "ok") {
        return capabilityFailure(upsertError ? "unavailable" : rpcStatus(upserted));
      }
      return capabilityJson({
        status: "ok",
        noteId: upserted?.noteId,
        created: upserted?.created === true,
      }, upserted?.created === true ? 201 : 200);
    }

    if (body?.action === "disable-secure") {
      if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      const ydocState = typeof body?.ydocState === "string" ? body.ydocState : "";
      const content = typeof body?.content === "string" ? body.content : "";
      const charCount = Number(body?.charCount);
      const tags = body?.tags;
      const isEncrypted = body?.isEncrypted;
      const salt = body?.salt ?? null;
      const check = body?.check ?? null;
      const iterations = body?.iterations ?? null;
      const tagsValid = Array.isArray(tags)
        && tags.length <= 20
        && tags.every((tag) => typeof tag === "string" && /^[a-z0-9_-]{1,32}$/.test(tag));
      const encryptionMetadataValid = isEncrypted === true
        ? typeof salt === "string" && salt.length >= 16 && salt.length <= 512
          && typeof check === "string" && check.length >= 16 && check.length <= 2048
          && Number.isSafeInteger(iterations) && iterations >= 100_000 && iterations <= 2_000_000
          && content === ""
          && charCount === 0
          && Array.isArray(tags) && tags.length === 0
        : isEncrypted === false && salt === null && check === null && iterations === null;
      if (
        !isUsableSlug(slug)
        || ydocState.length > MAX_ENCODED_PAYLOAD_CHARS
        || content.length > 1_048_576
        || !Number.isSafeInteger(charCount)
        || charCount < 0
        || charCount > 1_048_576
        || !tagsValid
        || !encryptionMetadataValid
      ) return capabilityFailure("invalid");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");
      const ownerHash = await capabilityTokenHash(bearer, environment.hmacSecret);
      if (!ownerHash) return capabilityFailure("unavailable");
      const subjectHash = await hashCapabilityAdmissionSubject(req, environment.hmacSecret);
      if (!subjectHash) return capabilityFailure("unavailable");
      const { data: admitted, error: admissionError } = await environment.client.rpc(
        "capability_admission_consume",
        {
          p_operation: "create",
          p_subject_hash: subjectHash,
          p_request_cost: 1,
          p_byte_cost: ydocState.length,
        },
      );
      if (admissionError) return capabilityFailure("unavailable");
      if (rpcStatus(admitted) !== "ok") {
        return capabilityAdmissionFailure(rpcStatus(admitted));
      }
      const { data: disabled, error: disableError } = await environment.client.rpc(
        "capability_note_disable_secure",
        {
          p_owner_token_hash: ownerHash,
          p_slug: slug,
          p_ydoc_state: ydocState,
          p_content: content,
          p_char_count: charCount,
          p_tags: tags,
          p_is_encrypted: isEncrypted,
          p_salt: salt,
          p_check: check,
          p_iterations: iterations,
        },
      );
      if (disableError || rpcStatus(disabled) !== "ok") {
        return capabilityFailure(disableError ? "unavailable" : rpcStatus(disabled));
      }
      return capabilityJson({
        status: "ok",
        noteId: disabled?.noteId,
        recovered: disabled?.recovered === true,
      }, 200);
    }

    if (body?.action === "create") {
      if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      if (!isUsableSlug(slug)) return capabilityFailure("invalid");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");

      const owner = bearer;
      const edit = createCapabilityToken();
      const view = createCapabilityToken();
      const subjectHash = await hashCapabilityAdmissionSubject(req, environment.hmacSecret);
      if (!subjectHash) return capabilityFailure("unavailable");
      const [ownerHash, editHash, viewHash] = await Promise.all([
        hashCapabilityToken(owner, environment.hmacSecret),
        hashCapabilityToken(edit, environment.hmacSecret),
        hashCapabilityToken(view, environment.hmacSecret),
      ]);
      const { data: admitted, error: admissionError } = await environment.client.rpc(
        "capability_admission_consume",
        {
          p_operation: "create",
          p_subject_hash: subjectHash,
          p_request_cost: 1,
          p_byte_cost: 0,
        },
      );
      if (admissionError) return capabilityFailure("unavailable");
      if (rpcStatus(admitted) !== "ok") {
        return capabilityAdmissionFailure(rpcStatus(admitted));
      }
      const { data: created, error: createError } = await environment.client.rpc(
        "capability_note_create",
        {
          p_slug: slug,
          p_owner_token_hash: ownerHash,
          p_edit_token_hash: editHash,
          p_view_token_hash: viewHash,
        },
      );
      if (createError || rpcStatus(created) !== "ok") {
        return capabilityFailure(createError ? "unavailable" : rpcStatus(created));
      }

      const materialized = resolveMaterialization(await materializeNoteSession(
        created?.session,
        ownerHash,
        auth,
        environment,
      ));
      if (!materialized.ok) return materialized.response;
      const capabilities = created?.recovered === true
        ? { owner }
        : { owner, edit, view };
      return capabilityJson(
        { session: materialized.session, capabilities },
        created?.recovered === true ? 200 : 201,
      );
    }

    if (body?.action === "import-legacy") {
      if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      const checkpointId = typeof body?.checkpointId === "string" ? body.checkpointId : "";
      const payload = typeof body?.payload === "string" ? body.payload : "";
      const isEncrypted = body?.isEncrypted;
      const salt = body?.salt ?? null;
      const check = body?.check ?? null;
      const iterations = body?.iterations ?? null;
      const encryptionMetadataValid = isEncrypted === true
        ? typeof salt === "string" && salt.length >= 16 && salt.length <= 512
          && typeof check === "string" && check.length >= 16 && check.length <= 2048
          && Number.isSafeInteger(iterations) && iterations >= 100_000 && iterations <= 2_000_000
        : isEncrypted === false && salt === null && check === null && iterations === null;
      if (
        !isUsableSlug(slug)
        || !UPDATE_ID_RE.test(checkpointId)
        || !PAYLOAD_RE.test(payload)
        || payload.length > MAX_ENCODED_PAYLOAD_CHARS
        || !encryptionMetadataValid
      ) return capabilityFailure("invalid");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");
      let decodedPayload: Uint8Array;
      try {
        decodedPayload = decodeCapabilityPayload(payload, 4_194_304);
      } catch {
        return capabilityFailure("invalid");
      }

      // The client persists this candidate before the first mutating request.
      // A lost response can therefore retry the exact same owner hash.
      const owner = bearer;
      const edit = createCapabilityToken();
      const view = createCapabilityToken();
      const subjectHash = await hashCapabilityAdmissionSubject(req, environment.hmacSecret);
      if (!subjectHash) return capabilityFailure("unavailable");
      const { data: admitted, error: admissionError } = await environment.client.rpc(
        "capability_admission_consume",
        {
          p_operation: "create",
          p_subject_hash: subjectHash,
          p_request_cost: 1,
          p_byte_cost: decodedPayload.byteLength,
        },
      );
      if (admissionError) return capabilityFailure("unavailable");
      if (rpcStatus(admitted) !== "ok") {
        return capabilityAdmissionFailure(rpcStatus(admitted));
      }
      const [ownerHash, editHash, viewHash] = await Promise.all([
        hashCapabilityToken(owner, environment.hmacSecret),
        hashCapabilityToken(edit, environment.hmacSecret),
        hashCapabilityToken(view, environment.hmacSecret),
      ]);
      const { data: created, error: createError } = await environment.client.rpc(
        "capability_note_import_legacy",
        {
          p_slug: slug,
          p_owner_token_hash: ownerHash,
          p_edit_token_hash: editHash,
          p_view_token_hash: viewHash,
          p_checkpoint_id: checkpointId,
          p_payload_text: payload,
          p_is_encrypted: isEncrypted,
          p_salt: salt,
          p_check: check,
          p_iterations: iterations,
        },
      );
      if (createError || rpcStatus(created) !== "ok") {
        return capabilityFailure(createError ? "unavailable" : rpcStatus(created));
      }
      const materialized = resolveMaterialization(await materializeNoteSession(
        created?.session,
        ownerHash,
        auth,
        environment,
      ));
      if (!materialized.ok) return materialized.response;
      const capabilities = created?.recovered === true
        ? { owner }
        : { owner, edit, view };
      return capabilityJson(
        { session: materialized.session, capabilities },
        created?.recovered === true ? 200 : 201,
      );
    }

    if (body?.action === "convert-legacy") {
      if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      const checkpointId = typeof body?.checkpointId === "string" ? body.checkpointId : "";
      const payload = typeof body?.payload === "string" ? body.payload : "";
      const isEncrypted = body?.isEncrypted;
      const salt = body?.salt ?? null;
      const check = body?.check ?? null;
      const iterations = body?.iterations ?? null;
      const encryptionMetadataValid = isEncrypted === true
        ? typeof salt === "string" && salt.length >= 16 && salt.length <= 512
          && typeof check === "string" && check.length >= 16 && check.length <= 2048
          && Number.isSafeInteger(iterations) && iterations >= 100_000 && iterations <= 2_000_000
        : isEncrypted === false && salt === null && check === null && iterations === null;
      if (
        !isUsableSlug(slug)
        || !UPDATE_ID_RE.test(checkpointId)
        || !PAYLOAD_RE.test(payload)
        || payload.length > MAX_ENCODED_PAYLOAD_CHARS
        || !encryptionMetadataValid
      ) return capabilityFailure("invalid");
      if (isEncrypted === true) return capabilityFailure("invalid_state");
      const auth = await verifyRealtimeAuth(req, environment);
      if (auth.mode === "unavailable") return capabilityFailure("unavailable");
      const { data: existing, error: existingError } = await environment.client
        .from("notes")
        .select("is_encrypted")
        .eq("slug", slug)
        .maybeSingle();
      if (existingError) return capabilityFailure("unavailable");
      if (existing?.is_encrypted === true) return capabilityFailure("invalid_state");
      let decodedPayload: Uint8Array;
      try {
        decodedPayload = decodeCapabilityPayload(payload, 4_194_304);
      } catch {
        return capabilityFailure("invalid");
      }

      // The client persists this candidate before the first mutating request.
      // A lost response can therefore retry the exact same owner hash.
      const owner = bearer;
      const edit = createCapabilityToken();
      const view = createCapabilityToken();
      const subjectHash = await hashCapabilityAdmissionSubject(req, environment.hmacSecret);
      if (!subjectHash) return capabilityFailure("unavailable");
      const { data: admitted, error: admissionError } = await environment.client.rpc(
        "capability_admission_consume",
        {
          p_operation: "create",
          p_subject_hash: subjectHash,
          p_request_cost: 1,
          p_byte_cost: decodedPayload.byteLength,
        },
      );
      if (admissionError) return capabilityFailure("unavailable");
      if (rpcStatus(admitted) !== "ok") {
        return capabilityAdmissionFailure(rpcStatus(admitted));
      }
      const [ownerHash, editHash, viewHash] = await Promise.all([
        hashCapabilityToken(owner, environment.hmacSecret),
        hashCapabilityToken(edit, environment.hmacSecret),
        hashCapabilityToken(view, environment.hmacSecret),
      ]);
      const { data: created, error: createError } = await environment.client.rpc(
        "capability_note_convert_legacy",
        {
          p_slug: slug,
          p_owner_token_hash: ownerHash,
          p_edit_token_hash: editHash,
          p_view_token_hash: viewHash,
          p_checkpoint_id: checkpointId,
          p_payload_text: payload,
          p_is_encrypted: isEncrypted,
          p_salt: salt,
          p_check: check,
          p_iterations: iterations,
        },
      );
      if (createError || rpcStatus(created) !== "ok") {
        return capabilityFailure(createError ? "unavailable" : rpcStatus(created));
      }
      const materialized = resolveMaterialization(await materializeNoteSession(
        created?.session,
        ownerHash,
        auth,
        environment,
      ));
      if (!materialized.ok) return materialized.response;
      const capabilities = created?.recovered === true
        ? { owner }
        : { owner, edit, view };
      return capabilityJson(
        { session: materialized.session, capabilities },
        created?.recovered === true ? 200 : 201,
      );
    }

    if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
    const tokenHash = await capabilityTokenHash(bearer, environment.hmacSecret);
    if (!tokenHash) return capabilityFailure("unavailable");
    const auth = await verifyRealtimeAuth(req, environment);
    if (auth.mode === "unavailable") return capabilityFailure("unavailable");
    const afterSequence = Number(body?.afterSequence ?? 0);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return capabilityFailure("invalid");
    }

    const { data, error } = await environment.client.rpc("capability_session_open", {
      p_token_hash: tokenHash,
      p_after_seq: afterSequence,
      p_limit: 200,
    });
    if (error || rpcStatus(data) !== "ok") {
      return capabilityFailure(error ? "unavailable" : rpcStatus(data));
    }
    const materialized = resolveMaterialization(await materializeNoteSession(
      data?.session,
      tokenHash,
      auth,
      environment,
    ));
    return materialized.ok
      ? capabilityJson({ session: materialized.session }, 200)
      : materialized.response;
  } catch {
    return capabilityFailure("unavailable");
  }
});
