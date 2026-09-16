import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const BULK_MIGRATION =
  "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql";
const DISABLE_MIGRATION =
  "supabase/migrations/20260915000001_capability_note_disable_secure.sql";
const RUNBOOK = "docs/security/bulk-disable-secure-ops.md";

const sqlFunction = (sql: string, functionName: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 4);
};

describe("B1 bulk disable-secure contract", () => {
  it("adds a service-role-only bulk reshape RPC without notes GRANTs or Edge/SPA wiring", () => {
    const sql = source(BULK_MIGRATION);
    const fn = sqlFunction(sql, "capability_note_bulk_disable_secure");
    const disable = sqlFunction(source(DISABLE_MIGRATION), "capability_note_disable_secure");

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(sql).toContain("pg_advisory_xact_lock(20260916000000)");
    expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]+ON TABLE public\.notes/);
    expect(sql).not.toMatch(/GRANT .+ ON TABLE public\.notes/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.capability_note_bulk_disable_secure[\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_note_bulk_disable_secure[\s\S]+TO service_role/,
    );

    expect(fn).toContain("p_limit integer");
    expect(fn).toContain("p_include_encrypted boolean DEFAULT false");
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("SET search_path = pg_catalog, pg_temp");
    expect(fn).toContain("public.capability_writes_acquire()");
    expect(fn).toContain("pg_advisory_xact_lock(20260916000000)");
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("capability_managed");
    expect(fn).toContain("deleted_at IS NULL");
    expect(fn).toContain("is_encrypted");
    expect(fn).toContain("FROM public.note_checkpoints");
    expect(fn).toContain("ORDER BY checkpoint.version DESC");
    expect(fn).toContain("DELETE FROM public.notes");
    expect(fn).toContain("INSERT INTO public.notes");
    expect(fn).toContain("'legacy'");
    expect(fn).toContain("'converted'");
    expect(fn).toContain("'skipped_encrypted'");
    expect(fn).toContain("'skipped_not_managed'");
    expect(fn).toContain("'errors'");
    expect(fn).toContain("'slug'");
    expect(fn).toContain("'noteId'");
    expect(fn).not.toContain("capability_note_convert_legacy");
    expect(fn).not.toContain("capability_note_plain_upsert");

    expect(disable).toContain("DELETE FROM public.notes");
    expect(disable).toContain("INSERT INTO public.notes");

    expect(source("supabase/functions/note-session/index.ts"))
      .not.toContain("capability_note_bulk_disable_secure");
    expect(source("supabase/functions/_shared/capability-edge.ts"))
      .not.toContain("capability_note_bulk_disable_secure");
    expect(source("src/lib/legacy/legacy-secure-pin.ts")).toContain("snote:legacy-secure:");
    expect(source("src/integrations/supabase/types.ts"))
      .toContain("capability_note_bulk_disable_secure:");
  });

  it("records live Go A+B PASS, origin unchanged, and Go C pin heal HOLD", () => {
    const runbook = source(RUNBOOK);
    expect(runbook).toContain("capability_note_bulk_disable_secure");
    expect(runbook).toContain("service_role");
    expect(runbook).toContain("skipped_encrypted");
    expect(runbook).toContain("note_id");
    expect(runbook).toMatch(/Go C/i);
    expect(runbook).toContain("HOLD");
    expect(runbook).toContain("**applied** live");
    expect(runbook).toContain("does not re-apply");
    expect(runbook).toContain("attestation");
    expect(runbook).toContain("0cdcdc0f");
    expect(runbook).toContain("bd11deed");
    expect(runbook).toContain(
      "a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850",
    );
    expect(runbook).toContain("26→0");
    expect(runbook).toContain("snote:legacy-secure:");
    expect(runbook).toContain("/workspace/pulse-bulk-off-ab2c4de9/");
    expect(runbook).toContain("/workspace/pixel-qa/bulk-off-verify/");
    expect(runbook).toContain("/workspace/sentinel-qa-bulk-off-live/");
    expect(runbook).not.toContain("supabase db push");
    expect(runbook).not.toContain("convert-legacy");
  });
});
