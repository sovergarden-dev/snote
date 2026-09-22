import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCapabilityToken,
  decodeCapabilityPayload,
  hashCapabilityAdmissionSubject,
  hashCapabilityToken,
  readCapabilityBearer,
  sha256CapabilityPayload,
} from "../../supabase/functions/_shared/capability.ts";

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
const deployableFunctionNames = readdirSync(resolve(root, "supabase/functions"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
  .map((entry) => entry.name)
  .sort();
const capabilityMigrationPaths = [
  "supabase/migrations/20260722000000_capability_backend.sql",
  "supabase/migrations/20260723000000_capability_checkpoint_compaction.sql",
  "supabase/migrations/20260724000000_atomic_capability_cutover.sql",
  "supabase/migrations/20260727000000_capability_sync_conflict_codes.sql",
  "supabase/migrations/20260908000000_capability_note_convert_legacy.sql",
  "supabase/migrations/20260915000000_capability_note_plain_upsert.sql",
  "supabase/migrations/20260915000001_capability_note_disable_secure.sql",
  "supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql",
  "supabase/migrations/20260922000000_capability_note_bulk_disable_secure_p_slugs.sql",
];
const allCapabilityMigrations = capabilityMigrationPaths.map(source).join("\n");
const allCapabilitySources = [
  allCapabilityMigrations,
  source("supabase/functions/_shared/capability.ts"),
  source("supabase/functions/_shared/capability-edge.ts"),
  source("supabase/functions/note-session/index.ts"),
  source("supabase/functions/note-sync/index.ts"),
  source("supabase/functions/note-manage/index.ts"),
].join("\n");
const sqlFunction = (sql: string, functionName: string) => {
  const start = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  if (start < 0) return "";
  const end = sql.indexOf("\n$$;", start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end + 4);
};

describe("capability primitives", () => {
  it("creates 32-byte base64url capabilities", () => {
    const token = createCapabilityToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Array.from({ length: 32 }, createCapabilityToken)).size).toBe(32);
  });

  it("accepts a capability only from an exact Bearer header", () => {
    const token = createCapabilityToken();
    expect(readCapabilityBearer(new Request("https://example.test/note-session", {
      headers: { authorization: `Bearer ${token}` },
    }))).toBe(token);
    expect(readCapabilityBearer(new Request(`https://example.test/note-session?token=${token}`))).toBeNull();
    expect(readCapabilityBearer(new Request("https://example.test/note-session", {
      headers: { authorization: `bearer ${token}` },
    }))).toBeNull();
    expect(readCapabilityBearer(new Request("https://example.test/note-session", {
      headers: { authorization: `Bearer ${token},Bearer ${token}` },
    }))).toBeNull();
  });

  it("uses a domain-separated HMAC and rejects weak secrets", async () => {
    const token = "A".repeat(43);
    const secret = "B".repeat(43);
    const first = await hashCapabilityToken(token, secret);
    const second = await hashCapabilityToken(token, secret);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await expect(hashCapabilityToken(token, "short")).rejects.toThrow("configuration");
  });

  it("admits only one gateway-verified address and stores a domain-separated hash", async () => {
    const secret = "B".repeat(43);
    const subject = await hashCapabilityAdmissionSubject(new Request("https://example.test", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    }), secret);
    expect(subject).toMatch(/^[a-f0-9]{64}$/);
    expect(subject).not.toBe(await hashCapabilityToken("A".repeat(43), secret));
    await expect(hashCapabilityAdmissionSubject(new Request("https://example.test"), secret))
      .resolves.toBeNull();
    await expect(hashCapabilityAdmissionSubject(new Request("https://example.test", {
      headers: { "cf-connecting-ip": "203.0.113.7, 198.51.100.4" },
    }), secret)).resolves.toBeNull();
    for (const header of [
      "x-forwarded-for",
      "sb-forwarded-for",
      "x-real-ip",
      "true-client-ip",
      "x-envoy-external-address",
    ]) {
      await expect(hashCapabilityAdmissionSubject(new Request("https://example.test", {
        headers: { [header]: "203.0.113.7" },
      }), secret)).resolves.toBeNull();
    }
  });

  it("rejects router-reserved slugs at both capability entry points", async () => {
    const session = source("supabase/functions/note-session/index.ts");
    const manage = source("supabase/functions/note-manage/index.ts");
    expect(session).toContain('from "../_shared/slug.ts"');
    expect(manage).toContain('from "../_shared/slug.ts"');
    expect(session).not.toContain("const SLUG_RE");
    expect(manage).not.toContain("const SLUG_RE");
    expect(session.match(/isUsableSlug\(slug\)/g) ?? []).toHaveLength(5);
    expect(manage.match(/isUsableSlug\(slug\)/g) ?? []).toHaveLength(1);

    const slugPath = resolve(root, "supabase/functions/_shared/slug.ts");
    expect(existsSync(slugPath)).toBe(true);
    const slugModule = await import(pathToFileURL(slugPath).href);
    for (const reserved of ["note", "privacy", "s"]) {
      expect(slugModule.isUsableSlug(reserved)).toBe(false);
      expect(slugModule.isUsableSlug(reserved.toUpperCase())).toBe(false);
    }
    expect(slugModule.isUsableSlug("my-note_1")).toBe(true);
    expect(slugModule.isUsableSlug("bad slug")).toBe(false);
    expect(slugModule.isUsableSlug("x".repeat(65))).toBe(false);
  });

  it("decodes bounded canonical payloads without allocating oversized input", () => {
    expect(Array.from(decodeCapabilityPayload("AQID", 3))).toEqual([1, 2, 3]);
    expect(() => decodeCapabilityPayload("AQID", 2)).toThrow("payload too large");
    expect(() => decodeCapabilityPayload("not+base64", 100)).toThrow("invalid payload");
  });

  it("derives the idempotency key from the exact transported bytes", async () => {
    expect(await sha256CapabilityPayload(new Uint8Array([1, 2, 3]))).toBe(
      "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    );
  });

});

describe("capability database boundary", () => {
  const migrationPath = "supabase/migrations/20260722000000_capability_backend.sql";

  it("keeps generated database types aligned with admission and cumulative quotas", () => {
    const generatedTypes = source("src/integrations/supabase/types.ts");
    expect(generatedTypes).toContain("storage_limit_bytes: number");
    expect(generatedTypes).toContain("update_limit_count: number");
    expect(generatedTypes).toContain("checkpoint_limit_count: number");
    expect(generatedTypes).toContain("capability_admission_consume:");
    expect(generatedTypes).toContain('p_operation: "create" | "sync" | "membership"');
    expect(generatedTypes).toMatch(
      /capability_admission_consume:[\s\S]+?Returns: Json/,
    );
    expect(generatedTypes).toContain("capability_runtime_settings:");
    expect(generatedTypes).toContain("private_realtime_enabled: boolean");
    expect(generatedTypes).toContain("writes_enabled: boolean");
    expect(generatedTypes).toContain("capability_runtime_state:");
    expect(generatedTypes).toContain("capability_runtime_set:");
    expect(generatedTypes).toContain("note_realtime_memberships:");
    expect(generatedTypes).toContain("auth_user_id: string");
    expect(generatedTypes).toContain("capability_realtime_membership_bind:");
    expect(generatedTypes).toContain("capability_realtime_memberships_prune:");
    expect(generatedTypes).toContain("capability_realtime_cleanup_candidates:");
    expect(generatedTypes).toContain("note_realtime_memberships_capability_id_note_id_fkey");
    expect(generatedTypes).toContain("note_realtime_memberships_note_id_fkey");
    expect(generatedTypes).toContain("realtime_capability_allows:");
  });

  it("publishes security-definer RPCs and grants in one transaction", () => {
    const sql = source("supabase/migrations/20260722000000_capability_backend.sql");
    expect(sql).toMatch(/^--[\s\S]*?\nBEGIN;\s/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("stores one fail-closed runtime row behind service-only controls", () => {
    const sql = source(migrationPath);
    expect(sql).toMatch(
      /CREATE TABLE public\.capability_runtime_settings[\s\S]+singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/,
    );
    expect(sql).toMatch(/writes_enabled boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/private_realtime_enabled boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(
      /INSERT INTO public\.capability_runtime_settings[\s\S]+VALUES \(true, false, false\)/,
    );
    expect(sql).toContain(
      "ALTER TABLE public.capability_runtime_settings ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.capability_runtime_settings\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(sql).toMatch(
      /FUNCTION public\.capability_writes_enabled\(\)[\s\S]+COALESCE[\s\S]+false/,
    );
    expect(sql).toContain("FUNCTION public.capability_runtime_state()");
    expect(sql).toContain(
      "FUNCTION public.capability_runtime_set(\n  p_writes_enabled boolean,\n  p_private_realtime_enabled boolean",
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_runtime_state\(\) TO service_role/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_runtime_set\(boolean, boolean\)[\s\S]+TO service_role/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.capability_writes_enabled\(\) TO service_role/,
    );
  });

  it("uses a conflicting row-lock protocol for runtime cutover", () => {
    const sql = source(migrationPath);
    const lockingGate = sqlFunction(sql, "capability_writes_acquire");
    const nonLockingGate = sqlFunction(sql, "capability_writes_enabled");
    const setter = sqlFunction(sql, "capability_runtime_set");
    const realtimePredicate = sqlFunction(sql, "realtime_capability_allows");

    expect(lockingGate).toContain("FOR SHARE");
    expect(lockingGate).toContain("capability_runtime_settings");
    expect(nonLockingGate).not.toContain("FOR SHARE");
    expect(setter).toContain("UPDATE public.capability_runtime_settings");
    expect(realtimePredicate).toContain(
      "JOIN public.capability_runtime_settings AS runtime ON runtime.singleton",
    );
    expect(realtimePredicate).toContain("runtime.writes_enabled");
    expect(realtimePredicate).not.toContain("public.capability_writes_acquire()");
  });

  it.each([
    "capability_note_create",
    "capability_updates_append",
    "capability_note_manage",
    "capability_checkpoint_append",
    "capability_note_import_legacy",
    "capability_note_convert_legacy",
    "capability_note_plain_upsert",
    "capability_note_disable_secure",
    "capability_note_bulk_disable_secure",
  ])("%s is fenced by the database runtime row", (functionName) => {
    const body = sqlFunction(allCapabilityMigrations, functionName);
    const gate = body.indexOf("IF NOT public.capability_writes_acquire()");
    const validation = body.search(/\n  IF p_/);
    expect(body).not.toBe("");
    expect(gate).toBeGreaterThan(0);
    expect(validation).toBeGreaterThan(gate);
  });

  it("removes custom write claims and environment switches", () => {
    expect(allCapabilitySources).not.toContain("note_write_disabled");
    expect(allCapabilitySources).not.toContain("CAPABILITY_WRITE_DISABLED");
    expect(allCapabilitySources).not.toContain("capabilityWritesDisabled");
  });

  it("adds immutable note ids, scoped HMAC capabilities, append-only updates, and checkpoints", () => {
    const sql = source(migrationPath);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS note_id uuid");
    expect(sql).toContain("CREATE TRIGGER notes_immutable_identity");
    expect(sql).toContain("CREATE TABLE public.note_capabilities");
    expect(sql).toContain("CREATE TABLE public.note_updates");
    expect(sql).toContain("UNIQUE (note_id, update_id)");
    expect(sql).toContain("CREATE TABLE public.note_checkpoints");
    expect(sql).toContain("reject_append_only_mutation");
    expect(sql).toContain("notes_encryption_metadata_consistent");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS storage_limit_bytes");
  });

  it("keeps secure rows out of legacy public policies and exposes no new direct table grants", () => {
    const sql = source(migrationPath);
    expect(sql).toMatch(/CREATE POLICY "Legacy notes remain readable"[\s\S]+NOT capability_managed/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.note_capabilities[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.note_updates[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.note_checkpoints[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).not.toMatch(/GRANT .+note_(?:capabilities|updates|checkpoints).+ TO (?:anon|authenticated)/i);
    expect(sql).toContain("CREATE TRIGGER note_shares_legacy_targets_only");
    expect(sql).toContain("FUNCTION public.legacy_share_rotate");
  });

  it("defines deny-all short-lived Realtime memberships with service-only lifecycle RPCs", () => {
    const sql = source(migrationPath);
    expect(sql).toContain(
      "ADD CONSTRAINT note_capabilities_capability_note_unique\n  UNIQUE (capability_id, note_id)",
    );
    expect(sql).toMatch(
      /CREATE TABLE public\.note_realtime_memberships[\s\S]+PRIMARY KEY \(auth_user_id, note_id\)[\s\S]+UNIQUE \(auth_user_id\)/,
    );
    expect(sql).toContain(
      "REFERENCES auth.users(id) ON DELETE CASCADE",
    );
    expect(sql).toContain(
      "FOREIGN KEY (capability_id, note_id)",
    );
    expect(sql).toContain(
      "CHECK (expires_at > refreshed_at)",
    );
    expect(sql).toContain(
      "CHECK (expires_at <= refreshed_at + interval '5 minutes')",
    );
    expect(sql).toContain(
      "ALTER TABLE public.note_realtime_memberships ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.note_realtime_memberships\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
    for (const fn of [
      "capability_realtime_membership_bind",
      "capability_realtime_memberships_prune",
      "capability_realtime_cleanup_candidates",
    ]) {
      expect(sql).toContain(`FUNCTION public.${fn}`);
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^;]+ TO service_role`),
      );
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^;]+ FROM PUBLIC, anon, authenticated`),
      );
    }
  });

  it("extends membership admission without weakening existing status semantics", () => {
    const sql = source(migrationPath);
    const admission = sqlFunction(sql, "capability_admission_consume");
    expect(sql).toContain(
      "operation text NOT NULL CHECK (operation IN ('create', 'sync', 'membership'))",
    );
    expect(admission).toContain("p_operation = 'membership'");
    expect(admission).toContain("v_subject_request_limit := 1000");
    expect(admission).toContain("v_global_request_limit := 250000");
    for (const status of ["ok", "writes_disabled", "quota_exceeded", "invalid"]) {
      expect(admission).toContain(`'status', '${status}'`);
    }
  });

  it("serializes membership binds and locks notes before capabilities", () => {
    const sql = source(migrationPath);
    const bind = sqlFunction(sql, "capability_realtime_membership_bind");

    const runtimeLock = bind.indexOf("FROM public.capability_runtime_settings AS runtime");
    const noteLock = bind.indexOf("FROM public.notes AS note");
    const noteLockEnd = bind.indexOf("FOR SHARE;", noteLock);
    const capabilityLock = bind.indexOf(
      "FROM public.note_capabilities AS capability",
      noteLockEnd,
    );
    const capabilityLockEnd = bind.indexOf("FOR SHARE;", capabilityLock);

    expect(runtimeLock).toBeGreaterThan(0);
    expect(noteLock).toBeGreaterThan(runtimeLock);
    expect(capabilityLock).toBeGreaterThan(noteLockEnd);
    expect(runtimeLock).toBeLessThan(noteLock);
    expect(noteLockEnd).toBeLessThan(capabilityLock);
    expect(capabilityLockEnd).toBeGreaterThan(capabilityLock);
    expect(bind).toContain("pg_advisory_xact_lock");
    expect(bind).toContain("ON CONFLICT (auth_user_id, note_id) DO UPDATE");
    expect(bind).toContain("'quota_exceeded'");
    expect(bind).toMatch(/p_expires_at IS NULL[\s\S]+?'status', 'polling'/);
  });

  it("authorizes private Realtime topics from UID, topic, membership, and runtime rows only", () => {
    const sql = source(migrationPath);
    const atomic = source("supabase/migrations/20260724000000_atomic_capability_cutover.sql");
    const predicate = sqlFunction(sql, "realtime_capability_allows");
    expect(predicate).toContain(
      "p_auth_user_id uuid,\n  p_topic text,\n  p_write boolean",
    );
    expect(predicate).toContain("membership.auth_user_id = p_auth_user_id");
    expect(predicate).toContain("membership.expires_at > now()");
    expect(predicate).toContain("p_topic = 'note:' || membership.note_id::text");
    expect(predicate).toContain("runtime.private_realtime_enabled");
    expect(predicate).toContain("capability.scope IN ('owner', 'edit')");
    expect(predicate).toContain("runtime.writes_enabled");
    for (const policy of [
      "Snote capabilities can receive private messages",
      "Snote editors can send private messages",
    ]) {
      const start = sql.indexOf(`CREATE POLICY "${policy}"`);
      const end = sql.indexOf(");", start);
      const body = sql.slice(start, end < 0 ? undefined : end + 2);
      expect(body).toContain("(SELECT auth.uid())");
      expect(body).toContain("(SELECT realtime.topic())");
      expect(body).toContain("public.realtime_capability_allows");
      expect(body).not.toContain("auth.jwt()");
    }
    expect(sql).not.toContain("auth.jwt()");
    expect(atomic).not.toContain("auth.jwt()");
    expect(atomic).toContain("public.realtime_capability_allows");
    expect(atomic).toContain("(SELECT auth.uid())");
    expect(atomic).toContain("(SELECT realtime.topic())");
  });

  it("binds every update to the authorized note, exact payload hash, scope, version, and write state", () => {
    const sql = source(migrationPath);
    const append = sql.slice(
      sql.indexOf("FUNCTION public.capability_updates_append"),
      sql.indexOf("FUNCTION public.capability_note_manage"),
    );
    expect(append).toContain("c.token_hash = p_token_hash");
    expect(append).toContain("c.scope IN ('owner', 'edit')");
    expect(append).toContain("v_note.sync_status <> 'active'");
    expect(append).toContain("v_note.encryption_version <> p_expected_encryption_version");
    expect(append).toContain("extensions.digest(v_payload, 'sha256')");
    expect(append).toContain("-- Validate the complete batch before the first append");
    expect(append).toContain("replace(replace(encode(v_payload, 'base64')");
    expect(append).toContain("ON CONFLICT (note_id, update_id) DO NOTHING");
    expect(append).toContain("read_only_quarantine");
    expect(append).toContain("storage_limit_bytes");
    expect(append).toContain("quota_exceeded");
  });

  it("uses atomic admission windows without retaining raw client addresses", () => {
    const sql = source(migrationPath);
    const admission = sqlFunction(sql, "capability_admission_consume");
    expect(sql).toContain("CREATE TABLE public.capability_admission_windows");
    expect(admission).toContain("pg_advisory_xact_lock");
    expect(admission).toContain("subject_hash");
    expect(admission).toContain("v_subject_byte_limit := 67108864");
    expect(admission).toContain("v_global_byte_limit := 10737418240");
    expect(admission).toMatch(
      /BEGIN\s+IF NOT public\.capability_writes_acquire\(\)[\s\S]+writes_disabled/,
    );
    expect(admission.indexOf("capability_writes_acquire()")).toBeLessThan(
      admission.indexOf("pg_advisory_xact_lock"),
    );
    expect(admission.indexOf("capability_writes_acquire()")).toBeLessThan(
      admission.indexOf("INSERT INTO public.capability_admission_windows"),
    );
    for (const status of ["ok", "writes_disabled", "quota_exceeded"]) {
      expect(admission).toContain(`'status', '${status}'`);
    }
    expect(sql).not.toMatch(/capability_admission_windows[\s\S]{0,500}\bip\b/i);
  });

  it("materializes each session from one statement snapshot", () => {
    const sql = source(migrationPath);
    const open = sql.slice(
      sql.indexOf("FUNCTION public.capability_session_open"),
      sql.indexOf("FUNCTION public.capability_updates_append"),
    );
    expect(open).toContain("WITH capability AS MATERIALIZED");
    expect(open).toContain("-- One SQL statement gives metadata, checkpoint, sequence, and updates");
  });

  it("provides service-only atomic RPCs and aggregate payload auditing", () => {
    const sql = source(migrationPath);
    for (const fn of [
      "capability_note_create",
      "capability_session_open",
      "capability_updates_append",
      "capability_note_manage",
      "capability_payload_audit",
    ]) {
      expect(sql).toContain(`FUNCTION public.${fn}`);
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^;]+ TO service_role`));
    }
    const audit = sql.slice(sql.indexOf("FUNCTION public.capability_payload_audit"));
    expect(audit).not.toMatch(/RETURNS[\s\S]{0,300}\bslug\b/i);
  });

  it("adds edit-scoped checkpoint compaction with checkpoint and encryption CAS", () => {
    const sql = source("supabase/migrations/20260723000000_capability_checkpoint_compaction.sql");
    expect(sql).toContain("FUNCTION public.capability_checkpoint_append");
    expect(sql).toContain("c.scope IN ('owner', 'edit')");
    expect(sql).toContain("p_expected_checkpoint_version");
    expect(sql).toContain("p_expected_encryption_version");
    expect(sql).toContain("v_through_seq > v_current_seq");
    expect(sql).toContain("v_through_seq <= v_latest_through_seq");
    expect(sql).toContain("storage_limit_bytes");
    expect(sql).toContain("checkpoint_limit_count");
    expect(sql).toContain("quota_exceeded");
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.capability_checkpoint_append\([^;]+ TO service_role/);
  });

  it("defines exact security-definer sync RPC contracts with operation-safe conflicts", () => {
    const sql = source("supabase/migrations/20260727000000_capability_sync_conflict_codes.sql");
    const append = sqlFunction(sql, "capability_updates_append");
    const checkpoint = sqlFunction(sql, "capability_checkpoint_append");
    expect(append.startsWith([
      "CREATE OR REPLACE FUNCTION public.capability_updates_append(",
      "  p_token_hash text,",
      "  p_updates jsonb,",
      "  p_expected_encryption_version bigint",
      ")",
      "RETURNS jsonb",
      "LANGUAGE plpgsql",
      "SECURITY DEFINER",
      "SET search_path = pg_catalog, pg_temp",
      "AS $$",
    ].join("\n"))).toBe(true);
    expect(checkpoint.startsWith([
      "CREATE OR REPLACE FUNCTION public.capability_checkpoint_append(",
      "  p_token_hash text,",
      "  p_checkpoint jsonb,",
      "  p_expected_checkpoint_version bigint,",
      "  p_expected_encryption_version bigint",
      ")",
      "RETURNS jsonb",
      "LANGUAGE plpgsql",
      "SECURITY DEFINER",
      "SET search_path = pg_catalog, pg_temp",
      "AS $$",
    ].join("\n"))).toBe(true);
    for (const functionBody of [append, checkpoint]) {
      expect(functionBody.match(/SECURITY DEFINER/g)).toHaveLength(1);
      expect(functionBody.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(1);
    }
    expect(sql).toContain("append_encryption_conflict");
    expect(sql).toContain("checkpoint_encryption_conflict");
    expect(sql).toContain("checkpoint_version_conflict");
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(2);
    expect(sql).not.toContain("RETURN jsonb_build_object('status', 'version_conflict')");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.capability_updates_append\([^;]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.capability_updates_append\([^;]+TO service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.capability_checkpoint_append\([^;]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.capability_checkpoint_append\([^;]+TO service_role/);
    expect(sql.trimStart()).toMatch(/^--[\s\S]*?BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
  });
});

describe("Edge capability endpoints", () => {
  it("adds all four APIs and keeps capability tokens out of URL, query, body, and logs", () => {
    for (const name of ["note-session", "note-sync", "note-manage", "share-view"]) {
      const endpoint = source(`supabase/functions/${name}/index.ts`);
      expect(endpoint).toContain("readCapabilityBearer(req)");
      expect(endpoint).not.toContain("searchParams");
      expect(endpoint).not.toMatch(/body\??\.token|body\[.?["']token/i);
      expect(endpoint).not.toMatch(/console\.(?:log|info|warn|error)/);
    }
    const config = source("supabase/config.toml");
    for (const name of ["note-session", "note-sync", "note-manage", "share-view"]) {
      expect(config).toMatch(new RegExp(`\\[functions\\.${name}\\]\\s+verify_jwt = false`));
    }
  });

  it("creates and idempotently recovers a note from a client-held owner candidate", () => {
    const endpoint = source("supabase/functions/note-session/index.ts");
    const createBranch = endpoint.slice(
      endpoint.indexOf('if (body?.action === "create")'),
      endpoint.indexOf('if (body?.action === "import-legacy")'),
    );
    expect(createBranch).toContain("if (!bearer)");
    expect(createBranch).toContain("const owner = bearer");
    expect(createBranch).toContain('"capability_admission_consume"');
    expect(createBranch).toContain("rpcStatus(admitted)");
    expect(createBranch).not.toContain("admitted !== true");
    expect(createBranch).toContain("created?.session");
    expect(createBranch).toContain("created?.recovered");

    const importAt = endpoint.indexOf('if (body?.action === "import-legacy")');
    const importBranch = endpoint.slice(
      importAt,
      endpoint.indexOf('if (body?.action === "convert-legacy")'),
    );
    expect(importBranch.match(/environment\.client\.rpc\(/g)).toHaveLength(2);
    expect(importBranch).toContain("decodeCapabilityPayload");
    expect(importBranch.indexOf('"capability_admission_consume"')).toBeLessThan(
      importBranch.indexOf('"capability_note_import_legacy"'),
    );
    expect(importBranch).toContain("rpcStatus(admitted)");
    expect(importBranch).not.toContain("admitted !== true");
    expect(importBranch).toContain('"capability_note_import_legacy"');

    const convertAt = endpoint.indexOf('if (body?.action === "convert-legacy")');
    const tokenHashAt = endpoint.indexOf("const tokenHash = await capabilityTokenHash");
    expect(convertAt).toBeGreaterThan(importAt);
    expect(tokenHashAt).toBeGreaterThan(convertAt);
    const convertBranch = endpoint.slice(convertAt, tokenHashAt);
    expect(convertBranch.match(/environment\.client\.rpc\(/g)).toHaveLength(2);
    expect(convertBranch).toContain("decodeCapabilityPayload");
    expect(convertBranch.indexOf('"capability_admission_consume"')).toBeLessThan(
      convertBranch.indexOf('"capability_note_convert_legacy"'),
    );
    expect(convertBranch).toContain("rpcStatus(admitted)");
    expect(convertBranch).not.toContain("admitted !== true");
    expect(convertBranch).toContain('"capability_note_convert_legacy"');
    expect(convertBranch).not.toContain('"capability_note_import_legacy"');

    const sql = source("supabase/migrations/20260722000000_capability_backend.sql");
    const createRpc = sql.slice(
      sql.indexOf("FUNCTION public.capability_note_create"),
      sql.indexOf("FUNCTION public.capability_session_open"),
    );
    expect(createRpc).toContain("public.capability_session_open");
    expect(createRpc).toContain("owner_capability.token_hash = p_owner_token_hash");
    expect(createRpc).toContain("'recovered', v_recovered");
  });

  it("admits sync bytes before append and fails closed when admission is unavailable", () => {
    const endpoint = source("supabase/functions/note-sync/index.ts");
    const admission = endpoint.indexOf('"capability_admission_consume"');
    const append = endpoint.indexOf('"capability_updates_append"');
    expect(admission).toBeGreaterThan(0);
    expect(admission).toBeLessThan(append);
    expect(endpoint).toContain("rpcStatus(admitted)");
    expect(endpoint).not.toContain("admitted !== true");
    expect(endpoint).toContain("capabilityAdmissionFailure(rpcStatus(admitted))");
  });

  it("keeps temporary admission limits distinct from a quarantined note quota", () => {
    const edge = source("supabase/functions/_shared/capability-edge.ts");
    expect(edge).toContain('status === "quota_exceeded" ? "rate_limited" : status');
    expect(edge).toContain('if (status === "rate_limited")');
    for (const name of ["note-session", "note-sync"]) {
      expect(source(`supabase/functions/${name}/index.ts`))
        .toContain("capabilityAdmissionFailure(rpcStatus(admitted))");
    }
  });

  it("lets capability share readers page every missing update", () => {
    const endpoint = source("supabase/functions/share-view/index.ts");
    expect(endpoint).toContain("const afterSequence = Number(body?.afterSequence ?? 0)");
    expect(endpoint).toContain("p_after_seq: afterSequence");
  });

  it("validates and forwards optional checkpoint CAS through note-sync", () => {
    const endpoint = source("supabase/functions/note-sync/index.ts");
    expect(endpoint).toContain("body?.checkpoint");
    expect(endpoint).toContain('rpc("capability_checkpoint_append"');
    expect(endpoint).toContain("p_expected_checkpoint_version");
    expect(endpoint.match(/totalBytes \+= decoded\.byteLength/g)).toHaveLength(2);
    const rejectMixedRequest = endpoint.indexOf("normalizedCheckpoint && normalized.length !== 0");
    const admission = endpoint.indexOf('"capability_admission_consume"');
    expect(rejectMixedRequest).toBeGreaterThan(0);
    expect(rejectMixedRequest).toBeLessThan(admission);
  });

  it("tombstones the service-role raw dump and keeps remaining legacy readers off capability rows", () => {
    const raw = source("supabase/functions/raw/index.ts");
    const shareView = source("supabase/functions/share-view/index.ts");
    const shareCreate = source("supabase/functions/share-create/index.ts");
    expect(raw).toMatch(/return jsonResponse\(\s*\{ found: false \},\s*410,?\s*\)/);
    expect(raw).not.toContain("createClient");
    expect(raw).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(raw).not.toContain('.from("notes")');
    expect(shareView).toContain('.eq("capability_managed", false)');
    expect(shareCreate).toContain('status: 410');
    expect(shareCreate).not.toContain("legacy_share_rotate");
    expect(shareCreate).not.toContain('.from("notes")');
    expect(shareCreate).not.toContain('.from("note_shares")');
  });

  it("documents the stable NoteSession and idempotent sync contract", () => {
    const contract = source("docs/capability-backend.md");
    for (const field of [
      "noteId",
      "slug",
      "scope",
      "realtimeToken",
      "realtimeExpiresAt",
      "checkpointSequence",
      "missingUpdates",
      "encryption",
    ]) expect(contract).toContain(field);
    expect(contract).toContain("{ updateId, payload }");
    expect(contract).toContain("idempotent");
    expect(contract).toContain("read_only_quarantine");
  });
});

describe("Supabase function gateway configuration", () => {
  const config = source("supabase/config.toml");

  it.each(deployableFunctionNames)("configures exactly one verify_jwt=false stanza for %s", (name) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headers = [...config.matchAll(new RegExp(`^\\[functions\\.${escapedName}\\]$`, "gm"))];

    expect(headers).toHaveLength(1);

    const stanzaStart = headers[0].index ?? 0;
    const nextStanza = config.indexOf("\n[", stanzaStart + 1);
    const stanza = config.slice(stanzaStart, nextStanza < 0 ? undefined : nextStanza);
    expect(stanza).toMatch(/^verify_jwt\s*=\s*false$/m);
  });
});
