// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { expect, it } from "vitest";

type RpcResult = {
  status: string;
  noteId?: string;
  encryptionVersion?: number;
  checkpointVersion?: number;
  recovered?: boolean;
  created?: boolean;
  session?: {
    checkpointPayload?: string | null;
    missingUpdates?: Array<{ payload: string }>;
    noteId: string;
    scope: string;
    slug: string;
  };
  acknowledgements?: Array<{ updateId: string; sequence: number }>;
};

type RuntimeState = {
  writesEnabled: boolean;
  privateRealtimeEnabled: boolean;
  updatedAt: string | null;
};

const hash = (value: number[]) =>
  createHash("sha256").update(Buffer.from(value)).digest("hex");
const tokenHash = (character: string) => character.repeat(64);
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
] as const;

async function applyCapabilityMigrations(
  db: PGlite,
  paths: readonly string[],
) {
  for (const path of paths) {
    await db.exec(readFileSync(resolve(process.cwd(), path), "utf8"));
  }
}

async function createCapabilityFixture() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA extensions;
      CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE SCHEMA auth;
      CREATE SCHEMA realtime;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        is_anonymous boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT current_setting('realtime.topic', true)
      $$;
      CREATE TABLE realtime.messages (extension text NOT NULL);
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA auth, realtime TO authenticated;
      GRANT SELECT, INSERT ON realtime.messages TO authenticated;
      CREATE TABLE public.notes (
        slug text PRIMARY KEY,
        ydoc_state text NOT NULL DEFAULT '',
        content text NOT NULL DEFAULT '',
        char_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        is_encrypted boolean NOT NULL DEFAULT false,
        enc_salt text,
        enc_check text,
        enc_iterations integer NOT NULL DEFAULT 100000,
        tags text[] NOT NULL DEFAULT '{}'
      );
      ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE ON public.notes TO anon, authenticated;
      CREATE TABLE public.note_shares (
        token text PRIMARY KEY,
        slug text NOT NULL UNIQUE REFERENCES public.notes(slug) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE POLICY "Anyone can read notes"
        ON public.notes FOR SELECT TO anon, authenticated USING (true);
      CREATE POLICY "Anyone can create notes"
        ON public.notes FOR INSERT TO anon, authenticated WITH CHECK (true);
      CREATE POLICY "Anyone can update notes"
        ON public.notes FOR UPDATE TO anon, authenticated
        USING (true) WITH CHECK (true);
      INSERT INTO auth.users(id, is_anonymous, created_at) VALUES
        ('11111111-1111-4111-8111-111111111111', true, now()),
        ('22222222-2222-4222-8222-222222222222', true, now()),
        ('33333333-3333-4333-8333-333333333333', true, now()),
        ('44444444-4444-4444-8444-444444444444', true, now()),
        ('55555555-5555-4555-8555-555555555555', false, now() - interval '31 days'),
        ('66666666-6666-4666-8666-666666666666', true, now() - interval '31 days'),
        ('88888888-8888-4888-8888-888888888888', true, now());
      INSERT INTO public.notes(slug, content) VALUES ('legacy-row', 'legacy');
    `);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function rpc<T = RpcResult>(
  db: PGlite,
  name: string,
  values: unknown[],
  casts: string[] = [],
): Promise<T> {
  const placeholders = values
    .map((_, index) => `$${index + 1}${casts[index] ?? ""}`)
    .join(",");
  const response = await db.query<{ result: T }>(
    `select public.${name}(${placeholders}) as result`,
    values,
  );
  return response.rows[0].result;
}

async function setRealtimeIdentity(
  db: PGlite,
  authUserId: string,
  noteId: string,
) {
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false), "
      + "set_config('realtime.topic', $2, false)",
    [authUserId, `note:${noteId}`],
  );
}

it("applies capability migrations in chronological order through the sync conflict contract", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, capabilityMigrationPaths);
    expect((await db.query<{
      append_exists: boolean;
      checkpoint_exists: boolean;
    }>(`
      SELECT
        to_regprocedure('public.capability_updates_append(text,jsonb,bigint)') IS NOT NULL
          AS append_exists,
        to_regprocedure('public.capability_checkpoint_append(text,jsonb,bigint,bigint)') IS NOT NULL
          AS checkpoint_exists
    `)).rows[0]).toEqual({ append_exists: true, checkpoint_exists: true });
  } finally {
    await db.close();
  }
}, 30_000);

it("executes capability isolation, sync, management, and Realtime RLS in Postgres", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, [
      capabilityMigrationPaths[0],
      capabilityMigrationPaths[1],
      capabilityMigrationPaths[3],
    ]);

    expect((await db.query<{ count: number; rls_enabled: boolean }>(`
      SELECT
        count(*)::integer AS count,
        (SELECT relrowsecurity
          FROM pg_catalog.pg_class
          WHERE oid = 'public.capability_runtime_settings'::regclass) AS rls_enabled
      FROM public.capability_runtime_settings
    `)).rows[0]).toEqual({ count: 1, rls_enabled: true });
    expect(await rpc<RuntimeState>(db, "capability_runtime_state", []))
      .toMatchObject({
        writesEnabled: false,
        privateRealtimeEnabled: false,
      });
    await expect(db.exec(`
      INSERT INTO public.capability_runtime_settings(singleton)
      VALUES (true)
    `)).rejects.toMatchObject({ code: "23505" });
    await expect(db.exec(`
      INSERT INTO public.capability_runtime_settings(singleton)
      VALUES (false)
    `)).rejects.toMatchObject({ code: "23514" });
    const disabledAdmissionRows = (await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.capability_admission_windows",
    )).rows[0].count;
    expect(await rpc<RpcResult>(db, "capability_admission_consume", [
      "create",
      tokenHash("9"),
      1,
      0,
    ])).toMatchObject({ status: "writes_disabled" });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.capability_admission_windows",
    )).rows[0].count).toBe(disabledAdmissionRows);
    expect((await rpc(db, "capability_note_create", [
      "disabled-at-start",
      tokenHash("d"),
      tokenHash("e"),
      tokenHash("f"),
    ])).status).toBe("writes_disabled");

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query("SELECT * FROM public.capability_runtime_settings"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT public.capability_runtime_state()"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT public.capability_runtime_set(true, false)"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query(
        "SELECT public.capability_updates_append($1, $2::jsonb, $3::bigint)",
        [tokenHash("a"), "[]", 0],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(
        "SELECT public.capability_checkpoint_append($1, $2::jsonb, $3::bigint, $4::bigint)",
        [tokenHash("a"), "{}", 0, 0],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT * FROM public.note_realtime_memberships"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT public.capability_realtime_memberships_prune()"))
        .rejects.toMatchObject({ code: "42501" });
      await db.exec("RESET ROLE");
    }

    await db.exec("SET ROLE service_role");
    await expect(db.query("SELECT * FROM public.capability_runtime_settings"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.query("SELECT public.capability_writes_enabled()"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.query("SELECT * FROM public.note_realtime_memberships"))
      .rejects.toMatchObject({ code: "42501" });
    expect(await rpc<number>(db, "capability_realtime_memberships_prune", [])).toBe(0);
    expect(await rpc<RuntimeState>(
      db,
      "capability_runtime_set",
      [true, true],
    )).toMatchObject({
      writesEnabled: true,
      privateRealtimeEnabled: true,
    });
    await db.exec("RESET ROLE");

    const createdA = await rpc(db, "capability_note_create", [
      "secure-a",
      tokenHash("a"),
      tokenHash("b"),
      tokenHash("c"),
    ]);
    expect(createdA.status).toBe("ok");
    expect(createdA.session?.noteId).toBe(createdA.noteId);
    const recoveredA = await rpc(db, "capability_note_create", [
      "secure-a",
      tokenHash("a"),
      tokenHash("7"),
      tokenHash("8"),
    ]);
    expect(recoveredA).toMatchObject({
      status: "ok",
      noteId: createdA.noteId,
      recovered: true,
    });
    await expect(db.exec(`
      INSERT INTO public.note_shares(token, slug)
      VALUES ('legacy-share-cannot-target-secure', 'secure-a')
    `)).rejects.toMatchObject({ code: "23503" });
    const secureLegacyShare = await db.query<{ allowed: boolean }>(
      "SELECT public.legacy_share_rotate($1, $2) AS allowed",
      ["secure-a", "legacy-share-cannot-target-secure"],
    );
    expect(secureLegacyShare.rows[0].allowed).toBe(false);
    expect((await rpc(db, "capability_note_create", [
      "secure-a",
      tokenHash("d"),
      tokenHash("e"),
      tokenHash("f"),
    ])).status).toBe("slug_unavailable");

    const owner = await rpc(db, "capability_session_open", [tokenHash("a"), 0, 200]);
    const view = await rpc(db, "capability_session_open", [tokenHash("c"), 0, 200]);
    expect(owner.session).toMatchObject({ scope: "owner", slug: "secure-a" });
    expect(view.session?.noteId).toBe(owner.session?.noteId);

    const update = { updateId: hash([1, 2, 3]), payload: "AQID" };
    const first = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [update], 0],
      ["", "::jsonb", ""],
    );
    const retry = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [update], 0],
      ["", "::jsonb", ""],
    );
    expect(first.status).toBe("ok");
    expect(retry.acknowledgements?.[0].sequence).toBe(
      first.acknowledgements?.[0].sequence,
    );
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{ ...update, payload: "BA" }], 0],
      ["", "::jsonb", ""],
    )).status).toBe("invalid");
    await db.query(
      "UPDATE public.notes SET payload_limit_bytes = 65536 WHERE note_id = $1",
      [createdA.noteId],
    );
    const oversizedBytes = Buffer.alloc(65537, 7);
    const atomicBatch = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [
        { updateId: hash([5]), payload: "BQ" },
        {
          updateId: createHash("sha256").update(oversizedBytes).digest("hex"),
          payload: oversizedBytes.toString("base64url"),
        },
      ], 0],
      ["", "::jsonb", ""],
    );
    expect(atomicBatch.status).toBe("invalid");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_updates WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count).toBe(1);
    const longUpdateBytes = Buffer.alloc(60, 13);
    const longUpdate = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{
        updateId: createHash("sha256").update(longUpdateBytes).digest("hex"),
        payload: longUpdateBytes.toString("base64url"),
      }], 0],
      ["", "::jsonb", ""],
    );
    expect(longUpdate.status).toBe("ok");
    const pagedLongUpdate = await rpc(
      db,
      "capability_session_open",
      [tokenHash("b"), first.acknowledgements![0].sequence, 20],
    );
    expect(pagedLongUpdate.session?.missingUpdates?.[0].payload).not.toMatch(/[\r\n]/);
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("c"), [], 0],
      ["", "::jsonb", ""],
    )).status).toBe("unauthorized");

    await db.query(
      "UPDATE public.notes SET storage_limit_bytes = 65536 WHERE note_id = $1",
      [createdA.noteId],
    );
    const quotaBytes = Buffer.alloc(65536, 17);
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{
        updateId: createHash("sha256").update(quotaBytes).digest("hex"),
        payload: quotaBytes.toString("base64url"),
      }], 0],
      ["", "::jsonb", ""],
    )).status).toBe("quota_exceeded");
    expect((await db.query<{ sync_status: string }>(
      "SELECT sync_status::text FROM public.notes WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].sync_status).toBe("read_only_quarantine");
    await db.query(
      "UPDATE public.notes SET sync_status = 'active', storage_limit_bytes = 67108864 WHERE note_id = $1",
      [createdA.noteId],
    );

    const admission = async (subject: string) =>
      rpc<RpcResult>(db, "capability_admission_consume", [
        "create",
        subject,
        1,
        0,
      ]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(await admission(tokenHash("6"))).toMatchObject({ status: "ok" });
    }
    expect(await admission(tokenHash("6")))
      .toMatchObject({ status: "quota_exceeded" });
    const importAdmission = async () =>
      rpc<RpcResult>(db, "capability_admission_consume", [
        "create",
        tokenHash("5"),
        1,
        4194304,
      ]);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      expect(await importAdmission()).toMatchObject({ status: "ok" });
    }
    expect(await importAdmission()).toMatchObject({ status: "quota_exceeded" });

    const createdB = await rpc(db, "capability_note_create", [
      "secure-b",
      tokenHash("d"),
      tokenHash("e"),
      tokenHash("f"),
    ]);
    expect(createdB.noteId).not.toBe(createdA.noteId);
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("e"), [{ updateId: hash([4]), payload: "BA" }], 0],
      ["", "::jsonb", ""],
    )).status).toBe("ok");
    expect((await rpc(
      db,
      "capability_note_manage",
      [tokenHash("b"), "rename", { slug: "stolen" }],
      ["", "", "::jsonb"],
    )).status).toBe("unauthorized");
    expect((await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "rename", { slug: "secure-a-renamed" }],
      ["", "", "::jsonb"],
    )).status).toBe("ok");

    const capabilityRows = await db.query<{
      capability_id: string;
      note_id: string;
      scope: "owner" | "edit" | "view";
      generation: number;
    }>(`
      SELECT capability_id, note_id, scope::text AS scope, generation
      FROM public.note_capabilities
      WHERE note_id = $1
      ORDER BY scope
    `, [createdA.noteId]);
    const oldView = capabilityRows.rows.find((row) => row.scope === "view")!;
    const ownerAuthId = "11111111-1111-4111-8111-111111111111";
    const editAuthId = "22222222-2222-4222-8222-222222222222";
    const viewAuthId = "33333333-3333-4333-8333-333333333333";
    const noteBAuthId = "44444444-4444-4444-8444-444444444444";
    const nonAnonymousAuthId = "55555555-5555-4555-8555-555555555555";
    const oldAnonymousAuthId = "66666666-6666-4666-8666-666666666666";
    const newAnonymousAuthId = "88888888-8888-4888-8888-888888888888";
    const expiresFromNow = (seconds: number) =>
      new Date(Date.now() + seconds * 1000).toISOString();
    const bindMembership = (
      token: string,
      authUserId: string,
      seconds: number,
    ) => rpc<RpcResult>(
      db,
      "capability_realtime_membership_bind",
      [token, authUserId, expiresFromNow(seconds)],
      ["", "::uuid", "::timestamptz"],
    );
    const allowsRealtime = async (
      authUserId: string,
      topic: string,
      write: boolean,
    ) => (await db.query<{ allowed: boolean }>(
      "SELECT public.realtime_capability_allows($1::uuid, $2::text, $3::boolean) AS allowed",
      [authUserId, topic, write],
    )).rows[0].allowed;
    expect(await bindMembership("not-a-token-hash", ownerAuthId, 300))
      .toMatchObject({ status: "invalid" });
    expect(await bindMembership(tokenHash("a"), ownerAuthId, -1))
      .toMatchObject({ status: "polling" });
    expect(await bindMembership(tokenHash("a"), ownerAuthId, 600))
      .toMatchObject({ status: "ok" });
    expect(await bindMembership(tokenHash("b"), editAuthId, 300))
      .toMatchObject({ status: "ok" });
    expect(await bindMembership(tokenHash("c"), viewAuthId, 300))
      .toMatchObject({ status: "ok" });
    expect(await bindMembership(tokenHash("d"), noteBAuthId, 300))
      .toMatchObject({ status: "ok" });
    expect(await bindMembership(tokenHash("b"), ownerAuthId, 300))
      .toMatchObject({ status: "identity_conflict" });
    expect(await bindMembership(tokenHash("d"), ownerAuthId, 300))
      .toMatchObject({ status: "identity_conflict" });
    expect(await bindMembership(tokenHash("d"), nonAnonymousAuthId, 300))
      .toMatchObject({ status: "polling" });
    expect(await bindMembership(tokenHash("d"), "77777777-7777-4777-8777-777777777777", 300))
      .toMatchObject({ status: "polling" });
    expect(await allowsRealtime(ownerAuthId, `note:${createdA.noteId}`, true)).toBe(true);
    expect(await allowsRealtime(editAuthId, `note:${createdA.noteId}`, true)).toBe(true);
    expect(await allowsRealtime(viewAuthId, `note:${createdA.noteId}`, false)).toBe(true);
    expect(await allowsRealtime(viewAuthId, `note:${createdA.noteId}`, true)).toBe(false);
    expect(await allowsRealtime(ownerAuthId, `note:${createdB.noteId}`, false)).toBe(false);
    expect(await allowsRealtime(ownerAuthId, "note:00000000-0000-4000-8000-000000000000", false))
      .toBe(false);

    const duplicateRefreshes = await Promise.all([
      bindMembership(tokenHash("a"), ownerAuthId, 90),
      bindMembership(tokenHash("a"), ownerAuthId, 180),
      bindMembership(tokenHash("a"), ownerAuthId, 600),
    ]);
    expect(duplicateRefreshes.every((result) => result.status === "ok")).toBe(true);
    expect(await bindMembership(tokenHash("a"), ownerAuthId, 600))
      .toMatchObject({ status: "ok" });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_realtime_memberships WHERE auth_user_id = $1",
      [ownerAuthId],
    )).rows[0].count).toBe(1);
    const expiryBounds = (await db.query<{ seconds: number }>(`
      SELECT extract(epoch FROM (expires_at - refreshed_at))::integer AS seconds
      FROM public.note_realtime_memberships
      WHERE auth_user_id = $1
    `, [ownerAuthId])).rows[0].seconds;
    expect(expiryBounds).toBeGreaterThan(0);
    expect(expiryBounds).toBeLessThanOrEqual(300);
    await rpc<RuntimeState>(db, "capability_runtime_set", [true, false]);
    expect(await bindMembership(tokenHash("a"), ownerAuthId, 300))
      .toMatchObject({ status: "polling" });
    expect(await allowsRealtime(ownerAuthId, `note:${createdA.noteId}`, false)).toBe(false);
    await rpc<RuntimeState>(db, "capability_runtime_set", [true, true]);
    await rpc<RuntimeState>(db, "capability_runtime_set", [false, true]);
    expect(await allowsRealtime(ownerAuthId, `note:${createdA.noteId}`, false)).toBe(true);
    expect(await allowsRealtime(ownerAuthId, `note:${createdA.noteId}`, true)).toBe(false);
    expect(await bindMembership(tokenHash("a"), ownerAuthId, 300))
      .toMatchObject({ status: "polling" });
    await rpc<RuntimeState>(db, "capability_runtime_set", [true, true]);
    await db.query(`
      UPDATE public.capability_admission_windows
      SET request_count = 1000
      WHERE operation = 'membership'
        AND bucket_kind = 'subject'
        AND subject_hash = $1
    `, [tokenHash("a")]);
    expect(await bindMembership(tokenHash("a"), ownerAuthId, 300))
      .toMatchObject({ status: "polling" });

    await db.exec("INSERT INTO realtime.messages(extension) VALUES ('broadcast')");
    await setRealtimeIdentity(db, viewAuthId, createdA.noteId);
    await db.exec("SET ROLE authenticated");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM realtime.messages",
    )).rows[0].count).toBe(1);
    await expect(db.exec(
      "INSERT INTO realtime.messages(extension) VALUES ('broadcast')",
    )).rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE");

    await setRealtimeIdentity(db, editAuthId, createdA.noteId);
    await db.exec("SET ROLE authenticated");
    await expect(db.exec(
      "INSERT INTO realtime.messages(extension) VALUES ('broadcast')",
    )).resolves.toBeDefined();
    await db.exec("RESET ROLE");

    await db.query(`
      UPDATE public.note_realtime_memberships
      SET refreshed_at = now() - interval '10 minutes',
          expires_at = now() - interval '9 minutes'
      WHERE auth_user_id = $1
    `, [viewAuthId]);
    expect(await allowsRealtime(viewAuthId, `note:${createdA.noteId}`, false)).toBe(false);
    const pruned = await rpc<number>(db, "capability_realtime_memberships_prune", []);
    expect(pruned).toBeGreaterThanOrEqual(1);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_realtime_memberships WHERE auth_user_id = $1",
      [viewAuthId],
    )).rows[0].count).toBe(0);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_realtime_memberships WHERE auth_user_id = $1",
      [ownerAuthId],
    )).rows[0].count).toBe(1);
    expect(await bindMembership(tokenHash("c"), viewAuthId, 300))
      .toMatchObject({ status: "ok" });

    const candidateRows = await db.query<{ ids: string[] }>(
      "SELECT public.capability_realtime_cleanup_candidates($1::uuid[]) AS ids",
      [[oldAnonymousAuthId, ownerAuthId, noteBAuthId, nonAnonymousAuthId, newAnonymousAuthId]],
    );
    expect(candidateRows.rows[0].ids).toEqual([oldAnonymousAuthId]);
    await expect(db.query(
      "SELECT public.capability_realtime_cleanup_candidates($1::uuid[])",
      [Array.from({ length: 501 }, () => oldAnonymousAuthId)],
    )).rejects.toMatchObject({ code: "22023" });

    expect((await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "rotate", { scope: "view", tokenHash: tokenHash("9") }],
      ["", "", "::jsonb"],
    )).status).toBe("ok");
    expect((await rpc(
      db,
      "capability_session_open",
      [tokenHash("c"), 0, 20],
    )).status).toBe("unauthorized");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_realtime_memberships WHERE auth_user_id = $1",
      [viewAuthId],
    )).rows[0].count).toBe(0);
    await setRealtimeIdentity(db, viewAuthId, oldView.note_id);
    await db.exec("SET ROLE authenticated");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM realtime.messages",
    )).rows[0].count).toBe(0);
    await db.exec("RESET ROLE");

    const sequence = longUpdate.acknowledgements![0].sequence;
    const longCheckpointBytes = Buffer.alloc(60, 9);
    const encrypted = await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: true,
        expectedEncryptionVersion: 0,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 100000,
        checkpoint: {
          checkpointId: createHash("sha256").update(longCheckpointBytes).digest("hex"),
          payload: longCheckpointBytes.toString("base64url"),
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    );
    expect(encrypted).toMatchObject({ status: "ok", encryptionVersion: 1 });
    expect(await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: true,
        expectedEncryptionVersion: 0,
        salt: "s".repeat(16),
        check: "c".repeat(16),
        iterations: 100000,
        checkpoint: {
          checkpointId: createHash("sha256").update(longCheckpointBytes).digest("hex"),
          payload: longCheckpointBytes.toString("base64url"),
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    )).toMatchObject({
      status: "ok",
      encryptionVersion: 1,
      recovered: true,
    });
    const encryptedSession = await rpc(
      db,
      "capability_session_open",
      [tokenHash("a"), sequence, 20],
    );
    expect(encryptedSession.session?.checkpointPayload).not.toMatch(/[\r\n]/);
    const updateCountBeforeAppendEncryptionConflict = (await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_updates WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count;
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{ updateId: hash([18]), payload: "Eg" }], 0],
      ["", "::jsonb", ""],
    )).status).toBe("append_encryption_conflict");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_updates WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count).toBe(updateCountBeforeAppendEncryptionConflict);
    expect(await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: false,
        expectedEncryptionVersion: 1,
        iterations: 100000,
        checkpoint: {
          checkpointId: hash([10]),
          payload: "Cg",
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    )).toMatchObject({ status: "ok", encryptionVersion: 2 });
    expect(await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: true,
        expectedEncryptionVersion: 2,
        salt: "t".repeat(16),
        check: "d".repeat(16),
        iterations: 100000,
        checkpoint: {
          checkpointId: hash([11]),
          payload: "Cw",
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    )).toMatchObject({ status: "ok", encryptionVersion: 3 });
    expect(await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: false,
        expectedEncryptionVersion: 3,
        iterations: 100000,
        checkpoint: {
          checkpointId: hash([10]),
          payload: "Cg",
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    )).toMatchObject({ status: "ok", encryptionVersion: 4 });
    const postTransitionUpdate = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{ updateId: hash([12]), payload: "DA" }], 4],
      ["", "::jsonb", ""],
    );
    expect(postTransitionUpdate.status).toBe("ok");
    const compactionSequence = postTransitionUpdate.acknowledgements![0].sequence;
    const compactedBytes = Buffer.from([13, 14]);
    const checkpointCountBeforeEncryptionConflict = (await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_checkpoints WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count;
    expect(await rpc(
      db,
      "capability_checkpoint_append",
      [tokenHash("b"), {
        checkpointId: hash([14]),
        payload: "Dg",
        throughSequence: compactionSequence,
      }, 4, 3],
      ["", "::jsonb", "", ""],
    )).toMatchObject({ status: "checkpoint_encryption_conflict" });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_checkpoints WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count).toBe(checkpointCountBeforeEncryptionConflict);
    expect(await rpc(
      db,
      "capability_checkpoint_append",
      [tokenHash("b"), {
        checkpointId: createHash("sha256").update(compactedBytes).digest("hex"),
        payload: compactedBytes.toString("base64url"),
        throughSequence: compactionSequence,
      }, 4, 4],
      ["", "::jsonb", "", ""],
    )).toMatchObject({ status: "ok", checkpointVersion: 5 });
    const checkpointCountBeforeVersionConflict = (await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_checkpoints WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count;
    expect(await rpc(
      db,
      "capability_checkpoint_append",
      [tokenHash("b"), {
        checkpointId: hash([15]),
        payload: "Dw",
        throughSequence: compactionSequence,
      }, 4, 4],
      ["", "::jsonb", "", ""],
    )).toMatchObject({ status: "checkpoint_version_conflict" });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_checkpoints WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].count).toBe(checkpointCountBeforeVersionConflict);
    const quotaUpdate = await rpc(
      db,
      "capability_updates_append",
      [tokenHash("b"), [{ updateId: hash([16]), payload: "EA" }], 4],
      ["", "::jsonb", ""],
    );
    expect(quotaUpdate.status).toBe("ok");
    await db.query(
      "UPDATE public.notes SET checkpoint_limit_count = 5 WHERE note_id = $1",
      [createdA.noteId],
    );
    expect(await rpc(
      db,
      "capability_checkpoint_append",
      [tokenHash("b"), {
        checkpointId: hash([17]),
        payload: "EQ",
        throughSequence: quotaUpdate.acknowledgements![0].sequence,
      }, 5, 4],
      ["", "::jsonb", "", ""],
    )).toMatchObject({ status: "quota_exceeded" });
    expect((await db.query<{ sync_status: string }>(
      "SELECT sync_status::text FROM public.notes WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].sync_status).toBe("read_only_quarantine");
    await db.query(
      `UPDATE public.notes
       SET sync_status = 'active', checkpoint_limit_count = 256
       WHERE note_id = $1`,
      [createdA.noteId],
    );
    await db.query(
      "UPDATE public.notes SET sync_status = 'read_only_quarantine' WHERE note_id = $1",
      [createdA.noteId],
    );
    expect(await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "set-encryption", {
        isEncrypted: true,
        expectedEncryptionVersion: 4,
        salt: "u".repeat(16),
        check: "e".repeat(16),
        iterations: 100000,
        checkpoint: {
          checkpointId: hash([12]),
          payload: "DA",
          throughSequence: sequence,
        },
      }],
      ["", "", "::jsonb"],
    )).toMatchObject({ status: "read_only" });
    expect((await db.query<{ encryption_version: number }>(
      "SELECT encryption_version FROM public.notes WHERE note_id = $1",
      [createdA.noteId],
    )).rows[0].encryption_version).toBe(4);
    await db.query(
      "UPDATE public.notes SET sync_status = 'active' WHERE note_id = $1",
      [createdA.noteId],
    );

    await db.exec("SET ROLE anon");
    expect((await db.query<{ slug: string }>(
      "SELECT slug FROM public.notes ORDER BY slug",
    )).rows).toEqual([{ slug: "legacy-row" }]);
    await db.exec("RESET ROLE");

    await expect(db.exec(
      "UPDATE public.note_updates SET payload = '\\x01'::bytea",
    )).rejects.toMatchObject({ code: "55000" });
    expect((await rpc(
      db,
      "capability_note_manage",
      [tokenHash("d"), "delete", {}],
      ["", "", "::jsonb"],
    )).status).toBe("ok");
    expect((await rpc(
      db,
      "capability_session_open",
      [tokenHash("d"), 0, 20],
    )).status).toBe("unauthorized");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.note_updates WHERE note_id = $1",
      [createdB.noteId],
    )).rows[0].count).toBe(0);
    const audit = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.capability_payload_audit(1048576)",
    );
    expect(Object.keys(audit.rows[0])).not.toEqual(
      expect.arrayContaining(["slug", "content", "token", "ip"]),
    );

    await db.exec(readFileSync(
      resolve(process.cwd(), "supabase/migrations/20260724000000_atomic_capability_cutover.sql"),
      "utf8",
    ));

    await db.exec("SET ROLE anon");
    await expect(db.query("SELECT slug FROM public.notes"))
      .rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE");

    await db.exec("SET ROLE service_role");
    await expect(db.query(
      "SELECT public.legacy_share_rotate($1, $2)",
      ["legacy-row", "x".repeat(32)],
    )).rejects.toMatchObject({ code: "42501" });

    const importBytes = Buffer.alloc(60, 23);
    const imported = await rpc(db, "capability_note_import_legacy", [
      "legacy-copy",
      tokenHash("1"),
      tokenHash("2"),
      tokenHash("3"),
      createHash("sha256").update(importBytes).digest("hex"),
      importBytes.toString("base64url"),
      true,
      "s".repeat(16),
      "c".repeat(16),
      100000,
    ]);
    expect(imported).toMatchObject({
      status: "ok",
      recovered: false,
      session: {
        slug: "legacy-copy",
        scope: "owner",
        checkpointPayload: importBytes.toString("base64url"),
      },
    });

    const recoveredImport = await rpc(db, "capability_note_import_legacy", [
      "legacy-copy",
      tokenHash("1"),
      tokenHash("4"),
      tokenHash("5"),
      createHash("sha256").update(importBytes).digest("hex"),
      importBytes.toString("base64url"),
      true,
      "s".repeat(16),
      "c".repeat(16),
      100000,
    ]);
    expect(recoveredImport).toMatchObject({
      status: "ok",
      noteId: imported.noteId,
      recovered: true,
    });
    expect((await rpc(db, "capability_note_import_legacy", [
      "legacy-copy",
      tokenHash("9"),
      tokenHash("7"),
      tokenHash("8"),
      createHash("sha256").update(importBytes).digest("hex"),
      importBytes.toString("base64url"),
      true,
      "s".repeat(16),
      "c".repeat(16),
      100000,
    ])).status).toBe("slug_unavailable");
    await db.exec("RESET ROLE");

    const importedRows = await db.query<{ notes: number; capabilities: number; checkpoints: number }>(`
      SELECT
        (SELECT count(*)::integer FROM public.notes WHERE slug = 'legacy-copy') AS notes,
        (SELECT count(*)::integer FROM public.note_capabilities
          WHERE note_id = (SELECT note_id FROM public.notes WHERE slug = 'legacy-copy')) AS capabilities,
        (SELECT count(*)::integer FROM public.note_checkpoints
          WHERE note_id = (SELECT note_id FROM public.notes WHERE slug = 'legacy-copy')) AS checkpoints
    `);
    expect(importedRows.rows[0]).toEqual({ notes: 1, capabilities: 3, checkpoints: 1 });

    await db.exec(readFileSync(
      resolve(process.cwd(), capabilityMigrationPaths[4]),
      "utf8",
    ));

    const legacyRowId = (await db.query<{ note_id: string }>(
      "SELECT note_id::text FROM public.notes WHERE slug = 'legacy-row'",
    )).rows[0].note_id;
    const notesBeforeConvert = (await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.notes",
    )).rows[0].count;
    const convertBytes = Buffer.alloc(60, 29);
    const convertOwner = hash([201]);
    const convertEdit = hash([202]);
    const convertView = hash([203]);
    const convertConflictOwner = hash([204]);
    const convertArgs = [
      "legacy-row",
      convertOwner,
      convertEdit,
      convertView,
      createHash("sha256").update(convertBytes).digest("hex"),
      convertBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ] as const;
    const convertRpcTypes = ["", "", "", "", "", "", "", "", "", "::integer"];

    await db.exec("SET ROLE service_role");
    const converted = await rpc(db, "capability_note_convert_legacy", [
      ...convertArgs,
    ], convertRpcTypes);
    expect(converted).toMatchObject({
      status: "ok",
      recovered: false,
      noteId: legacyRowId,
      session: {
        slug: "legacy-row",
        scope: "owner",
        checkpointPayload: convertBytes.toString("base64url"),
      },
    });
    const recoveredConvert = await rpc(db, "capability_note_convert_legacy", [
      ...convertArgs,
    ], convertRpcTypes);
    expect(recoveredConvert).toMatchObject({
      status: "ok",
      recovered: true,
      noteId: legacyRowId,
    });
    expect((await rpc(db, "capability_note_convert_legacy", [
      "legacy-row",
      convertConflictOwner,
      convertEdit,
      convertView,
      createHash("sha256").update(convertBytes).digest("hex"),
      convertBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertRpcTypes)).status).toBe("slug_unavailable");
    expect((await rpc(db, "capability_note_convert_legacy", [
      "no-such-legacy-slug",
      convertOwner,
      convertEdit,
      convertView,
      createHash("sha256").update(convertBytes).digest("hex"),
      convertBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertRpcTypes)).status).toBe("not_found");
    await db.exec("RESET ROLE");

    const convertedNote = (await db.query<{
      note_id: string;
      capability_managed: boolean;
      sync_status: string;
      content: string;
      ydoc_state: string;
    }>(
      `SELECT note_id::text, capability_managed, sync_status::text, content, ydoc_state
       FROM public.notes WHERE slug = 'legacy-row'`,
    )).rows[0];
    expect(convertedNote.note_id).toBe(legacyRowId);
    expect(convertedNote.capability_managed).toBe(true);
    expect(convertedNote.sync_status).toBe("active");
    expect(convertedNote.content).toBe("");
    expect(convertedNote.ydoc_state).toBe("");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.notes",
    )).rows[0].count).toBe(notesBeforeConvert);
    expect((await db.query<{ capabilities: number; checkpoints: number }>(`
      SELECT
        (SELECT count(*)::integer FROM public.note_capabilities
          WHERE note_id = $1::uuid) AS capabilities,
        (SELECT count(*)::integer FROM public.note_checkpoints
          WHERE note_id = $1::uuid) AS checkpoints
    `, [legacyRowId])).rows[0]).toEqual({ capabilities: 3, checkpoints: 1 });

    await db.exec("SET ROLE anon");
    await expect(rpc(db, "capability_note_convert_legacy", [
      ...convertArgs,
    ], convertRpcTypes)).rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE");

    await setRealtimeIdentity(db, ownerAuthId, imported.session!.noteId);
    await db.exec("SET ROLE service_role");
    await rpc<RuntimeState>(db, "capability_runtime_set", [false, false]);
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE authenticated");
    await expect(db.exec(
      "INSERT INTO realtime.messages(extension) VALUES ('broadcast')",
    )).rejects.toMatchObject({ code: "42501" });
    await db.exec("RESET ROLE");
    await db.exec("SET ROLE service_role");
    await rpc<RuntimeState>(db, "capability_runtime_set", [true, false]);
    await db.exec("RESET ROLE");

    const invalidImport = await rpc(db, "capability_note_import_legacy", [
      "orphan-must-not-exist",
      tokenHash("4"),
      tokenHash("5"),
      tokenHash("6"),
      hash([99]),
      importBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], ["", "", "", "", "", "", "", "", "", "::integer"]);
    expect(invalidImport.status).toBe("invalid");
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.notes WHERE slug = 'orphan-must-not-exist'",
    )).rows[0].count).toBe(0);

    await db.exec("SET ROLE service_role");
    expect(await rpc<RuntimeState>(
      db,
      "capability_runtime_set",
      [false, false],
    )).toMatchObject({
      writesEnabled: false,
      privateRealtimeEnabled: false,
    });
    await db.exec("RESET ROLE");

    const sideEffectCounts = async () => (await db.query<{
      admissions: number;
      capabilities: number;
      checkpoints: number;
      notes: number;
      updates: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM public.capability_admission_windows) AS admissions,
        (SELECT count(*)::integer FROM public.note_capabilities) AS capabilities,
        (SELECT count(*)::integer FROM public.note_checkpoints) AS checkpoints,
        (SELECT count(*)::integer FROM public.notes) AS notes,
        (SELECT count(*)::integer FROM public.note_updates) AS updates
    `)).rows[0];
    const beforeDisabledWrites = await sideEffectCounts();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await rpc<RpcResult>(db, "capability_admission_consume", [
        "sync",
        tokenHash("a"),
        1,
        1024,
      ])).toMatchObject({ status: "writes_disabled" });
    }
    expect((await rpc(db, "capability_note_create", [
      "disabled-create",
      tokenHash("d"),
      tokenHash("e"),
      tokenHash("f"),
    ])).status).toBe("writes_disabled");
    expect((await rpc(
      db,
      "capability_updates_append",
      [tokenHash("a"), [], 0],
      ["", "::jsonb", ""],
    )).status).toBe("writes_disabled");
    expect((await rpc(
      db,
      "capability_note_manage",
      [tokenHash("a"), "rename", { slug: "disabled-rename" }],
      ["", "", "::jsonb"],
    )).status).toBe("writes_disabled");
    expect((await rpc(
      db,
      "capability_checkpoint_append",
      [tokenHash("a"), {}, 0, 0],
      ["", "::jsonb", "", ""],
    )).status).toBe("writes_disabled");
    expect((await rpc(db, "capability_note_import_legacy", [
      "disabled-import",
      tokenHash("4"),
      tokenHash("5"),
      tokenHash("6"),
      hash([99]),
      importBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], ["", "", "", "", "", "", "", "", "", "::integer"])).status)
      .toBe("writes_disabled");
    expect((await rpc(db, "capability_note_convert_legacy", [
      "disabled-convert",
      convertOwner,
      convertEdit,
      convertView,
      createHash("sha256").update(convertBytes).digest("hex"),
      convertBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], ["", "", "", "", "", "", "", "", "", "::integer"])).status)
      .toBe("writes_disabled");
    expect((await rpc(
      db,
      "capability_session_open",
      [tokenHash("a"), 0, 20],
    )).status).toBe("ok");
    expect(await sideEffectCounts()).toEqual(beforeDisabledWrites);

    await db.exec("DELETE FROM public.capability_runtime_settings");
    expect(await rpc<RuntimeState>(db, "capability_runtime_state", []))
      .toEqual({
        writesEnabled: false,
        privateRealtimeEnabled: false,
        updatedAt: null,
      });
    expect((await rpc(db, "capability_note_create", [
      "missing-runtime-row",
      tokenHash("d"),
      tokenHash("e"),
      tokenHash("f"),
    ])).status).toBe("writes_disabled");
    await expect(rpc<RuntimeState>(
      db,
      "capability_runtime_set",
      [true, true],
    )).rejects.toThrow("capability runtime row missing");
  } finally {
    await db.close();
  }
}, 30_000);

it("upserts unmanaged slugs and reverses secure notes without notes table GRANTs", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, capabilityMigrationPaths);
    await db.exec("SET ROLE service_role");
    expect(await rpc<RuntimeState>(db, "capability_runtime_set", [true, true])).toMatchObject({
      writesEnabled: true,
    });

    const upsertTypes = ["", "", "", "::integer", "::text[]", "", "", "", "::integer"];
    const created = await rpc(db, "capability_note_plain_upsert", [
      "free-edit",
      "YQ",
      "hello",
      5,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);
    expect(created).toMatchObject({ status: "ok", created: true });
    const updated = await rpc(db, "capability_note_plain_upsert", [
      "free-edit",
      "YQ",
      "hello!",
      6,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);
    expect(updated).toMatchObject({
      status: "ok",
      created: false,
      noteId: created.noteId,
    });
    await db.exec("RESET ROLE");
    expect((await db.query<{ content: string; managed: boolean }>(`
      SELECT content, capability_managed AS managed FROM public.notes WHERE slug = 'free-edit'
    `)).rows[0]).toEqual({ content: "hello!", managed: false });

    const convertBytes = Buffer.alloc(60, 31);
    const convertOwner = hash([211]);
    const convertEdit = hash([212]);
    const convertView = hash([213]);
    await db.exec("SET ROLE service_role");
    const converted = await rpc(db, "capability_note_convert_legacy", [
      "free-edit",
      convertOwner,
      convertEdit,
      convertView,
      createHash("sha256").update(convertBytes).digest("hex"),
      convertBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], ["", "", "", "", "", "", "", "", "", "::integer"]);
    expect(converted.status).toBe("ok");
    expect((await rpc(db, "capability_note_plain_upsert", [
      "free-edit",
      "YQ",
      "nope",
      4,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes)).status).toBe("capability_managed");

    const disableTypes = ["", "", "", "", "::integer", "::text[]", "", "", "", "::integer"];
    expect((await rpc(db, "capability_note_disable_secure", [
      hash([999]),
      "free-edit",
      "YQ",
      "plain again",
      11,
      [],
      false,
      null,
      null,
      null,
    ], disableTypes)).status).toBe("unauthorized");
    const disabled = await rpc(db, "capability_note_disable_secure", [
      convertOwner,
      "free-edit",
      "YQ",
      "plain again",
      11,
      [],
      false,
      null,
      null,
      null,
    ], disableTypes);
    expect(disabled).toMatchObject({ status: "ok", recovered: false });
    await db.exec("RESET ROLE");
    expect((await db.query<{ content: string; managed: boolean }>(`
      SELECT content, capability_managed AS managed FROM public.notes WHERE slug = 'free-edit'
    `)).rows[0]).toEqual({ content: "plain again", managed: false });
    await db.exec("SET ROLE service_role");
    const recovered = await rpc(db, "capability_note_disable_secure", [
      convertOwner,
      "free-edit",
      "YQ",
      "plain again",
      11,
      [],
      false,
      null,
      null,
      null,
    ], disableTypes);
    expect(recovered).toMatchObject({ status: "ok", recovered: true });

    await db.exec("RESET ROLE");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query(
        "SELECT public.capability_note_plain_upsert($1,$2,$3,$4::integer,$5::text[],$6,$7,$8,$9::integer)",
        ["role-denied", "YQ", "x", 1, [], false, null, null, null],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(db.query(
        "SELECT public.capability_note_disable_secure($1,$2,$3,$4,$5::integer,$6::text[],$7,$8,$9,$10::integer)",
        [convertOwner, "free-edit", "YQ", "x", 1, [], false, null, null, null],
      )).rejects.toMatchObject({ code: "42501" });
      await db.exec("RESET ROLE");
    }
  } finally {
    await db.close();
  }
}, 30_000);

it("bulk-disables managed notes, skips encrypted, and leaves unmanaged rows", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, capabilityMigrationPaths);
    await db.exec("SET ROLE service_role");
    expect(await rpc<RuntimeState>(db, "capability_runtime_set", [true, true])).toMatchObject({
      writesEnabled: true,
    });

    const upsertTypes = ["", "", "", "::integer", "::text[]", "", "", "", "::integer"];
    await rpc(db, "capability_note_plain_upsert", [
      "bulk-free",
      "YQ",
      "keep me",
      7,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);
    await rpc(db, "capability_note_plain_upsert", [
      "bulk-plain",
      "YQ",
      "soon managed",
      12,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);
    await rpc(db, "capability_note_plain_upsert", [
      "bulk-enc",
      "YQ",
      "cipher source",
      13,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);

    const plainBytes = Buffer.alloc(60, 41);
    const encBytes = Buffer.alloc(60, 43);
    const convertTypes = ["", "", "", "", "", "", "", "", "", "::integer"];
    const convertedPlain = await rpc(db, "capability_note_convert_legacy", [
      "bulk-plain",
      hash([221]),
      hash([222]),
      hash([223]),
      createHash("sha256").update(plainBytes).digest("hex"),
      plainBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertTypes);
    expect(convertedPlain.status).toBe("ok");
    const convertedEnc = await rpc(db, "capability_note_convert_legacy", [
      "bulk-enc",
      hash([231]),
      hash([232]),
      hash([233]),
      createHash("sha256").update(encBytes).digest("hex"),
      encBytes.toString("base64url"),
      true,
      "s".repeat(16),
      "c".repeat(16),
      100000,
    ], convertTypes);
    expect(convertedEnc.status).toBe("ok");
    const minted = await rpc(db, "capability_note_create", [
      "bulk-mint",
      hash([241]),
      hash([242]),
      hash([243]),
    ]);
    expect(minted.status).toBe("ok");
    await db.exec("RESET ROLE");

    const before = await db.query<{
      slug: string;
      note_id: string;
      managed: boolean;
      encrypted: boolean;
    }>(`
      SELECT slug, note_id::text, capability_managed AS managed, is_encrypted AS encrypted
      FROM public.notes
      WHERE slug IN ('bulk-free', 'bulk-plain', 'bulk-enc', 'bulk-mint')
      ORDER BY slug
    `);
    const beforeBySlug = Object.fromEntries(before.rows.map((row) => [row.slug, row]));
    expect(beforeBySlug["bulk-free"].managed).toBe(false);
    expect(beforeBySlug["bulk-plain"].managed).toBe(true);
    expect(beforeBySlug["bulk-enc"].managed).toBe(true);
    expect(beforeBySlug["bulk-enc"].encrypted).toBe(true);
    expect(beforeBySlug["bulk-mint"].managed).toBe(true);

    await db.exec("SET ROLE service_role");
    expect((await rpc(db, "capability_note_bulk_disable_secure", [0], ["::integer"]))
      .status).toBe("invalid");
    const limited = await rpc<{
      status: string;
      converted: number;
      skipped_encrypted: number;
      skipped_not_managed: number;
      errors: unknown[];
    }>(db, "capability_note_bulk_disable_secure", [1], ["::integer"]);
    expect(limited).toMatchObject({
      status: "ok",
      converted: 1,
      skipped_encrypted: 1,
      skipped_not_managed: 0,
      errors: [],
    });
    const report = await rpc<{
      status: string;
      converted: number;
      skipped_encrypted: number;
      skipped_not_managed: number;
      errors: unknown[];
    }>(db, "capability_note_bulk_disable_secure", [10], ["::integer"]);
    expect(report).toMatchObject({
      status: "ok",
      converted: 1,
      skipped_encrypted: 1,
      skipped_not_managed: 0,
      errors: [],
    });
    const rerun = await rpc<{
      converted: number;
      skipped_encrypted: number;
    }>(db, "capability_note_bulk_disable_secure", [10], ["::integer"]);
    expect(rerun).toMatchObject({ converted: 0, skipped_encrypted: 1 });
    await db.exec("RESET ROLE");

    const after = await db.query<{
      slug: string;
      note_id: string;
      managed: boolean;
      sync_status: string;
      content: string;
      ydoc_state: string;
      encrypted: boolean;
      caps: number;
    }>(`
      SELECT
        n.slug,
        n.note_id::text,
        n.capability_managed AS managed,
        n.sync_status::text,
        n.content,
        n.ydoc_state,
        n.is_encrypted AS encrypted,
        (SELECT count(*)::integer FROM public.note_capabilities c WHERE c.note_id = n.note_id) AS caps
      FROM public.notes AS n
      WHERE n.slug IN ('bulk-free', 'bulk-plain', 'bulk-enc', 'bulk-mint')
      ORDER BY n.slug
    `);
    const afterBySlug = Object.fromEntries(after.rows.map((row) => [row.slug, row]));
    expect(afterBySlug["bulk-free"]).toMatchObject({
      note_id: beforeBySlug["bulk-free"].note_id,
      managed: false,
      content: "keep me",
      caps: 0,
    });
    expect(afterBySlug["bulk-plain"].note_id).not.toBe(beforeBySlug["bulk-plain"].note_id);
    expect(afterBySlug["bulk-plain"]).toMatchObject({
      managed: false,
      sync_status: "legacy",
      content: "",
      ydoc_state: plainBytes.toString("base64"),
      encrypted: false,
      caps: 0,
    });
    expect(afterBySlug["bulk-mint"].note_id).not.toBe(beforeBySlug["bulk-mint"].note_id);
    expect(afterBySlug["bulk-mint"]).toMatchObject({
      managed: false,
      sync_status: "legacy",
      content: "",
      ydoc_state: "",
      caps: 0,
    });
    expect(afterBySlug["bulk-enc"]).toMatchObject({
      note_id: beforeBySlug["bulk-enc"].note_id,
      managed: true,
      encrypted: true,
      caps: 3,
    });

    await db.exec("SET ROLE service_role");
    const included = await rpc<{
      converted: number;
      skipped_encrypted: number;
    }>(db, "capability_note_bulk_disable_secure", [10, true], ["::integer", ""]);
    expect(included).toMatchObject({ converted: 1, skipped_encrypted: 0 });
    await db.exec("RESET ROLE");
    const encAfter = (await db.query<{
      managed: boolean;
      encrypted: boolean;
      content: string;
      salt: string | null;
      caps: number;
    }>(`
      SELECT
        capability_managed AS managed,
        is_encrypted AS encrypted,
        content,
        enc_salt AS salt,
        (SELECT count(*)::integer FROM public.note_capabilities c WHERE c.note_id = n.note_id) AS caps
      FROM public.notes AS n
      WHERE slug = 'bulk-enc'
    `)).rows[0];
    expect(encAfter).toMatchObject({
      managed: false,
      encrypted: true,
      content: "",
      salt: "s".repeat(16),
      caps: 0,
    });

    await db.exec("SET ROLE service_role");
    await rpc<RuntimeState>(db, "capability_runtime_set", [false, false]);
    expect((await rpc(db, "capability_note_bulk_disable_secure", [10], ["::integer"]))
      .status).toBe("writes_disabled");
    await rpc<RuntimeState>(db, "capability_runtime_set", [true, true]);
    await db.exec("RESET ROLE");

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query(
        "SELECT public.capability_note_bulk_disable_secure($1::integer)",
        [10],
      )).rejects.toMatchObject({ code: "42501" });
      await db.exec("RESET ROLE");
    }
  } finally {
    await db.close();
  }
}, 30_000);

it("copies the newest checkpoint into unmanaged ydoc and drops later updates", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, capabilityMigrationPaths);
    await db.exec("SET ROLE service_role");
    expect(await rpc<RuntimeState>(db, "capability_runtime_set", [true, true])).toMatchObject({
      writesEnabled: true,
    });

    const upsertTypes = ["", "", "", "::integer", "::text[]", "", "", "", "::integer"];
    await rpc(db, "capability_note_plain_upsert", [
      "bulk-ckpt",
      "YQ",
      "source",
      6,
      [],
      false,
      null,
      null,
      null,
    ], upsertTypes);
    const firstBytes = Buffer.alloc(60, 51);
    const newerBytes = Buffer.alloc(60, 53);
    const convertTypes = ["", "", "", "", "", "", "", "", "", "::integer"];
    const converted = await rpc(db, "capability_note_convert_legacy", [
      "bulk-ckpt",
      hash([251]),
      hash([252]),
      hash([253]),
      createHash("sha256").update(firstBytes).digest("hex"),
      firstBytes.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertTypes);
    expect(converted.status).toBe("ok");
    const noteId = converted.noteId as string;
    await db.exec("RESET ROLE");
    await db.query(
      `INSERT INTO public.note_checkpoints(
         note_id, version, through_seq, checkpoint_id, payload, encryption_version
       ) VALUES ($1::uuid, 2, 1, $2, $3::bytea, 0)`,
      [noteId, createHash("sha256").update(newerBytes).digest("hex"), newerBytes],
    );
    await db.query(
      `INSERT INTO public.note_updates(note_id, update_id, payload, encryption_version)
       VALUES ($1::uuid, $2, $3::bytea, 0)`,
      [noteId, hash([254]), Buffer.from([1, 2, 3])],
    );
    await db.exec("SET ROLE service_role");
    const report = await rpc<{
      status: string;
      converted: number;
      errors: unknown[];
    }>(db, "capability_note_bulk_disable_secure", [10], ["::integer"]);
    expect(report).toMatchObject({ status: "ok", converted: 1, errors: [] });
    await db.exec("RESET ROLE");

    const row = (await db.query<{
      managed: boolean;
      ydoc_state: string;
      note_id: string;
      updates: number;
      checkpoints: number;
    }>(`
      SELECT
        n.capability_managed AS managed,
        n.ydoc_state,
        n.note_id::text,
        (SELECT count(*)::integer FROM public.note_updates u WHERE u.note_id = n.note_id) AS updates,
        (SELECT count(*)::integer FROM public.note_checkpoints c WHERE c.note_id = n.note_id) AS checkpoints
      FROM public.notes AS n
      WHERE n.slug = 'bulk-ckpt'
    `)).rows[0];
    expect(row.note_id).not.toBe(noteId);
    expect(row).toMatchObject({
      managed: false,
      ydoc_state: newerBytes.toString("base64"),
      updates: 0,
      checkpoints: 0,
    });
  } finally {
    await db.close();
  }
}, 30_000);

it("scopes bulk disable-secure by p_slugs; empty array is no-op; NULL is fleet", async () => {
  const db = await createCapabilityFixture();
  try {
    await applyCapabilityMigrations(db, capabilityMigrationPaths);
    await db.exec("SET ROLE service_role");
    expect(await rpc<RuntimeState>(db, "capability_runtime_set", [true, true])).toMatchObject({
      writesEnabled: true,
    });

    expect((await db.query<{
      dropped_two_arg: boolean;
      three_arg: boolean;
    }>(`
      SELECT
        to_regprocedure('public.capability_note_bulk_disable_secure(integer, boolean)') IS NULL
          AS dropped_two_arg,
        to_regprocedure('public.capability_note_bulk_disable_secure(integer, boolean, text[])') IS NOT NULL
          AS three_arg
    `)).rows[0]).toEqual({ dropped_two_arg: true, three_arg: true });

    const upsertTypes = ["", "", "", "::integer", "::text[]", "", "", "", "::integer"];
    for (const slug of ["allow-a", "allow-b", "allow-enc", "allow-free"]) {
      await rpc(db, "capability_note_plain_upsert", [
        slug,
        "YQ",
        slug,
        slug.length,
        [],
        false,
        null,
        null,
        null,
      ], upsertTypes);
    }

    const convertTypes = ["", "", "", "", "", "", "", "", "", "::integer"];
    const plainA = Buffer.alloc(60, 61);
    const plainB = Buffer.alloc(60, 62);
    const encBytes = Buffer.alloc(60, 63);
    expect((await rpc(db, "capability_note_convert_legacy", [
      "allow-a",
      hash([261]),
      hash([262]),
      hash([263]),
      createHash("sha256").update(plainA).digest("hex"),
      plainA.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertTypes)).status).toBe("ok");
    expect((await rpc(db, "capability_note_convert_legacy", [
      "allow-b",
      hash([271]),
      hash([272]),
      hash([273]),
      createHash("sha256").update(plainB).digest("hex"),
      plainB.toString("base64url"),
      false,
      null,
      null,
      null,
    ], convertTypes)).status).toBe("ok");
    expect((await rpc(db, "capability_note_convert_legacy", [
      "allow-enc",
      hash([281]),
      hash([282]),
      hash([283]),
      createHash("sha256").update(encBytes).digest("hex"),
      encBytes.toString("base64url"),
      true,
      "s".repeat(16),
      "c".repeat(16),
      100000,
    ], convertTypes)).status).toBe("ok");

    const slugCast = ["::integer", "", "::text[]"] as const;
    const empty = await rpc<{
      status: string;
      converted: number;
      skipped_encrypted: number;
      skipped_allowlist_miss: number;
      skipped_limit: number;
      scope: string;
      allowlist_requested: number;
      allowlist_matched_managed: number;
    }>(db, "capability_note_bulk_disable_secure", [10, false, []], [...slugCast]);
    expect(empty).toMatchObject({
      status: "ok",
      converted: 0,
      skipped_encrypted: 0,
      skipped_allowlist_miss: 0,
      skipped_limit: 0,
      scope: "allowlist",
      allowlist_requested: 0,
      allowlist_matched_managed: 0,
    });
    await db.exec("RESET ROLE");

    const managedAfterEmpty = await db.query<{ slug: string; managed: boolean }>(`
      SELECT slug, capability_managed AS managed
      FROM public.notes
      WHERE slug IN ('allow-a', 'allow-b', 'allow-enc', 'allow-free')
      ORDER BY slug
    `);
    expect(Object.fromEntries(managedAfterEmpty.rows.map((row) => [row.slug, row.managed])))
      .toEqual({
        "allow-a": true,
        "allow-b": true,
        "allow-enc": true,
        "allow-free": false,
      });

    await db.exec("SET ROLE service_role");
    const trimmed = await rpc<{
      status: string;
      converted: number;
      skipped_encrypted: number;
      skipped_allowlist_miss: number;
      skipped_limit: number;
      scope: string;
      allowlist_requested: number;
      allowlist_matched_managed: number;
    }>(
      db,
      "capability_note_bulk_disable_secure",
      [1, false, ["allow-a", "allow-b"]],
      [...slugCast],
    );
    expect(trimmed).toMatchObject({
      status: "ok",
      converted: 1,
      skipped_encrypted: 0,
      skipped_allowlist_miss: 0,
      skipped_limit: 1,
      scope: "allowlist",
      allowlist_requested: 2,
      allowlist_matched_managed: 2,
    });

    const scoped = await rpc<{
      status: string;
      converted: number;
      skipped_encrypted: number;
      skipped_allowlist_miss: number;
      skipped_limit: number;
      scope: string;
      allowlist_requested: number;
      allowlist_matched_managed: number;
    }>(
      db,
      "capability_note_bulk_disable_secure",
      [10, false, ["allow-a", "missing-slug", "allow-enc"]],
      [...slugCast],
    );
    expect(scoped).toMatchObject({
      status: "ok",
      converted: 0,
      skipped_encrypted: 1,
      skipped_allowlist_miss: 2,
      skipped_limit: 0,
      scope: "allowlist",
      allowlist_requested: 3,
      allowlist_matched_managed: 0,
    });
    await db.exec("RESET ROLE");

    const afterScoped = await db.query<{ slug: string; managed: boolean; encrypted: boolean }>(`
      SELECT slug, capability_managed AS managed, is_encrypted AS encrypted
      FROM public.notes
      WHERE slug IN ('allow-a', 'allow-b', 'allow-enc', 'allow-free')
      ORDER BY slug
    `);
    expect(Object.fromEntries(afterScoped.rows.map((row) => [row.slug, row])))
      .toMatchObject({
        "allow-a": { managed: false, encrypted: false },
        "allow-b": { managed: true, encrypted: false },
        "allow-enc": { managed: true, encrypted: true },
        "allow-free": { managed: false, encrypted: false },
      });

    await db.exec("SET ROLE service_role");
    const missRerun = await rpc<{
      converted: number;
      skipped_allowlist_miss: number;
      allowlist_matched_managed: number;
    }>(db, "capability_note_bulk_disable_secure", [10, false, ["allow-a"]], [...slugCast]);
    expect(missRerun).toMatchObject({
      converted: 0,
      skipped_allowlist_miss: 1,
      allowlist_matched_managed: 0,
    });

    const limited = await rpc<{
      converted: number;
      skipped_limit: number;
      allowlist_matched_managed: number;
      scope: string;
    }>(db, "capability_note_bulk_disable_secure", [1, false, null], [...slugCast]);
    expect(limited).toMatchObject({
      converted: 1,
      skipped_limit: 0,
      allowlist_matched_managed: 1,
      scope: "fleet",
    });
    await db.exec("RESET ROLE");

    const afterFleet = (await db.query<{ managed: boolean }>(`
      SELECT capability_managed AS managed FROM public.notes WHERE slug = 'allow-b'
    `)).rows[0];
    expect(afterFleet.managed).toBe(false);
    expect((await db.query<{ managed: boolean }>(`
      SELECT capability_managed AS managed FROM public.notes WHERE slug = 'allow-enc'
    `)).rows[0].managed).toBe(true);

    await db.exec("SET ROLE service_role");
    const oversized = await rpc<{ status: string }>(
      db,
      "capability_note_bulk_disable_secure",
      [10, false, Array.from({ length: 10001 }, () => "x")],
      [...slugCast],
    );
    expect(oversized.status).toBe("invalid");
    await db.exec("RESET ROLE");

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(db.query(
        "SELECT public.capability_note_bulk_disable_secure($1::integer, $2::boolean, $3::text[])",
        [10, false, ["allow-a"]],
      )).rejects.toMatchObject({ code: "42501" });
      await db.exec("RESET ROLE");
    }
  } finally {
    await db.close();
  }
}, 30_000);
