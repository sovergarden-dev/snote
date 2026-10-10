// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const migrationPaths = [
  "supabase/migrations/20261010000000_realtime_topology_monitor.sql",
  "supabase/migrations/20261010010000_realtime_hub_assignment.sql",
];
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
  initialActivationException?: boolean;
  hubConfig?: HubMap;
  ramp?: RampConfig;
  hub2NewRoomAdmissionReady?: boolean;
};
type AssignmentResult = {
  status: string;
  bucket?: number;
  hubId?: string;
  assignmentEpoch?: number;
  topologyEpoch?: number;
};
type ProbeResult = {
  status: string;
  leaseId?: string;
  leaseSeconds?: number;
  stateVersion?: number;
  downUntil?: string | null;
};
type RampStateResult = {
  status: string;
  stateVersion?: number;
  topologyVersion?: number;
  assignmentEpoch?: number;
  runtime?: Record<string, unknown>;
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
  for (const migrationPath of migrationPaths) {
    await db.exec(readFileSync(resolve(process.cwd(), migrationPath), "utf8"));
  }
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

async function rampStateRead(db: PGlite): Promise<RampStateResult> {
  const result = await db.query<{ result: RampStateResult }>(
    "SELECT public.realtime_hub_ramp_state_read() AS result",
  );
  return result.rows[0].result;
}

async function rampStateCas(
  db: PGlite,
  expectedStateVersion: number,
  expectedTopologyVersion: number,
  expectedAssignmentEpoch: number,
  runtime: Record<string, unknown>,
): Promise<RampStateResult> {
  const result = await db.query<{ result: RampStateResult }>(
    `SELECT public.realtime_hub_ramp_state_cas(
      $1::bigint, $2::bigint, $3::bigint, $4::jsonb
    ) AS result`,
    [
      expectedStateVersion,
      expectedTopologyVersion,
      expectedAssignmentEpoch,
      JSON.stringify(runtime),
    ],
  );
  return result.rows[0].result;
}

async function configurationAndAuditSnapshot(db: PGlite) {
  const config = await db.query<{ configuration: unknown }>(
    "SELECT to_jsonb(c) AS configuration FROM public.realtime_topology_config AS c WHERE singleton",
  );
  const audit = await db.query<{ entries: unknown }>(`
    SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.audit_id), '[]'::jsonb) AS entries
    FROM public.realtime_topology_audit AS a
  `);
  return { configuration: config.rows[0].configuration, audit: audit.rows[0].entries };
}

function configuredRt2(weight_bp: number): HubConfig {
  return {
    ...baselineHubs.rt2,
    weight_bp,
    enabled: true,
    budget_profile: "cf_free_daily",
    budget_thresholds: {
      worker_requests: { warning: 70_000, hard_stop: 70_000 },
      do_billed_requests: { warning: 70_000, hard_stop: 70_000 },
      do_gb_s: { warning: 9_100, hard_stop: 9_100 },
      do_sqlite_rows_written: { warning: 70_000, hard_stop: 70_000 },
    },
    unit_prices: {
      worker_requests: 1,
      do_billed_requests: 1,
      do_gb_s: 1,
      do_sqlite_rows_written: 1,
    },
    max_active_rooms: 1_000,
  };
}

async function assignmentRead(db: PGlite, roomKeyHash: string) {
  const result = await db.query<{ result: AssignmentResult }>(
    "SELECT public.realtime_room_assignment_read($1::text) AS result",
    [roomKeyHash],
  );
  return result.rows[0].result;
}

async function assignmentApply(
  db: PGlite,
  roomKeyHash: string,
  bucket: number,
  targetHubId: string,
  topologyEpoch: number,
  expectedAssignmentEpoch: number | null,
) {
  const result = await db.query<{ result: AssignmentResult }>(
    `SELECT public.realtime_room_assignment_apply(
      $1::text, $2::integer, $3::text, $4::bigint, $5::bigint
    ) AS result`,
    [roomKeyHash, bucket, targetHubId, topologyEpoch, expectedAssignmentEpoch],
  );
  return result.rows[0].result;
}

async function assignmentCleanup(db: PGlite): Promise<number> {
  const result = await db.query<{ removed: number }>(
    "SELECT public.realtime_room_assignment_cleanup() AS removed",
  );
  return result.rows[0].removed;
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
    const initialRampState = await asRole(db, "service_role", () => rampStateRead(db));
    expect(initial).toMatchObject({
      status: "ok",
      version: 1,
      assignmentEpoch: 1,
      minFallbackBp: 1_000,
      ramp: baselineRamp,
      hub2NewRoomAdmissionReady: false,
      hubConfig: baselineHubs,
    });
    expect(initialRampState).toMatchObject({
      status: "ok",
      stateVersion: 1,
      topologyVersion: initial.version,
      assignmentEpoch: initial.assignmentEpoch,
      runtime: { active: false },
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
}, 15_000);

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
    const initialActivation = await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, enabledRt1, baselineRamp),
    );
    expect(initialActivation).toMatchObject({
      status: "updated",
      version: 2,
      assignmentEpoch: 2,
      initialActivationException: true,
    });
    expect((await topologyRead(db)).hub2NewRoomAdmissionReady).toBe(false);

    const splitHubs: HubMap = {
      rt1: { ...enabledRt1.rt1, weight_bp: 7_000 },
      rt2: configuredRt2(3_000),
    };
    const needsEmergency = await asRole(db, "service_role", () =>
      topologyUpdate(db, 2, 1_000, splitHubs, baselineRamp),
    );
    expect(needsEmergency.status).toBe("emergency_override_required");
    expect((await topologyRead(db)).version).toBe(2);

    const changedRamp = { ...baselineRamp, interval_seconds: 600 };
    const updated = await asRole(db, "service_role", () =>
      topologyUpdate(db, 2, 1_000, splitHubs, changedRamp, true),
    );
    expect(updated).toMatchObject({
      status: "updated",
      version: 3,
      assignmentEpoch: 3,
      minFallbackBp: 1_000,
    });

    const current = await asRole(db, "service_role", () => topologyRead(db));
    expect(current.version).toBe(3);
    expect(current.assignmentEpoch).toBe(3);
    expect(current.ramp).toEqual(changedRamp);
    expect(current.hubConfig?.rt1).toMatchObject({ enabled: true, weight_bp: 7_000 });
    expect(current.hubConfig?.rt2).toMatchObject({ enabled: true, weight_bp: 3_000 });
    expect(current.hub2NewRoomAdmissionReady).toBe(true);

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
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({
      old_version: 1,
      new_version: 2,
      old_assignment_epoch: 1,
      new_assignment_epoch: 2,
      changed_by: actorId,
      reason: "local synthetic topology test",
      emergency_override: false,
      old_hubs: baselineHubs,
      new_hubs: enabledRt1,
      old_ramp: baselineRamp,
      new_ramp: baselineRamp,
    });
    expect(audit.rows[1]).toMatchObject({
      old_version: 2,
      new_version: 3,
      old_assignment_epoch: 2,
      new_assignment_epoch: 3,
      changed_by: actorId,
      reason: "local synthetic topology test",
      emergency_override: true,
      old_hubs: enabledRt1,
      new_hubs: splitHubs,
      old_ramp: baselineRamp,
      new_ramp: changedRamp,
    });
  } finally {
    await db.close();
  }
});

it("keeps room-local assignment epochs stable across topology changes and increments only on a hub move", async () => {
  const db = await createDatabase();
  try {
    const rt1Only: HubMap = {
      ...baselineHubs,
      rt1: { ...baselineHubs.rt1, enabled: true, weight_bp: 10_000 },
    };
    const activated = await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, rt1Only, baselineRamp),
    );
    expect(activated.status).toBe("updated");

    const roomKeyHash = "a".repeat(64);
    const initial = await asRole(db, "service_role", () =>
      assignmentApply(db, roomKeyHash, 9_650, "rt1", 2, null),
    );
    expect(initial).toMatchObject({
      status: "assigned",
      bucket: 9_650,
      hubId: "rt1",
      assignmentEpoch: 1,
      topologyEpoch: 2,
    });
    const repeated = await asRole(db, "service_role", () =>
      assignmentApply(db, roomKeyHash, 9_650, "rt1", 2, 1),
    );
    expect(repeated).toMatchObject({ status: "unchanged", assignmentEpoch: 1 });

    const bothHubs: HubMap = {
      rt1: { ...rt1Only.rt1, weight_bp: 9_000 },
      rt2: configuredRt2(1_000),
    };
    const topologyChanged = await asRole(db, "service_role", () =>
      topologyUpdate(db, 2, 1_000, bothHubs, baselineRamp),
    );
    expect(topologyChanged).toMatchObject({ status: "updated", version: 3, assignmentEpoch: 3 });

    const unchangedRoom = await asRole(db, "service_role", () =>
      assignmentApply(db, roomKeyHash, 9_650, "rt1", 3, 1),
    );
    expect(unchangedRoom).toMatchObject({
      status: "unchanged",
      hubId: "rt1",
      assignmentEpoch: 1,
      topologyEpoch: 3,
    });
    const movedRoom = await asRole(db, "service_role", () =>
      assignmentApply(db, roomKeyHash, 9_650, "rt2", 3, 1),
    );
    expect(movedRoom).toMatchObject({
      status: "changed",
      hubId: "rt2",
      assignmentEpoch: 2,
      topologyEpoch: 3,
    });
    expect(await assignmentRead(db, roomKeyHash)).toMatchObject({
      status: "ok",
      hubId: "rt2",
      assignmentEpoch: 2,
      topologyEpoch: 3,
    });

    const staleTopology = await asRole(db, "service_role", () =>
      assignmentApply(db, roomKeyHash, 9_650, "rt1", 2, 2),
    );
    expect(staleTopology.status).toBe("stale_topology");
  } finally {
    await db.close();
  }
});

it("cleans only assignments idle past 90 days in bounded, throttled batches", async () => {
  const db = await createDatabase();
  const activeHash = "a".repeat(64);
  try {
    await db.query(
      `INSERT INTO public.realtime_room_assignment (
        room_key_hash, bucket, hub_id, assignment_epoch, topology_epoch
      ) VALUES ($1, 7, 'rt1', 1, 1)`,
      [activeHash],
    );
    await db.exec(`
      INSERT INTO public.realtime_room_assignment (
        room_key_hash, bucket, hub_id, assignment_epoch, topology_epoch
      )
      SELECT repeat('b', 60) || lpad(n::text, 4, '0'), n - 1, 'rt1', 1, 1
      FROM generate_series(1, 101) AS series(n);
      UPDATE public.realtime_room_assignment
      SET last_seen_at = clock_timestamp() - interval '90 days 1 microsecond'
      WHERE room_key_hash LIKE 'bbbb%';
      UPDATE public.realtime_room_assignment_gc_state
      SET next_run_at = clock_timestamp() - interval '1 second'
      WHERE singleton;
    `);

    const firstBatch = await asRole(db, "service_role", () => assignmentCleanup(db));
    expect(firstBatch).toBe(100);
    const afterFirst = await db.query<{ stale: number; active: number }>(`
      SELECT
        count(*) FILTER (WHERE room_key_hash LIKE 'bbbb%')::integer AS stale,
        count(*) FILTER (WHERE room_key_hash = '${activeHash}')::integer AS active
      FROM public.realtime_room_assignment
    `);
    expect(afterFirst.rows[0]).toEqual({ stale: 1, active: 1 });
    await expect(asRole(db, "service_role", () => assignmentCleanup(db))).resolves.toBe(0);

    await db.exec(`
      UPDATE public.realtime_room_assignment_gc_state
      SET next_run_at = clock_timestamp() - interval '1 second'
      WHERE singleton;
    `);
    await expect(asRole(db, "service_role", () => assignmentCleanup(db))).resolves.toBe(1);
    const remaining = await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.realtime_room_assignment",
    );
    expect(remaining.rows[0].count).toBe(1);
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
      "public.realtime_hub_ramp_state_read()",
      "public.realtime_hub_ramp_state_cas(bigint,bigint,bigint,jsonb)",
      "public.realtime_hub_probe_claim(text,bigint)",
      "public.realtime_hub_probe_complete(text,bigint,uuid,boolean)",
      "public.realtime_hub_health_read(text,bigint)",
      "public.realtime_room_assignment_read(text)",
      "public.realtime_room_assignment_apply(text,integer,text,bigint,bigint)",
      "public.realtime_room_assignment_cleanup()",
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
        await expect(db.query("SELECT * FROM public.realtime_room_assignment"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(db.query("SELECT * FROM public.realtime_room_assignment_gc_state"))
          .rejects.toMatchObject({ code: "42501" });
        await expect(db.query("SELECT * FROM public.realtime_hub_ramp_state"))
          .rejects.toMatchObject({ code: "42501" });
      });
    }

    await asRole(db, "service_role", async () => {
      await expect(db.query("SELECT * FROM public.realtime_topology_config"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT * FROM public.realtime_room_assignment"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT * FROM public.realtime_room_assignment_gc_state"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(db.query("SELECT * FROM public.realtime_hub_ramp_state"))
        .rejects.toMatchObject({ code: "42501" });
      expect((await rampStateRead(db)).status).toBe("ok");
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
for (const scenario of [
  { name: "rt1 9,000/1,000", recoveringHub: "rt1" as const, rt1Weight: 9_000, rt2Weight: 1_000 },
  { name: "rt2 1,000/9,000", recoveringHub: "rt2" as const, rt1Weight: 1_000, rt2Weight: 9_000 },
  { name: "custom 7,000/3,000", recoveringHub: "rt1" as const, rt1Weight: 7_000, rt2Weight: 3_000 },
]) {
  it(`keeps K1 configuration and audit unchanged during ${scenario.name} ramp`, async () => {
    const db = await createDatabase();
    try {
      const hubs: HubMap = {
        rt1: { ...baselineHubs.rt1, enabled: true, weight_bp: scenario.rt1Weight },
        rt2: configuredRt2(scenario.rt2Weight),
      };
      const activated = await asRole(db, "service_role", () =>
        topologyUpdate(db, 1, 1_000, hubs, baselineRamp),
      );
      expect(activated).toMatchObject({ status: "updated", version: 2, assignmentEpoch: 2 });

      const before = await configurationAndAuditSnapshot(db);
      const targetBp = hubs[scenario.recoveringHub].weight_bp;
      let state = await asRole(db, "service_role", () => rampStateRead(db));
      expect(state).toMatchObject({
        status: "ok",
        stateVersion: 1,
        topologyVersion: 1,
        assignmentEpoch: 1,
      });

      let currentBp = 500;
      let active = currentBp < targetBp;
      let lastStepAtMs = 1_800_000_000_000;
      while (true) {
        const runtime = {
          active,
          recovering_hub_id: scenario.recoveringHub,
          current_bp: currentBp,
          target_bp: targetBp,
          last_step_at_ms: lastStepAtMs,
          started_at_ms: 1_800_000_000_000,
        };
        const saved = await asRole(db, "service_role", () =>
          rampStateCas(db, state.stateVersion!, 2, 2, runtime),
        );
        expect(saved.status).toBe("updated");
        state = saved;
        if (!active) break;
        currentBp = Math.min(targetBp, currentBp + 1_000);
        active = currentBp < targetBp;
        lastStepAtMs += 300_000;
      }

      expect(state.runtime).toMatchObject({
        active: false,
        recovering_hub_id: scenario.recoveringHub,
        current_bp: targetBp,
        target_bp: targetBp,
      });
      expect(state.stateVersion).toBeGreaterThan(1);
      expect(await configurationAndAuditSnapshot(db)).toEqual(before);
    } finally {
      await db.close();
    }
  });
}

it("rejects stale ramp writes after a K1 edit and stops old runtime without adding an automation audit", async () => {
  const db = await createDatabase();
  try {
    const firstHubs: HubMap = {
      rt1: { ...baselineHubs.rt1, enabled: true, weight_bp: 9_000 },
      rt2: configuredRt2(1_000),
    };
    await asRole(db, "service_role", () =>
      topologyUpdate(db, 1, 1_000, firstHubs, baselineRamp),
    );
    let state = await asRole(db, "service_role", () => rampStateRead(db));
    const activeRuntime = {
      active: true,
      recovering_hub_id: "rt1",
      current_bp: 500,
      target_bp: 9_000,
      last_step_at_ms: 1_800_000_000_000,
      started_at_ms: 1_800_000_000_000,
    };
    state = await asRole(db, "service_role", () => rampStateCas(db, state.stateVersion!, 2, 2, activeRuntime));
    expect(state.status).toBe("updated");

    const extraIdentifier = await asRole(db, "service_role", () =>
      rampStateCas(db, state.stateVersion!, 2, 2, { ...activeRuntime, note_slug: "synthetic-slug" }),
    );
    expect(extraIdentifier.status).toBe("invalid");

    const wrongTargetWrite = await asRole(db, "service_role", () =>
      rampStateCas(db, state.stateVersion!, 2, 2, { ...activeRuntime, target_bp: 8_000 }),
    );
    expect(wrongTargetWrite.status).toBe("config_changed");

    const changedRamp = { ...baselineRamp, interval_seconds: 600 };
    await asRole(db, "service_role", () => topologyUpdate(db, 2, 1_000, firstHubs, changedRamp));
    const afterUserEdit = await configurationAndAuditSnapshot(db);

    const staleConfigWrite = await asRole(db, "service_role", () =>
      rampStateCas(db, state.stateVersion!, 2, 2, {
        ...activeRuntime,
        current_bp: 1_500,
      }),
    );
    expect(staleConfigWrite.status).toBe("config_changed");

    const staleTargetWrite = await asRole(db, "service_role", () =>
      rampStateCas(db, state.stateVersion!, 3, 3, {
        ...activeRuntime,
        current_bp: 1_500,
      }),
    );
    expect(staleTargetWrite.status).toBe("config_changed");

    const stopped = await asRole(db, "service_role", () => rampStateCas(
      db,
      state.stateVersion!,
      3,
      3,
      { ...activeRuntime, active: false, stopped_reason: "configuration_changed" },
    ));
    expect(stopped).toMatchObject({
      status: "updated",
      topologyVersion: 3,
      assignmentEpoch: 3,
      runtime: { active: false, stopped_reason: "configuration_changed" },
    });
    expect(await configurationAndAuditSnapshot(db)).toEqual(afterUserEdit);

    const staleStateVersion = await asRole(db, "service_role", () =>
      rampStateCas(db, state.stateVersion!, 3, 3, {
        ...activeRuntime,
        active: false,
        stopped_reason: "configuration_changed",
      }),
    );
    expect(staleStateVersion.status).toBe("version_conflict");
  } finally {
    await db.close();
  }
});
