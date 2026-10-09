// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const migrationPath = "supabase/migrations/20261010000000_realtime_topology_monitor.sql";
const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface BudgetObject {
  [key: string]: number | BudgetObject;
}
type BudgetValues = BudgetObject | null;
type HubConfig = {
  weight_bp: number;
  enabled: boolean;
  drain: boolean;
  probe: {
    timeout_ms: number;
    retry_count: number;
    retry_delay_ms: number;
    down_ttl_seconds: number;
    probe_cache_ttl_seconds: number;
    probe_on_report: boolean;
    probe_before_assign: boolean;
  };
  budget_profile: "none" | "cf_free_daily" | "cf_paid_monthly" | null;
  budget_thresholds: BudgetValues;
  unit_prices: BudgetValues;
  billing_cycle_started_at: string | null;
  max_active_rooms: number | null;
};
type HubMap = Record<"rt1" | "rt2", HubConfig>;
type RampConfig = {
  canary_bp: number;
  step_bp: number;
  interval_seconds: number;
};
type TopologyResult = {
  status: string;
  version?: number;
  assignmentEpoch?: number;
  minFallbackBp?: number;
  hubConfig?: HubMap;
  ramp?: RampConfig;
  hub2NewRoomAdmissionReady?: boolean;
};
type ProbeResult = {
  status: string;
  leaseId?: string;
  leaseSeconds?: number;
  stateVersion?: number;
  downUntil?: string | null;
};

const baselineRamp: RampConfig = {
  canary_bp: 500,
  step_bp: 1_000,
  interval_seconds: 300,
};
const baselineHubs: HubMap = {
  rt1: {
    weight_bp: 0,
    enabled: false,
    drain: false,
    probe: {
      timeout_ms: 2_000,
      retry_count: 1,
      retry_delay_ms: 1_000,
      down_ttl_seconds: 60,
      probe_cache_ttl_seconds: 10,
      probe_on_report: true,
      probe_before_assign: true,
    },
    budget_profile: "none",
    budget_thresholds: null,
    unit_prices: null,
    billing_cycle_started_at: null,
    max_active_rooms: null,
  },
  rt2: {
    weight_bp: 0,
    enabled: false,
    drain: false,
    probe: {
      timeout_ms: 2_000,
      retry_count: 1,
      retry_delay_ms: 1_000,
      down_ttl_seconds: 60,
      probe_cache_ttl_seconds: 60,
      probe_on_report: true,
      probe_before_assign: false,
    },
    budget_profile: null,
    budget_thresholds: null,
    unit_prices: null,
    billing_cycle_started_at: null,
    max_active_rooms: null,
  },
};

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
  `);
  await db.exec(readFileSync(resolve(process.cwd(), migrationPath), "utf8"));
  return db;
}

async function topologyRead(db: PGlite) {
  const result = await db.query<{ result: TopologyResult }>(
    "SELECT public.realtime_topology_read() AS result",
  );
  return result.rows[0].result;
}

async function topologyUpdate(
  db: PGlite,
  expectedVersion: number,
  minFallbackBp: number,
  hubs: HubMap,
  ramp: RampConfig,
  emergencyOverride = false,
) {
  const result = await db.query<{ result: TopologyResult }>(
    `SELECT public.realtime_topology_update(
      $1::bigint, $2::integer, $3::jsonb, $4::jsonb,
      $5::uuid, $6::text, $7::boolean
    ) AS result`,
    [
      expectedVersion,
      minFallbackBp,
      JSON.stringify(hubs),
      JSON.stringify(ramp),
      actorId,
      "local synthetic topology test",
      emergencyOverride,
    ],
  );
  return result.rows[0].result;
}

async function probeClaim(db: PGlite, hubId: string, epoch: number) {
  const result = await db.query<{ result: ProbeResult }>(
    "SELECT public.realtime_hub_probe_claim($1::text, $2::bigint) AS result",
    [hubId, epoch],
  );
  return result.rows[0].result;
}

async function probeComplete(
  db: PGlite,
  hubId: string,
  epoch: number,
  leaseId: string,
  healthy: boolean,
) {
  const result = await db.query<{ result: ProbeResult }>(
    `SELECT public.realtime_hub_probe_complete(
      $1::text, $2::bigint, $3::uuid, $4::boolean
    ) AS result`,
    [hubId, epoch, leaseId, healthy],
  );
  return result.rows[0].result;
}

async function asRole<T>(db: PGlite, role: string, action: () => Promise<T>) {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("RESET ROLE");
  }
}

it("stores full K1 defaults without enabling unverified hubs or inventing budget/capacity values", async () => {
  const db = await createDatabase();
  try {
    const initial = await asRole(db, "service_role", () => topologyRead(db));
    expect(initial).toMatchObject({
      status: "ok",
      version: 1,
      assignmentEpoch: 1,
      minFallbackBp: 1_000,
      ramp: baselineRamp,
      hub2NewRoomAdmissionReady: false,
      hubConfig: baselineHubs,
    });
    expect(initial.hubConfig?.rt2).toMatchObject({
      enabled: false,
      budget_profile: null,
      budget_thresholds: null,
      unit_prices: null,
      billing_cycle_started_at: null,
      max_active_rooms: null,
    });
  } finally {
    await db.close();
  }
});

it("fails closed for Hub 2 when profile, thresholds, or measured capacity are absent", async () => {
  const db = await createDatabase();
  try {
    // These values are synthetic fixtures only; no real quota or unit price is seeded.
    const readyHubs: HubMap = {
      ...baselineHubs,
      rt1: { ...baselineHubs.rt1, enabled: true, weight_bp: 9_000 },
      rt2: {
        ...baselineHubs.rt2,
        enabled: true,
        weight_bp: 1_000,
        budget_profile: "cf_free_daily",
        budget_thresholds: { synthetic_metric_limit: 1 },
        unit_prices: { synthetic_price_usd: 0.001 },
        max_active_rooms: 12,
      },
    };
    const enabled = await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, readyHubs, baselineRamp, true),
    );
    expect(enabled.status).toBe("updated");
    expect((await asRole(db, "service_role", () => topologyRead(db)))
      .hub2NewRoomAdmissionReady).toBe(true);

    const noProfile: HubMap = {
      ...readyHubs,
      rt2: { ...readyHubs.rt2, budget_profile: null },
    };
    await asRole(db, "service_role", () =>
      topologyUpdate(db, 2, 1_000, noProfile, baselineRamp),
    );
    expect((await asRole(db, "service_role", () => topologyRead(db)))
      .hub2NewRoomAdmissionReady).toBe(false);

    const noThresholds: HubMap = {
      ...readyHubs,
      rt2: { ...readyHubs.rt2, budget_thresholds: null },
    };
    await asRole(db, "service_role", () =>
      topologyUpdate(db, 3, 1_000, noThresholds, baselineRamp),
    );
    expect((await asRole(db, "service_role", () => topologyRead(db)))
      .hub2NewRoomAdmissionReady).toBe(false);

    const noCapacity: HubMap = {
      ...readyHubs,
      rt2: { ...readyHubs.rt2, max_active_rooms: null },
    };
    await asRole(db, "service_role", () =>
      topologyUpdate(db, 4, 1_000, noCapacity, baselineRamp),
    );
    expect((await asRole(db, "service_role", () => topologyRead(db)))
      .hub2NewRoomAdmissionReady).toBe(false);
  } finally {
    await db.close();
  }
});

it("bumps topology version and assignment epoch atomically and audits the complete K1 change", async () => {
  const db = await createDatabase();
  try {
    const initial = await asRole(db, "service_role", () => topologyRead(db));
    expect(initial.version).toBe(1);
    expect(initial.assignmentEpoch).toBe(1);

    const enabledRt1: HubMap = {
      ...baselineHubs,
      rt1: { ...baselineHubs.rt1, enabled: true, weight_bp: 10_000 },
    };
    const needsEmergency = await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, enabledRt1, baselineRamp),
    );
    expect(needsEmergency.status).toBe("emergency_override_required");
    expect((await topologyRead(db)).version).toBe(1);

    const changedRamp = { ...baselineRamp, interval_seconds: 600 };
    const updated = await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, enabledRt1, changedRamp, true),
    );
    expect(updated).toMatchObject({
      status: "updated",
      version: 2,
      assignmentEpoch: 2,
      minFallbackBp: 1_000,
    });

    const current = await asRole(db, "service_role", () => topologyRead(db));
    expect(current.version).toBe(2);
    expect(current.assignmentEpoch).toBe(2);
    expect(current.ramp).toEqual(changedRamp);
    expect(current.hubConfig?.rt1).toMatchObject({ enabled: true, weight_bp: 10_000 });
    expect(current.hub2NewRoomAdmissionReady).toBe(false);

    const audit = await db.query<{
      old_version: number;
      new_version: number;
      old_assignment_epoch: number;
      new_assignment_epoch: number;
      changed_by: string;
      reason: string;
      emergency_override: boolean;
      old_hubs: HubMap;
      new_hubs: HubMap;
      old_ramp: RampConfig;
      new_ramp: RampConfig;
    }>(`
      SELECT old_version, new_version, old_assignment_epoch,
             new_assignment_epoch, changed_by::text, reason, emergency_override,
             old_hubs, new_hubs, old_ramp, new_ramp
      FROM public.realtime_topology_audit
    `);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      old_version: 1,
      new_version: 2,
      old_assignment_epoch: 1,
      new_assignment_epoch: 2,
      changed_by: actorId,
      reason: "local synthetic topology test",
      emergency_override: true,
      old_hubs: baselineHubs,
      new_hubs: enabledRt1,
      old_ramp: baselineRamp,
      new_ramp: changedRamp,
    });
  } finally {
    await db.close();
  }
});

it("exposes topology and monitor RPCs only to service_role", async () => {
  const db = await createDatabase();
  try {
    const signatures = [
      "public.realtime_topology_read()",
      "public.realtime_topology_update(bigint,integer,jsonb,jsonb,uuid,text,boolean)",
      "public.realtime_hub_probe_claim(text,bigint)",
      "public.realtime_hub_probe_complete(text,bigint,uuid,boolean)",
      "public.realtime_hub_health_read(text,bigint)",
      "public.realtime_topology_hubs_valid(integer,jsonb,jsonb)",
      "public.realtime_topology_budget_values_valid(jsonb,boolean)",
      "public.realtime_topology_timestamp_valid(jsonb)",
      "public.realtime_hub_down_ttl_active(timestamp with time zone,timestamp with time zone)",
    ];
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const signature of signatures) {
        const result = await db.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [role, signature],
        );
        expect(result.rows[0].allowed, `${role} ${signature}`).toBe(
          role === "service_role",
        );
      }
    }

    for (const role of ["anon", "authenticated"]) {
      await asRole(db, role, async () => {
        await expect(topologyRead(db)).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("SELECT * FROM public.realtime_topology_config"))
          .rejects.toMatchObject({ code: "42501" });
      });
    }

    await asRole(db, "service_role", async () => {
      await expect(db.query("SELECT * FROM public.realtime_topology_config"))
        .rejects.toMatchObject({ code: "42501" });
      expect((await topologyRead(db)).status).toBe("ok");
    });
  } finally {
    await db.close();
  }
});

it("serializes simultaneous probe reports to one state transition and expires down TTL at its boundary", async () => {
  const db = await createDatabase();
  try {
    const claims = await asRole(db, "service_role", () => Promise.all([
      probeClaim(db, "rt1", 1),
      probeClaim(db, "rt1", 1),
    ]));
    expect(claims.map((claim) => claim.status).sort()).toEqual([
      "lease_held",
      "probe_started",
    ]);
    const lease = claims.find((claim) => claim.status === "probe_started");
    expect(lease?.leaseId).toBeDefined();
    expect(lease?.leaseSeconds).toBe(10);

    const reports = await asRole(db, "service_role", () => Promise.all([
      probeComplete(db, "rt1", 1, lease!.leaseId!, false),
      probeComplete(db, "rt1", 1, lease!.leaseId!, false),
    ]));
    expect(reports.map((report) => report.status).sort()).toEqual([
      "accepted",
      "stale_lease",
    ]);

    const state = await db.query<{
      health_status: string;
      state_version: number;
      consecutive_failures: number;
      down_until: string;
    }>(`
      SELECT health_status, state_version, consecutive_failures, down_until
      FROM public.realtime_hub_health_state
      WHERE hub_id = 'rt1'
    `);
    expect(state.rows[0]).toMatchObject({
      health_status: "down",
      state_version: 1,
      consecutive_failures: 1,
    });

    const ttlBoundary = await asRole(db, "service_role", async () => {
      const result = await db.query<{ before_expiry: boolean; at_expiry: boolean }>(
        `SELECT
          public.realtime_hub_down_ttl_active(
            $1::timestamptz, $1::timestamptz - interval '1 microsecond'
          ) AS before_expiry,
          public.realtime_hub_down_ttl_active(
            $1::timestamptz, $1::timestamptz
          ) AS at_expiry`,
        [state.rows[0].down_until],
      );
      return result.rows[0];
    });
    expect(ttlBoundary).toEqual({ before_expiry: true, at_expiry: false });

    const stillDown = await asRole(db, "service_role", () => probeClaim(db, "rt1", 1));
    expect(stillDown.status).toBe("down_cached");

    await db.query(
      `UPDATE public.realtime_hub_health_state
       SET down_until = clock_timestamp() - interval '1 microsecond',
           checked_at = clock_timestamp() - interval '11 seconds'
       WHERE hub_id = 'rt1'`,
    );
    const expiredClaim = await asRole(db, "service_role", () => probeClaim(db, "rt1", 1));
    expect(expiredClaim.status).toBe("probe_started");
    const expiredState = await db.query<{
      health_status: string;
      state_version: number;
      down_until: string | null;
    }>(`
      SELECT health_status, state_version, down_until
      FROM public.realtime_hub_health_state
      WHERE hub_id = 'rt1'
    `);
    expect(expiredState.rows[0]).toMatchObject({
      health_status: "unknown",
      state_version: 2,
      down_until: null,
    });
  } finally {
    await db.close();
  }
});
