import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  handleLegacyNoteOpen,
  type LegacyNoteLookup,
  type LegacyNoteRow,
} from "../../supabase/functions/legacy-note-open/handler.ts";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

const endpoint = "https://db.example/functions/v1/legacy-note-open";

const plaintext: LegacyNoteRow = {
  slug: "daily",
  content: "hello",
  ydoc_state: "YQ",
  is_encrypted: false,
  enc_salt: null,
  enc_check: null,
  enc_iterations: 100000,
};

function memoryLookup(
  rows: Record<string, LegacyNoteRow | null | "unavailable">,
): LegacyNoteLookup {
  return {
    async exists(slug) {
      const row = rows[slug];
      if (row === "unavailable") return "unavailable";
      return row != null;
    },
    async open(slug) {
      const row = rows[slug];
      if (row === "unavailable") return "unavailable";
      return row ?? null;
    },
  };
}

function request(method: string, body?: unknown, url = endpoint) {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: method === "GET" || method === "HEAD" || body === undefined
      ? undefined
      : JSON.stringify(body),
  });
}

async function read(response: Response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    cdnCacheControl: response.headers.get("cdn-cache-control"),
    allowMethods: response.headers.get("access-control-allow-methods"),
    allowCredentials: response.headers.get("access-control-allow-credentials"),
    contentType,
    text,
    json: contentType?.includes("application/json") && text
      ? JSON.parse(text) as unknown
      : null,
  };
}

describe("legacy-note-open HTTP contract", () => {
  it("answers OPTIONS with ok and no-store CORS for POST", async () => {
    const result = await read(await handleLegacyNoteOpen(request("OPTIONS"), null));
    expect(result.status).toBe(200);
    expect(result.text).toBe("ok");
    expect(result.cacheControl).toBe("no-store");
    expect(result.cdnCacheControl).toBe("no-store");
    expect(result.allowMethods).toBe("POST, OPTIONS");
    expect(result.allowCredentials).toBeNull();
  });

  it.each(["GET", "HEAD", "PUT", "DELETE"])(
    "rejects %s with method not allowed instead of found:false",
    async (method) => {
      const result = await read(await handleLegacyNoteOpen(request(method), memoryLookup({})));
      expect(result.status).toBe(405);
      expect(result.json).toEqual({ error: "method not allowed" });
      expect(result.cacheControl).toBe("no-store");
      expect(result.cdnCacheControl).toBe("no-store");
      expect(result.contentType).toMatch(/application\/json/);
    },
  );

  it.each([
    [{}, "missing action"],
    [{ action: "open" }, "missing slug"],
    [{ action: "dump", slug: "daily" }, "unknown action"],
    [{ action: "open", slug: "echo-this-slug!" }, "invalid charset"],
    [{ action: "exists", slug: "note" }, "reserved note"],
    [{ action: "exists", slug: "privacy" }, "reserved privacy"],
    [{ action: "exists", slug: "s" }, "reserved s"],
    [{ action: "exists", slug: "Privacy" }, "reserved Privacy"],
  ])("returns 400 invalid request without echoing the slug for %s", async (body) => {
    const result = await read(
      await handleLegacyNoteOpen(request("POST", body), memoryLookup({ daily: plaintext })),
    );
    expect(result.status).toBe(400);
    expect(result.json).toEqual({ error: "invalid request" });
    expect(result.cacheControl).toBe("no-store");
    expect(result.text).not.toContain("echo-this-slug!");
  });

  it("returns 400 for unparsable JSON", async () => {
    const result = await read(await handleLegacyNoteOpen(new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), memoryLookup({})));
    expect(result.status).toBe(400);
    expect(result.json).toEqual({ error: "invalid request" });
  });

  it("returns exists true/false without note bytes", async () => {
    const lookup = memoryLookup({ daily: plaintext });
    const found = await read(
      await handleLegacyNoteOpen(request("POST", { action: "exists", slug: "daily" }), lookup),
    );
    const missing = await read(
      await handleLegacyNoteOpen(request("POST", { action: "exists", slug: "missing" }), lookup),
    );
    expect(found).toMatchObject({
      status: 200,
      cacheControl: "no-store",
      cdnCacheControl: "no-store",
      json: { exists: true },
    });
    expect(found.json).not.toHaveProperty("note");
    expect(missing.json).toEqual({ exists: false });
  });

  it("opens a visible legacy row as camelCase LegacyNote", async () => {
    const result = await read(await handleLegacyNoteOpen(
      request("POST", { action: "open", slug: "daily" }),
      memoryLookup({ daily: { ...plaintext, content: null, ydoc_state: null } }),
    ));
    expect(result.status).toBe(200);
    expect(result.cacheControl).toBe("no-store");
    expect(result.json).toEqual({
      exists: true,
      note: {
        slug: "daily",
        content: "",
        ydocState: "",
        isEncrypted: false,
        salt: null,
        check: null,
        iterations: 100000,
      },
    });
  });

  it("treats a missing visible row as exists false", async () => {
    const result = await read(await handleLegacyNoteOpen(
      request("POST", { action: "open", slug: "daily" }),
      memoryLookup({}),
    ));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ exists: false });
  });

  it("requires encrypted salt, check, and iterations", async () => {
    const result = await read(await handleLegacyNoteOpen(
      request("POST", { action: "open", slug: "locked" }),
      memoryLookup({
        locked: {
          slug: "locked",
          content: "",
          ydoc_state: "cipher",
          is_encrypted: true,
          enc_salt: null,
          enc_check: "check",
          enc_iterations: 600000,
        },
      }),
    ));
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ error: "temporarily unavailable" });
    expect(result.cacheControl).toBe("no-store");
  });

  it("ignores query locators and Bearer credentials", async () => {
    const result = await read(await handleLegacyNoteOpen(
      new Request(`${endpoint}?slug=other&token=secret`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ action: "open", slug: "daily" }),
      }),
      memoryLookup({ daily: plaintext }),
    ));
    expect(result.status).toBe(200);
    expect((result.json as { note: { slug: string } }).note.slug).toBe("daily");
    expect(result.text).not.toContain("secret-token");
    expect(result.text).not.toContain("other");
  });

  it("fails closed when the lookup is unavailable", async () => {
    const missingEnv = await read(await handleLegacyNoteOpen(
      request("POST", { action: "exists", slug: "daily" }),
      null,
    ));
    const dbError = await read(await handleLegacyNoteOpen(
      request("POST", { action: "open", slug: "daily" }),
      memoryLookup({ daily: "unavailable" }),
    ));
    expect(missingEnv.status).toBe(503);
    expect(dbError.status).toBe(503);
    expect(missingEnv.json).toEqual({ error: "temporarily unavailable" });
  });
});

describe("legacy-note-open source pin", () => {
  const index = source("supabase/functions/legacy-note-open/index.ts");
  const handler = source("supabase/functions/legacy-note-open/handler.ts");
  const config = source("supabase/config.toml");

  it("keeps verify_jwt disabled and the hard-wired function name", () => {
    expect(config).toMatch(/\[functions\.legacy-note-open\]\s*verify_jwt = false/);
    expect(source("src/lib/legacy/cutover.ts")).toContain('const LEGACY_NOTE_OPEN = "legacy-note-open"');
  });

  it("uses a service-role SELECT with the visibility predicate and no writes", () => {
    expect(index).toContain("SUPABASE_URL");
    expect(index).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(index).toContain("createClient");
    expect(index).toContain('.from("notes")');
    expect(index).toContain(".select(");
    expect(index).toContain('.eq("slug", slug)');
    expect(index).toContain('.eq("capability_managed", false)');
    expect(index).toContain('.eq("sync_status", "legacy")');
    expect(index).toContain('.is("deleted_at", null)');
    expect(index).not.toMatch(/\.insert\s*\(/);
    expect(index).not.toMatch(/\.update\s*\(/);
    expect(index).not.toMatch(/\.delete\s*\(/);
    expect(index).not.toMatch(/\.upsert\s*\(/);
    expect(index).not.toMatch(/\.rpc\s*\(/);
    expect(handler).not.toMatch(/\.insert\s*\(/);
    expect(handler).not.toMatch(/\.update\s*\(/);
    expect(handler).not.toMatch(/\.delete\s*\(/);
    expect(`${index}\n${handler}`).not.toContain("searchParams");
    expect(`${index}\n${handler}`).not.toContain("console.log");
    expect(`${index}\n${handler}`).not.toMatch(/status:\s*410/);
    expect(handler).toContain("isUsableSlug");
    expect(handler).toContain("../_shared/slug.ts");
  });

  it("does not restore a locator dump or query-token reader", () => {
    expect(index).not.toContain("found: false");
    expect(handler).not.toContain("found: false");
    expect(`${index}\n${handler}`).not.toContain("s-maxage");
    expect(`${index}\n${handler}`).not.toContain("stale-while-revalidate");
    expect(index).toMatch(/SELECT-only|SELECT only|select-only/i);
    expect(index).toMatch(/HMAC CF-Connecting-IP admission is omitted/);
    expect(index).toMatch(/No Turnstile/);
  });
});

describe("legacy-note-open docs", () => {
  it("records Phase B as a read-only exact-match Edge, not a Git 410 tombstone", () => {
    const findings = source("docs/security-findings.md");
    expect(findings).toContain("Phase B");
    expect(findings).toContain("exact-match");
    expect(findings).toContain("SELECT-only");
    expect(findings).toContain("attested separately");
    expect(findings).not.toContain(
      "committed `legacy-note-open` Edge function is a generic `410 no-store` tombstone",
    );
    expect(findings).toContain("Do not POST a locator to production");
    expect(findings).toContain("PR #56 (`eab48218`)");
    expect(findings).toContain("re-pinned 2026-09-02 ~06:20 ICT");
    expect(findings).not.toContain("GitHub source tombstone was PR #43");
    expect(findings).not.toContain("production remains 404 not-deployed");
    expect(findings).not.toContain("Do not claim a production 410 deploy");

    const capability = source("docs/capability-backend.md");
    expect(capability).toContain("exact-match `legacy-note-open` Edge Function");
    expect(capability).not.toContain(
      "leftover callers of that name get `410`, not note bytes",
    );
    expect(capability).toContain("security-findings.md");
    expect(capability).toContain("§1b");
    expect(capability).toContain("Live writes remain the legacy `NotePage` path");
    expect(capability).toContain("SQL 240 is not applied");
    expect(capability).toContain("Do not restore a dump");
    expect(capability).toContain("browser roles still have no table grants");
    expect(capability).toContain("HMAC CF-Connecting-IP admission is omitted");
    expect(capability).toContain("never restore");

    const cutover = source("docs/security/atomic-capability-cutover.md");
    expect(cutover).not.toContain(
      "Deploy `legacy-note-open`, the capability functions",
    );
    expect(cutover).not.toContain(
      "already the generic `410 no-store` tombstone",
    );
    expect(cutover).not.toContain(
      "Keep `legacy-note-open` as the generic `410 no-store` tombstone",
    );
    expect(cutover).toContain("Keep `legacy-note-open` exact-match/read-only");
    expect(cutover).toContain("Capability functions are SHA-pinned");
    expect(cutover).toContain(
      "Deploy share compatibility code and the Cloudflare Worker",
    );
    expect(cutover).toContain("Do not restore a dump");
    expect(cutover).toContain(
      "A legacy URL is exact-match, read-only, and `no-store`.",
    );
    expect(cutover).toContain("Never restore");
    expect(cutover).toContain("anon");
  });
});
