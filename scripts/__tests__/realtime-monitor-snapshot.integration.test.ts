// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const migrationPaths = [
  "supabase/migrations/20261010000000_realtime_topology_monitor.sql",
  "supabase/migrations/20261010010000_realtime_hub_assignment.sql",
  "supabase/migrations/20261010020000_realtime_hub_monitor_snapshot.sql",
];

async function createDatabase() {
  const db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  for (const migrationPath of migrationPaths) {
    await db.exec(readFileSync(resolve(process.cwd(), migrationPath), "utf8"));
  }
  return db;
}

async function readSnapshot(db: PGlite, at: string) {
  const result = await db.query<{ snapshot: Record<string, unknown> }>(
    "SELECT public.realtime_hub_monitor_snapshot($1::timestamptz) AS snapshot",
    [at],
  );
  return result.rows[0].snapshot;
}

it("returns immediately as not_ready for the default 0/0/disabled topology", async () => {
  const db = await createDatabase();
  try {
    const snapshot = await readSnapshot(db, "2030-01-01T00:00:00.000Z");
    expect(snapshot).toEqual({ status: "not_ready", ready: false });
  } finally {
    await db.close();
  }
});

it("uses the supplied fake clock for cache TTL, down TTL and the 10-second probe lease", async () => {
  const db = await createDatabase();
  const base = "2030-01-01T00:00:00.000Z";
  try {
    await db.exec(`
      UPDATE public.realtime_topology_config
      SET hubs = jsonb_set(
        jsonb_set(hubs, '{rt1,enabled}', 'true'::jsonb),
        '{rt1,weight_bp}', '10000'::jsonb
      )
      WHERE singleton;
      UPDATE public.realtime_hub_health_state
      SET health_status = 'healthy', checked_at = '${base}'::timestamptz,
          down_until = NULL, consecutive_failures = 0,
          probe_lease_id = NULL, probe_lease_until = NULL
      WHERE hub_id IN ('rt1', 'rt2');
    `);

    const readyAtTtlBoundary = await readSnapshot(db, "2030-01-01T00:00:10.000Z");
    expect(readyAtTtlBoundary).toMatchObject({ status: "ok", ready: true });
    expect(readyAtTtlBoundary.health).toMatchObject({
      rt1: { healthStatus: "unknown" },
      rt2: { healthStatus: "healthy" },
    });

    const rt2AtItsTtlBoundary = await readSnapshot(db, "2030-01-01T00:01:00.000Z");
    expect(rt2AtItsTtlBoundary.health).toMatchObject({
      rt1: { healthStatus: "unknown" },
      rt2: { healthStatus: "unknown" },
    });

    await db.exec(`
      UPDATE public.realtime_hub_health_state
      SET health_status = 'down', checked_at = '${base}'::timestamptz,
          down_until = '2030-01-01T00:01:00.000Z'::timestamptz,
          consecutive_failures = 1,
          probe_lease_id = '12345678-1234-4234-8234-123456789abc'::uuid,
          probe_lease_until = '2030-01-01T00:00:20.000Z'::timestamptz
      WHERE hub_id = 'rt1';
    `);

    const beforeDownExpiry = await readSnapshot(db, "2030-01-01T00:00:59.999Z");
    expect(beforeDownExpiry.health).toMatchObject({
      rt1: { healthStatus: "down", probeLeaseActive: false },
    });
    const atDownExpiry = await readSnapshot(db, "2030-01-01T00:01:00.000Z");
    expect(atDownExpiry.health).toMatchObject({
      rt1: { healthStatus: "unknown", probeLeaseActive: false },
    });
    const atLeaseExpiry = await readSnapshot(db, "2030-01-01T00:00:20.000Z");
    expect(atLeaseExpiry.health).toMatchObject({
      rt1: { healthStatus: "down", probeLeaseActive: false },
    });
    const beforeLeaseExpiry = await readSnapshot(db, "2030-01-01T00:00:19.999Z");
    expect(beforeLeaseExpiry.health).toMatchObject({
      rt1: { probeLeaseActive: true },
    });
  } finally {
    await db.close();
  }
});

it("grants the snapshot RPC only to service_role and adds no cron schedule or table", async () => {
  const db = await createDatabase();
  try {
    const privileges = await db.query<{ role_name: string; allowed: boolean }>(`
      SELECT role_name,
             has_function_privilege(role_name, 'public.realtime_hub_monitor_snapshot(timestamptz)', 'EXECUTE') AS allowed
      FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
      ORDER BY role_name
    `);
    expect(privileges.rows).toEqual([
      { role_name: "anon", allowed: false },
      { role_name: "authenticated", allowed: false },
      { role_name: "service_role", allowed: true },
    ]);

    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261010020000_realtime_hub_monitor_snapshot.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(/\b(?:select|perform)\s+cron\.schedule\s*\(/iu);
    expect(migration).not.toMatch(/\bcreate\s+table\b/iu);
    expect(migration).not.toMatch(/SNOTE_REALTIME_MONITOR_SECRET\s*=/u);
  } finally {
    await db.close();
  }
});
