import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const BULK_MIGRATION =
  "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql";
const ALLOWLIST_MIGRATION =
  "supabase/migrations/20260922000000_capability_note_bulk_disable_secure_p_slugs.sql";
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

  it("records historical Go A+B PASS, Go C ship, and re-bulk OFF ALL 6 on origin 9a80930a", () => {
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
    expect(runbook).toContain("9a80930a");
    expect(runbook).toContain("bd11deed");
    expect(runbook).toContain(
      "a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850",
    );
    expect(runbook).toContain("26→0");
    expect(runbook).toContain("managed_live=3");
    expect(runbook).toContain("managed_live=0");
    expect(runbook).toContain("converted=6");
    expect(runbook).toContain("no re-migrate");
    expect(runbook).toContain("snote:legacy-secure:");
    expect(runbook).toContain("/workspace/pulse-bulk-off-ab2c4de9/");
    expect(runbook).toContain("/workspace/pulse-rebulk-all6-20260922/");
    expect(runbook).toContain("/workspace/pixel-qa/bulk-off-verify/");
    expect(runbook).toContain("/workspace/sentinel-qa-go-c-live/");
    expect(runbook).toContain("/workspace/sentinel-qa-rebulk-all6-live/");
    expect(runbook).toContain("shipped");
    expect(runbook).toContain("gr3l8g5e");
    expect(runbook).toContain("svgocc0360f59afa");
    expect(runbook).toContain("x915930e");
    expect(runbook).toContain("Pulse post-verify");
    expect(runbook).not.toContain("supabase db push");
    expect(runbook).not.toContain("convert-legacy");
  });

  it("hard-drops the 2-arg RPC and creates a 3-arg allowlist function", () => {
    const sql = source(ALLOWLIST_MIGRATION);
    const fn = sqlFunction(sql, "capability_note_bulk_disable_secure");
    const types = source("src/integrations/supabase/types.ts");

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(createHash("sha256").update(sql, "utf8").digest("hex")).toBe(
      "f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132",
    );
    expect(source(RUNBOOK)).toContain(
      "f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132",
    );
    expect(sql).toMatch(/Do not apply this migration from the GitHub PR/);
    expect(sql).toContain("pg_advisory_xact_lock(20260916000000)");
    expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]+ON TABLE public\.notes/);
    expect(sql).not.toMatch(/GRANT .+ ON TABLE public\.notes/);

    expect(sql).toMatch(
      /DROP FUNCTION public\.capability_note_bulk_disable_secure\(\s*integer,\s*boolean\s*\);/,
    );
    expect(sql).not.toMatch(
      /DROP FUNCTION IF EXISTS public\.capability_note_bulk_disable_secure\(\s*integer,\s*boolean/,
    );
    expect(sql).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION public\.capability_note_bulk_disable_secure\(\s*p_limit integer,\s*p_include_encrypted boolean DEFAULT false\s*\)/,
    );

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.capability_note_bulk_disable_secure[\s\S]+integer,\s*boolean,\s*text\[][\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_note_bulk_disable_secure[\s\S]+integer,\s*boolean,\s*text\[][\s\S]+TO service_role/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_note_bulk_disable_secure\(\s*integer,\s*boolean\s*\)/,
    );

    expect(fn).toContain("p_limit integer");
    expect(fn).toContain("p_include_encrypted boolean DEFAULT false");
    expect(fn).toContain("p_slugs text[] DEFAULT NULL");
    expect(fn.indexOf("p_include_encrypted boolean DEFAULT false"))
      .toBeGreaterThan(fn.indexOf("p_limit integer"));
    expect(fn.indexOf("p_slugs text[] DEFAULT NULL"))
      .toBeGreaterThan(fn.indexOf("p_include_encrypted boolean DEFAULT false"));
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("SET search_path = pg_catalog, pg_temp");
    expect(fn).toContain("public.capability_writes_acquire()");
    expect(fn).toContain("pg_advisory_xact_lock(20260916000000)");
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toContain("DELETE FROM public.notes");
    expect(fn).toContain("INSERT INTO public.notes");
    expect(fn).toContain("'legacy'");
    expect(fn).toContain("p_slugs IS NULL");
    expect(fn).toContain("cardinality(p_slugs) > 0");
    expect(fn).toContain("cardinality(p_slugs) > 10000");
    expect(fn).toMatch(/n\.slug = ANY\s*\(\s*p_slugs\s*\)/);
    expect(fn).toContain("'scope'");
    expect(fn).toContain("'fleet'");
    expect(fn).toContain("'allowlist'");
    expect(fn).toContain("'allowlist_requested'");
    expect(fn).toContain("'allowlist_matched_managed'");
    expect(fn).toContain("'skipped_allowlist_miss'");
    expect(fn).toContain("'skipped_limit'");
    expect(fn).toContain("'status'");
    expect(fn).toContain("'converted'");
    expect(fn).toContain("'skipped_encrypted'");
    expect(fn).toContain("'skipped_not_managed'");
    expect(fn).toContain("'errors'");
    expect(fn).toContain("p_include_encrypted OR NOT n.is_encrypted");
    expect(fn).not.toContain("p_strict");
    expect(fn).not.toMatch(/lower\s*\(\s*n\.slug/);
    expect(fn).not.toMatch(/btrim\s*\(\s*n\.slug/);
    expect(fn).not.toMatch(/lower\s*\(\s*p_slugs/);
    expect(fn).not.toContain("capability_note_convert_legacy");
    expect(fn).not.toContain("capability_note_plain_upsert");

    expect(types).toContain("capability_note_bulk_disable_secure:");
    expect(types).toContain("p_slugs?: string[]");
    expect(source("supabase/functions/note-session/index.ts"))
      .not.toContain("capability_note_bulk_disable_secure");
    expect(source("supabase/functions/_shared/capability-edge.ts"))
      .not.toContain("capability_note_bulk_disable_secure");
  });

  it("records Go SQL allowlist p_slugs applied live without fleet OFF or origin ship", () => {
    const runbook = source(RUNBOOK);
    expect(runbook).toContain("**applied live**");
    expect(runbook).not.toContain("**not applied**");
    expect(runbook).not.toContain("GitHub-only");
    expect(runbook).not.toContain("Live production still has the 2-arg");
    expect(runbook).toContain("p_slugs");
    expect(runbook).toContain("20260922000000_capability_note_bulk_disable_secure_p_slugs.sql");
    expect(runbook).toContain("46ddaf01");
    expect(runbook).toContain("46ddaf012bea1d01a6235e2be7e9132555d6cd84");
    expect(runbook).toContain(
      "f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132",
    );
    expect(runbook).toContain("/workspace/pulse-allowlist-sql-46ddaf01/");
    expect(runbook).toContain("/workspace/sentinel-qa-allowlist-sql-46ddaf01/");
    expect(runbook).toContain("converted=0");
    expect(runbook).toContain("scope=allowlist");
    expect(runbook).toContain("skipped_allowlist_miss=1");
    expect(runbook).toContain("aggadagdade");
    expect(runbook).toContain("managed_live=1");
    expect(runbook).toContain("**No bulk OFF.**");
    expect(runbook).toContain("NULL fleet **not**");
    expect(runbook).toContain("schema_migrations");
    expect(runbook).toContain("9a80930a");
    expect(runbook).toContain("does not move Pages");
    expect(runbook).toMatch(/NULL\/omit = fleet-wide/);
    expect(runbook).toMatch(/`\{\}` \/ cardinality 0 = \*\*no-op\*\*/);
    expect(runbook).toContain("skipped_allowlist_miss");
    expect(runbook).toContain("skipped_limit");
    expect(runbook).toContain("allowlist_requested");
    expect(runbook).toContain("allowlist_matched_managed");
    expect(runbook).toContain("named Go SQL");
    expect(runbook).toContain("named Go Ops");
    expect(runbook).toContain("soft-miss");
    expect(runbook).toContain("skipped_encrypted");
    expect(runbook).toContain("DROP FUNCTION");
    expect(runbook).toContain("No `p_strict` in v1");
    expect(runbook).toContain("HOLD");
    expect(runbook).not.toContain("supabase db push");
  });

  it("records Go Ops allowlist bulk OFF 2→0 live PASS without fleet NULL or origin ship", () => {
    const runbook = source(RUNBOOK);
    expect(runbook).toContain("Go Ops allowlist bulk OFF");
    expect(runbook).toContain("2→0");
    expect(runbook).toContain("ARRAY[aggadagdade,pbhcusvb]");
    expect(runbook).toContain("pbhcusvb");
    expect(runbook).toContain("converted=2");
    expect(runbook).toContain("allowlist_requested=2");
    expect(runbook).toContain("allowlist_matched_managed=2");
    expect(runbook).toContain("not fleet");
    expect(runbook).toContain("Residual **cleared**");
    expect(runbook).toContain("/workspace/pulse-bulk-off-allowlist-20260922/");
    expect(runbook).toContain("/workspace/sentinel-qa-bulk-off-allowlist-20260922/");
    expect(runbook).toContain("836753fe");
    expect(runbook).toContain("plain-upsert");
    expect(runbook).toContain("9a80930a");
    expect(runbook).toContain("does not ship origin");
    expect(runbook).toContain("Do **not** call NULL/omit fleet");
    expect(runbook).toContain("allowlist 2 slugs **applied live**");
    expect(runbook).not.toContain("supabase db push");
  });
});
