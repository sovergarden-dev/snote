import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const CONVERT_MIGRATION =
  "supabase/migrations/20260908000000_capability_note_convert_legacy.sql";

const sqlFunction = (sql: string, functionName: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 4);
};

describe("U1 convert-in-place contract", () => {
  it("adds capability_note_convert_legacy as an in-place UPDATE, not insert/delete", () => {
    const sql = source(CONVERT_MIGRATION);
    const fn = sqlFunction(sql, "capability_note_convert_legacy");

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("pg_advisory_xact_lock(20260908000000)");
    expect(fn).toContain("public.capability_writes_acquire()");
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("capability_managed = false");
    expect(fn).toContain("sync_status = 'legacy'");
    expect(fn).toContain("'not_found'");
    expect(fn).toContain("'slug_unavailable'");
    expect(fn).toContain("'recovered', v_recovered");
    expect(fn).toMatch(/UPDATE public\.notes/);
    expect(fn).toContain("INSERT INTO public.note_capabilities");
    expect(fn).toContain("INSERT INTO public.note_checkpoints");
    expect(fn).toContain("capability_session_open");
    expect(fn).not.toMatch(/INSERT INTO public\.notes/);
    expect(fn).not.toMatch(/DELETE FROM public\.notes/);
    expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]+ON TABLE public\.notes/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.capability_note_convert_legacy[\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_note_convert_legacy[\s\S]+TO service_role/,
    );
  });

  it("wires Edge convert-legacy to the convert RPC and leaves Duplicate on import-legacy", () => {
    const endpoint = source("supabase/functions/note-session/index.ts");
    const convertAt = endpoint.indexOf('if (body?.action === "convert-legacy")');
    const importAt = endpoint.indexOf('if (body?.action === "import-legacy")');
    const tokenHashAt = endpoint.indexOf("const tokenHash = await capabilityTokenHash");
    expect(convertAt).toBeGreaterThan(0);
    expect(importAt).toBeGreaterThan(0);
    expect(tokenHashAt).toBeGreaterThan(convertAt);

    const convertBranch = endpoint.slice(convertAt, convertAt < importAt ? importAt : tokenHashAt);
    const importBranch = endpoint.slice(importAt, importAt < convertAt ? convertAt : tokenHashAt);

    expect(convertBranch).toContain('"capability_note_convert_legacy"');
    expect(convertBranch).not.toContain('"capability_note_import_legacy"');
    expect(convertBranch).toContain('"capability_admission_consume"');
    expect(convertBranch).toContain("decodeCapabilityPayload");
    expect(importBranch).toContain('"capability_note_import_legacy"');
    expect(importBranch).not.toContain('"capability_note_convert_legacy"');

    expect(source("src/lib/legacy/cutover.ts")).toContain("importLegacyNote");
    expect(source("src/pages/LegacyNotePage.tsx")).toContain("duplicateLegacyNote");
  });

  it("converts plain LNO notes through note-session convert-legacy, never the SQL name", () => {
    const convert = source("src/lib/legacy/convert-on-write.ts");
    const client = source("src/lib/capability/client.ts");
    const spa = [
      convert,
      client,
      source("src/pages/NotePage.tsx"),
      source("src/pages/LegacyNotePage.tsx"),
      source("src/lib/legacy/cutover.ts"),
    ].join("\n");

    expect(convert).toContain("convertLegacyNote");
    expect(convert).toContain("targetSlug: input.slug");
    expect(convert).not.toContain("input.api.createNote");
    expect(client).toContain('action: "convert-legacy"');
    expect(client).toContain('action: "import-legacy"');
    expect(spa).not.toContain("capability_note_convert_legacy");
    expect(convert).not.toContain('from("notes")');
    expect(client).not.toContain('from("notes")');
    expect(source("src/pages/LegacyNotePage.tsx")).not.toContain('from("notes")');
    expect(source("src/lib/legacy/cutover.ts")).not.toContain('from("notes")');
    expect(source("supabase/functions/_shared/capability-edge.ts")).toContain(
      "capability_note_convert_legacy:",
    );
    expect(source("supabase/functions/_shared/capability-edge.ts")).toMatch(
      /status === "not_found"[\s\S]+404/,
    );
  });
});
