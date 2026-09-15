import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const sqlFunction = (sql: string, functionName: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 4);
};

const UPSERT_MIGRATION = "supabase/migrations/20260915000000_capability_note_plain_upsert.sql";
const DISABLE_MIGRATION = "supabase/migrations/20260915000001_capability_note_disable_secure.sql";

describe("W2 free-edit default + Legacy opt-in contract", () => {
  it("routes default plain /slug to editable NotePage, not Cutover Legacy RO", () => {
    const cutover = source("src/pages/CutoverNotePage.tsx");
    const legacySearchAt = cutover.indexOf("if (isLegacyRoSearch(location.search))");
    const notePageAt = cutover.lastIndexOf("<NotePage");
    expect(legacySearchAt).toBeGreaterThan(0);
    expect(notePageAt).toBeGreaterThan(legacySearchAt);
    expect(cutover).not.toMatch(
      /isLegacyRoSearch\(location\.search\)\s*\|\|\s*!capabilityAccess/,
    );
    expect(cutover.slice(0, legacySearchAt)).not.toContain("return (");
    expect(cutover).toContain("<LegacyNotePage");
  });

  it("persists canary plain notes through Edge upsert, never PostgREST notes writes or convert-on-first-keystroke", () => {
    const notePage = source("src/pages/NotePage.tsx");
    const provider = source("src/lib/yjs/plain-upsert-provider.ts");
    const client = source("src/lib/capability/client.ts");
    const canaryArm = notePage.indexOf(
      'else if (!legacyOnly && import.meta.env.VITE_CAPABILITY_ROUTES_ENABLED === "true")',
    );
    const notesArm = notePage.indexOf('.from("notes")');
    expect(canaryArm).toBeGreaterThan(0);
    expect(notesArm).toBeGreaterThan(canaryArm);
    expect(notePage.slice(canaryArm, notesArm)).not.toContain('.from("notes")');
    expect(notePage).toContain("PlainUpsertProvider");
    expect(notePage).toContain("upsertPlainNote");
    expect(notePage).toContain("disableSecureNote");
    expect(notePage).toContain("onLegacyEnable");
    expect(notePage).toContain("onLegacyDisable");
    expect(notePage).not.toContain("LocalConvertProvider");
    expect(notePage).not.toContain("hasStoredConvertRecovery");
    expect(notePage).not.toContain("onFirstPersist");
    expect(provider).not.toContain('.from("notes")');
    expect(provider).not.toContain("integrations/supabase");
    expect(provider).toContain("Never reads or writes `public.notes`");
    expect(provider).toContain("plain-upsert");
    expect(client).toContain('action: "plain-upsert"');
    expect(client).toContain('action: "disable-secure"');
    expect(client).not.toContain('.from("notes")');
    expect(notePage).toContain("convertPlainNoteOnWrite");
    expect(notePage).toContain("security.legacy_secure_reopen_banner");
    expect(notePage).toContain("security.legacy_secure_reopen_cta");
    expect(notePage).toContain("hasLegacySecurePin");
    expect(notePage).toContain("markLegacySecurePin");
    expect(notePage).toContain("clearLegacySecurePin");
    expect(notePage).toContain("clearPlainNoteIndexedDb");
    expect(source("src/lib/legacy/legacy-secure-pin.ts")).toContain("snote:legacy-secure:");
    expect(source("src/lib/legacy/legacy-secure-pin.ts")).toContain("note:");
    const runConvertAt = notePage.indexOf("const runConvert = useCallback");
    const persistAt = notePage.indexOf("upsertPlainNote");
    expect(runConvertAt).toBeGreaterThan(0);
    expect(persistAt).toBeGreaterThan(0);
    expect(notePage).toContain("createLegacyNoteApi().open");
    const runConvert = notePage.slice(
      runConvertAt,
      notePage.indexOf("const runDisable = useCallback"),
    );
    expect(runConvert).toContain("convertPlainNoteOnWrite");
    expect(runConvert).toContain("source: legacySourceRef.current");
    expect(runConvert).not.toMatch(/kind === "converted" \|\| kind === "slug_unavailable"/);
    expect(runConvert).not.toContain('setConvertError("converted")');
    expect(runConvert).toContain("security.legacy_secure_fail_on");
    expect(runConvert).toContain("security.legacy_secure_success_on");
    expect(runConvert).toContain("navigate(path, { replace: true })");
    expect(runConvert).toContain("markLegacySecurePin");
    expect(runConvert).toContain("clearPlainNoteIndexedDb");
    const runDisable = notePage.slice(
      notePage.indexOf("const runDisable = useCallback"),
      notePage.indexOf("const observeHash = useCallback"),
    );
    expect(runDisable).toContain("clearLegacySecurePin");
    expect(runDisable).toContain("clearNoteEncryptionPin");
  });

  it("keeps U1 convert-legacy for Legacy ON only and parks W1 convert-as-default", () => {
    const convert = source("src/lib/legacy/convert-on-write.ts");
    const ownerConvertAt = convert.indexOf("async function convertFromOwnerCandidate");
    const sourceNullOwnerAt = convert.indexOf("const ownerBefore = loadPendingOwnerCandidate");
    const createAt = convert.lastIndexOf("input.api.createNote");
    expect(ownerConvertAt).toBeGreaterThan(0);
    expect(sourceNullOwnerAt).toBeGreaterThan(ownerConvertAt);
    expect(createAt).toBeGreaterThan(sourceNullOwnerAt);
    expect(convert.slice(sourceNullOwnerAt, createAt)).toContain("convertFromOwnerCandidate");
    expect(convert.slice(sourceNullOwnerAt, createAt)).toContain("isLegacyNotFound");
    expect(convert.slice(sourceNullOwnerAt, createAt)).not.toContain('kind !== "slug_unavailable"');
    expect(source("src/lib/legacy/convert-on-write.ts")).toContain("convertLegacyNote");
    expect(source("src/lib/yjs/local-convert-provider.ts")).toContain("Parked W1");
    expect(source("knip.json")).toContain("src/lib/yjs/local-convert-provider.ts");
    const panel = source("src/components/note/NoteSecurityPanel.tsx");
    expect(panel).toContain("onLegacyEnable");
    expect(panel).toContain("onLegacyDisable");
    expect(panel).toContain("security.legacy_secure_label");
    expect(panel).toContain("security.legacy_confirm_off_title");
    expect(panel).toContain("hideEncrypt");
    expect(source("src/pages/LegacyNotePage.tsx")).toContain("hideEncrypt");
    expect(source("src/pages/NotePage.tsx")).not.toContain("onDuplicateSecurely");
  });

  it("adds service-role-only plain upsert and disable-secure RPCs without notes table GRANTs", () => {
    for (const path of [UPSERT_MIGRATION, DISABLE_MIGRATION]) {
      const sql = source(path);
      expect(sql.trimStart()).toMatch(/^BEGIN;/);
      expect(sql.trimEnd()).toMatch(/COMMIT;$/);
      expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]+ON TABLE public\.notes/);
      expect(sql).not.toMatch(/GRANT .+ ON TABLE public\.notes/);
      expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.capability_note[\s\S]+FROM PUBLIC, anon, authenticated/);
      expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.capability_note[\s\S]+TO service_role/);
    }

    const upsert = sqlFunction(source(UPSERT_MIGRATION), "capability_note_plain_upsert");
    expect(upsert).toContain("public.capability_writes_acquire()");
    expect(upsert).toContain("'capability_managed'");
    expect(upsert).toContain("INSERT INTO public.notes");
    expect(upsert).toContain("UPDATE public.notes");
    expect(upsert).toContain("FOR UPDATE");

    const disable = sqlFunction(source(DISABLE_MIGRATION), "capability_note_disable_secure");
    expect(disable).toContain("public.capability_writes_acquire()");
    expect(disable).toContain("p_owner_token_hash");
    expect(disable).toContain("'unauthorized'");
    expect(disable).toContain("DELETE FROM public.notes");
    expect(disable).toContain("INSERT INTO public.notes");
    expect(disable).toContain("capability_managed");
  });

  it("wires note-session plain-upsert before create and rejects managed rows", () => {
    const endpoint = source("supabase/functions/note-session/index.ts");
    const upsertAt = endpoint.indexOf('if (body?.action === "plain-upsert")');
    const disableAt = endpoint.indexOf('if (body?.action === "disable-secure")');
    const createAt = endpoint.indexOf('if (body?.action === "create")');
    const importAt = endpoint.indexOf('if (body?.action === "import-legacy")');
    expect(upsertAt).toBeGreaterThan(0);
    expect(disableAt).toBeGreaterThan(upsertAt);
    expect(createAt).toBeGreaterThan(disableAt);
    expect(importAt).toBeGreaterThan(createAt);

    const upsertBranch = endpoint.slice(upsertAt, disableAt);
    expect(upsertBranch).not.toContain("if (!bearer)");
    expect(upsertBranch).toContain('"capability_note_plain_upsert"');
    expect(upsertBranch).toContain('p_operation: "sync"');
    expect(upsertBranch.match(/environment\.client\.rpc\(/g)).toHaveLength(2);

    const disableBranch = endpoint.slice(disableAt, createAt);
    expect(disableBranch).toContain("if (!bearer)");
    expect(disableBranch).toContain('"capability_note_disable_secure"');
    expect(disableBranch).toContain('p_operation: "create"');

    expect(source("supabase/functions/_shared/capability-edge.ts")).toContain(
      "status === \"capability_managed\"",
    );
    expect(source("supabase/functions/legacy-note-open/index.ts")).toContain(
      'if (taken?.capability_managed) return "managed"',
    );
    expect(source("src/lib/legacy/cutover.ts")).toContain("CapabilityManagedError");
  });
});
