import {
  createCapabilityToken,
  decodeCapabilityPayload,
  hashCapabilityToken,
  readCapabilityBearer,
  sha256CapabilityPayload,
  UPDATE_ID_RE,
} from "../_shared/capability.ts";
import {
  capabilityCorsHeaders,
  capabilityEnvironment,
  capabilityFailure,
  capabilityJson,
  capabilityTokenHash,
  materializeNoteSession,
  resolveMaterialization,
  rpcStatus,
  verifyRealtimeAuth,
} from "../_shared/capability-edge.ts";
import { isUsableSlug } from "../_shared/slug.ts";

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: capabilityCorsHeaders });
  if (req.method !== "POST") return capabilityJson({ error: "method not allowed" }, 405);

  const bearer = readCapabilityBearer(req);
  if (!bearer) return capabilityJson({ error: "unauthorized" }, 401);
  const environment = capabilityEnvironment();
  if (!environment.ok) return capabilityFailure("unavailable");

  try {
    const tokenHash = await capabilityTokenHash(bearer, environment.hmacSecret);
    if (!tokenHash) return capabilityFailure("unavailable");
    const auth = await verifyRealtimeAuth(req, environment);
    if (auth.mode === "unavailable") return capabilityFailure("unavailable");
    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "";
    let params: Record<string, unknown> = {};
    let rotated: { scope: "edit" | "view"; capability: string } | null = null;

    if (action === "rename") {
      const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
      if (!isUsableSlug(slug)) return capabilityFailure("invalid");
      params = { slug };
    } else if (action === "delete") {
      params = {};
    } else if (action === "rotate") {
      const scope = body?.scope;
      if (scope !== "edit" && scope !== "view") return capabilityFailure("invalid");
      const capability = createCapabilityToken();
      params = {
        scope,
        tokenHash: await hashCapabilityToken(capability, environment.hmacSecret),
      };
      rotated = { scope, capability };
    } else if (action === "set-encryption") {
      const expectedEncryptionVersion = Number(body?.expectedEncryptionVersion);
      const isEncrypted = body?.isEncrypted;
      const checkpoint = body?.checkpoint;
      const checkpointId = typeof checkpoint?.checkpointId === "string"
        ? checkpoint.checkpointId
        : "";
      const payload = typeof checkpoint?.payload === "string" ? checkpoint.payload : "";
      const throughSequence = Number(checkpoint?.throughSequence);
      if (
        typeof isEncrypted !== "boolean"
        || !Number.isSafeInteger(expectedEncryptionVersion)
        || expectedEncryptionVersion < 0
        || !Number.isSafeInteger(throughSequence)
        || throughSequence < 0
        || !UPDATE_ID_RE.test(checkpointId)
      ) return capabilityFailure("invalid");
      const decoded = decodeCapabilityPayload(payload, MAX_CHECKPOINT_BYTES);
      if (await sha256CapabilityPayload(decoded) !== checkpointId) {
        return capabilityFailure("invalid");
      }
      if (isEncrypted === true) return capabilityFailure("invalid_state");
      params = {
        isEncrypted,
        expectedEncryptionVersion,
        salt: isEncrypted && typeof body?.salt === "string" ? body.salt : null,
        check: isEncrypted && typeof body?.check === "string" ? body.check : null,
        iterations: Number(body?.iterations ?? 100000),
        checkpoint: { checkpointId, payload, throughSequence },
      };
    } else {
      return capabilityFailure("invalid");
    }

    const { data: managed, error: manageError } = await environment.client.rpc(
      "capability_note_manage",
      { p_token_hash: tokenHash, p_action: action, p_params: params },
    );
    if (manageError || rpcStatus(managed) !== "ok") {
      return capabilityFailure(manageError ? "unavailable" : rpcStatus(managed));
    }
    if (action === "delete") return capabilityJson({ ok: true }, 200);

    const { data: opened, error: openError } = await environment.client.rpc(
      "capability_session_open",
      { p_token_hash: tokenHash, p_after_seq: 0, p_limit: 200 },
    );
    if (openError || rpcStatus(opened) !== "ok") return capabilityFailure("unavailable");
    const materialized = resolveMaterialization(await materializeNoteSession(
      opened?.session,
      tokenHash,
      auth,
      environment,
    ));
    if (!materialized.ok) return materialized.response;
    return capabilityJson({
      ok: true,
      session: materialized.session,
      ...(rotated ? { rotated: { scope: rotated.scope, capability: rotated.capability } } : {}),
    }, 200);
  } catch (error) {
    if (error instanceof Error && /payload|invalid/.test(error.message)) {
      return capabilityFailure("invalid");
    }
    return capabilityFailure("unavailable");
  }
});
