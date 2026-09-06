import { isUsableSlug } from "../_shared/slug.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export type LegacyNoteRow = {
  slug: string;
  content: string | null;
  ydoc_state: string | null;
  is_encrypted: boolean | null;
  enc_salt: string | null;
  enc_check: string | null;
  enc_iterations: number | null;
};

export type LegacyNoteLookup = {
  exists(slug: string): Promise<boolean | "unavailable">;
  open(slug: string): Promise<LegacyNoteRow | null | "unavailable">;
};

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
      "cache-control": "no-store",
      "cdn-cache-control": "no-store",
    },
  });
}

function noStoreCors() {
  return {
    ...corsHeaders,
    "cache-control": "no-store",
    "cdn-cache-control": "no-store",
  };
}

function mapLegacyNote(row: LegacyNoteRow, slug: string) {
  if (row.slug !== slug) return null;
  const isEncrypted = !!row.is_encrypted;
  const salt = row.enc_salt ?? null;
  const check = row.enc_check ?? null;
  const iterations = row.enc_iterations ?? null;
  if (
    isEncrypted
    && (
      typeof salt !== "string"
      || salt.length === 0
      || typeof check !== "string"
      || check.length === 0
      || !Number.isSafeInteger(iterations)
    )
  ) return null;
  return {
    slug: row.slug,
    content: row.content ?? "",
    ydocState: row.ydoc_state ?? "",
    isEncrypted,
    salt,
    check,
    iterations,
  };
}

export async function handleLegacyNoteOpen(
  req: Request,
  lookup: LegacyNoteLookup | null,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: noStoreCors() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const maxRequestBytes = 256;
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > maxRequestBytes) {
    return jsonResponse({ error: "invalid request" }, 400);
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse({ error: "invalid request" }, 400);
  }
  if (new TextEncoder().encode(raw).byteLength > maxRequestBytes) {
    return jsonResponse({ error: "invalid request" }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "invalid request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid request" }, 400);
  }

  const action = (body as { action?: unknown }).action;
  const slug = (body as { slug?: unknown }).slug;
  if (
    (action !== "exists" && action !== "open")
    || typeof slug !== "string"
    || !isUsableSlug(slug)
  ) {
    return jsonResponse({ error: "invalid request" }, 400);
  }

  if (!lookup) return jsonResponse({ error: "temporarily unavailable" }, 503);

  try {
    if (action === "exists") {
      const found = await lookup.exists(slug);
      if (found === "unavailable") {
        return jsonResponse({ error: "temporarily unavailable" }, 503);
      }
      return jsonResponse({ exists: found }, 200);
    }

    const row = await lookup.open(slug);
    if (row === "unavailable") {
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    }
    if (!row) return jsonResponse({ exists: false }, 200);
    const note = mapLegacyNote(row, slug);
    // Incomplete encrypted metadata is fail-closed 503, not exists:false:
    // the row matched the visibility predicate but cannot be mapped safely.
    if (!note) return jsonResponse({ error: "temporarily unavailable" }, 503);
    return jsonResponse({ exists: true, note }, 200);
  } catch {
    return jsonResponse({ error: "temporarily unavailable" }, 503);
  }
}
