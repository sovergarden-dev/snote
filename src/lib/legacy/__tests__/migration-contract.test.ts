import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const staleU1NotLive = ["not ", "applied/published"].join("");
const staleGithubReady = ["GitHub", "-ready"].join("");

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260724000000_atomic_capability_cutover.sql",
), "utf8");
const capabilityMigration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260722000000_capability_backend.sql",
), "utf8");
const legacyShareEdge = readFileSync(resolve(
  process.cwd(),
  "supabase/functions/share-view/index.ts",
), "utf8");
const legacyShareCreate = readFileSync(resolve(
  process.cwd(),
  "supabase/functions/share-create/index.ts",
), "utf8");
const appShell = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
const cutoverVerifier = readFileSync(resolve(
  process.cwd(),
  "scripts/verify-capability-cutover.ts",
), "utf8");
const capabilityEdge = readFileSync(resolve(
  process.cwd(),
  "supabase/functions/_shared/capability-edge.ts",
), "utf8");

describe("atomic cutover migration", () => {
  it("pins documented SQL 240 migration identity at live product SHA 9a80930a", () => {
    const sha256 = createHash("sha256").update(migration, "utf8").digest("hex");
    const lineCount = migration.endsWith("\n")
      ? migration.slice(0, -1).split("\n").length
      : migration.split("\n").length;
    const contract = readFileSync(resolve(
      process.cwd(),
      "docs/security/sql-240-readiness-contract.md",
    ), "utf8");
    const preflight = readFileSync(resolve(
      process.cwd(),
      "docs/security/sql-240-ops-preflight.md",
    ), "utf8");

    const importSignature =
      "public.capability_note_import_legacy(text,text,text,text,text,text,boolean,text,text,integer)";

    expect(sha256).toBe(
      "1043a46844e66859ccb8bec16888d6dd78f5f5e5a04df203f220a9b90302cf2f",
    );
    expect(lineCount).toBe(245);
    expect(contract).toContain(sha256);
    expect(contract).toMatch(/\| Lines \| 245 \|/);
    expect(preflight).toContain(sha256);
    expect(preflight).toContain("- Lines: 245");
    expect(preflight).toContain(importSignature);
    expect(preflight).not.toContain(
      "capability_note_import_legacy(text, text, text, text, text, jsonb, text)",
    );
    expect(preflight).toContain("SELECT public.capability_runtime_state();");
    expect(preflight).not.toMatch(/FROM public\.capability_runtime\b/);
    expect(contract).toContain("does **not** authorize apply");
    expect(preflight).toContain("does not authorize apply");
    expect(preflight).toContain("apply blocker");
    expect(contract).toContain("0cdcdc0f");
    expect(contract).toContain("1b9ed3d1");
    expect(contract).toContain("9a80930a");
    expect(contract).toContain("8e64829c");
    expect(contract).toContain("34986611791");
    expect(contract).toContain("W2 is live");
    expect(contract).toContain("HOLD");
    expect(contract).toContain("umsg_01m21zhm");
    expect(contract).toContain("**applied** live");
    expect(contract).toContain("**published**");
    expect(contract).not.toContain(staleU1NotLive);
    expect(contract).not.toContain(staleGithubReady);
    expect(preflight).toContain("umsg_01m21zhm");
    expect(preflight).toContain("**applied** live");
    expect(preflight).toContain("**published**");
    expect(preflight).not.toContain(staleU1NotLive);
    expect(preflight).not.toContain(staleGithubReady);
    expect(preflight).toContain("0cdcdc0f");
    expect(preflight).toContain("1b9ed3d1");
    expect(preflight).toContain("1789484737351-s31qn3nf");
    expect(preflight).toContain("9a80930a");
    expect(preflight).toContain("8e64829c");
    expect(preflight).toContain("1789612258815-8yx2tdut");
    expect(preflight).toContain("A′ live");
    expect(contract).toContain(
      "This is not SQL 240, not Realtime, not soak-complete.",
    );
    expect(preflight).toContain(
      "This is not SQL 240, not Realtime, not soak-complete.",
    );
  });

  it("pins bulk disable-secure migration identity as applied live; origin now 9a80930a", () => {
    const bulk = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql",
    ), "utf8");
    const sha256 = createHash("sha256").update(bulk, "utf8").digest("hex");
    const runbook = readFileSync(resolve(
      process.cwd(),
      "docs/security/bulk-disable-secure-ops.md",
    ), "utf8");
    const findings = readFileSync(resolve(
      process.cwd(),
      "docs/security-findings.md",
    ), "utf8");
    const contract = readFileSync(resolve(
      process.cwd(),
      "docs/security/sql-240-readiness-contract.md",
    ), "utf8");

    expect(sha256).toBe(
      "a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850",
    );
    expect(runbook).toContain(sha256);
    expect(findings).toContain(sha256);
    expect(runbook).toContain("**applied** live");
    expect(findings).toContain("capability_note_bulk_disable_secure");
    expect(contract).toContain("capability_note_bulk_disable_secure");
    expect(contract).toContain("0cdcdc0f");
    expect(contract).toContain("9a80930a");
    expect(contract).toContain("bd11deed");
    expect(runbook).toContain("0cdcdc0f");
    expect(runbook).toContain("9a80930a");
    expect(findings).toContain("Origin is `9a80930a`");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(runbook).toContain("converted=6");
    expect(runbook).toContain("no re-migrate");
    expect(findings).toContain("## 3h.");
    expect(findings).toContain("managed_live=0");
  });

  it("removes every direct notes policy and privilege in one transaction", () => {
    expect(migration).toMatch(/^BEGIN;/m);
    expect(migration).toMatch(/pg_catalog\.pg_policy/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.notes FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.note_shares FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.legacy_share_rotate\(text, text\) FROM PUBLIC, anon, authenticated, service_role;/);
    expect(migration).toMatch(/COMMIT;/);
  });

  it("does not restore a public read policy as rollback", () => {
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]+ON public\.notes/);
    expect(migration).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]+TO (PUBLIC|anon|authenticated)/);
  });

  it("fails closed unless the legacy share deadline is explicitly configured", () => {
    expect(legacyShareEdge).toContain('Deno.env.get("LEGACY_SHARE_CUTOFF")');
    expect(legacyShareEdge).not.toMatch(/Date\.parse\("20\d\d-/);
    expect(legacyShareEdge).toContain("legacyShareCutoff:");
    expect(cutoverVerifier).toContain("CAPABILITY_CUTOVER_AT");
    expect(cutoverVerifier).toContain("VITE_LEGACY_SHARE_CUTOFF");
    expect(cutoverVerifier).toContain("CAPABILITY_SHARE_VIEW_URL");
    expect(legacyShareEdge).toMatch(/legacy share compatibility expired[\s\S]+410/);
  });

  it("tombstones legacy share writes at both Edge and SQL boundaries", () => {
    expect(legacyShareCreate).toMatch(/legacy share creation disabled[\s\S]+410/);
    expect(legacyShareCreate).not.toMatch(/legacy_share_rotate|createClient/);
  });

  it("creates capabilities and initial checkpoint in one import transaction", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.capability_note_import_legacy/);
    expect(migration).toMatch(/INSERT INTO public\.notes[\s\S]+INSERT INTO public\.note_capabilities[\s\S]+INSERT INTO public\.note_checkpoints/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.capability_note_import_legacy[\s\S]+TO service_role/);
  });

  it("uses the database runtime control for read-only rollback", () => {
    expect(migration).toContain("capability_runtime_set(false, false)");
    expect(migration).toMatch(
      /Snote editors can send private messages[\s\S]+realtime_capability_allows/,
    );
    expect(capabilityMigration).toMatch(
      /FUNCTION public\.realtime_capability_allows[\s\S]+runtime\.writes_enabled/,
    );
    expect(migration).not.toContain("note_write_disabled");
    expect(capabilityEdge).toMatch(
      /status === "writes_disabled"[\s\S]+temporarily unavailable[\s\S]+503/,
    );
    expect(capabilityEdge).not.toContain("CAPABILITY_WRITE_DISABLED");
  });

  it("pins operator rollback to capability_runtime_set, not an Edge env", () => {
    const cutover = readFileSync(resolve(
      process.cwd(),
      "docs/security/atomic-capability-cutover.md",
    ), "utf8");
    const tracker = readFileSync(resolve(
      process.cwd(),
      "docs/security/stacked-rollout-tracker.md",
    ), "utf8");

    expect(cutover).not.toContain("CAPABILITY_WRITE_DISABLED");
    expect(tracker).not.toContain("CAPABILITY_WRITE_DISABLED");
    expect(cutover).not.toMatch(/Realtime JWTs carry the rollback claim/);
    expect(cutover).not.toContain("unset the write kill switch");

    expect(cutover).toContain("SELECT public.capability_runtime_set(false, false);");
    expect(cutover).toContain("`writes_disabled`");
    expect(cutover).toContain("503");
    expect(cutover).toMatch(/capability_session_open/);
    expect(cutover).toContain("private_realtime_enabled=false");
    expect(cutover).toMatch(/polling/);
    expect(cutover).toContain("SELECT public.capability_runtime_set(true, false);");
    expect(cutover).toContain("Verify `writes_enabled=true`");
    expect(cutover).toContain("capability_runtime_state()");
    expect(cutover).toContain("`writesEnabled`");
    expect(cutover).toContain("`privateRealtimeEnabled`");
    expect(cutover).toMatch(
      /Verify `writes_enabled=true`[\s\S]{0,500}capability create, sync/,
    );

    expect(tracker).toContain("SELECT public.capability_runtime_set(false, false);");
  });

  it("sets no-referrer before every precached-shell subresource", () => {
    const policy = appShell.indexOf('<meta name="referrer" content="no-referrer"');
    const firstSubresource = Math.min(
      appShell.indexOf("<link"),
      appShell.indexOf("<script"),
    );
    expect(viteConfig).toContain('navigateFallback: "/index.html"');
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(firstSubresource);
  });
});
