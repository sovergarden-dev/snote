import { describe, expect, it } from "vitest";
import {
  advanceRamp,
  beginRecoveryRamp,
  chooseHubForBucket,
  evaluateHub2Budget,
  planHubAssignment,
  SAFE_FREE_BUDGET_THRESHOLDS,
  stopRamp,
  type BudgetMetricName,
  type BudgetMetricsSnapshot,
  type HubAvailability,
  type HubRoutingConfig,
  type HubHealthSnapshot,
  type RampRuntime,
} from "../../supabase/functions/note-session/realtime-hub-routing.ts";

const now = Date.parse("2026-10-10T00:00:00.000Z");
const fresh = (used: number) => ({ used, observedThrough: now - 1_000 });
const healthy = (checkedAt = now - 1_000): HubHealthSnapshot => ({
  healthStatus: "healthy",
  checkedAt,
  downUntil: null,
  consecutiveFailures: 0,
});
const unknown: HubHealthSnapshot = {
  healthStatus: "unknown",
  checkedAt: null,
  downUntil: null,
  consecutiveFailures: 0,
};
const healthyMetrics = (): BudgetMetricsSnapshot => ({
  status: "ok",
  metrics: {
    worker_requests: fresh(1_000),
    do_billed_requests: fresh(1_000),
    do_gb_s: fresh(100),
    do_sqlite_rows_written: fresh(1_000),
  },
  activeRooms: {
    rt1: { used: 10, observedThrough: now - 1_000 },
    rt2: { used: 10, observedThrough: now - 1_000 },
  },
});
const hub = (
  weightBp: number,
  overrides: Partial<HubRoutingConfig["rt1"]> = {},
): HubRoutingConfig["rt1"] => ({
  weightBp,
  enabled: true,
  drain: false,
  probeBeforeAssign: false,
  maxActiveRooms: null,
  ...overrides,
});

const baselineHubs: HubRoutingConfig = {
  rt1: hub(9_000, { probeBeforeAssign: true }),
  rt2: hub(1_000),
};

const availability = (
  overrides: Partial<Record<"rt1" | "rt2", Partial<HubAvailability>>> = {},
): Record<"rt1" | "rt2", HubAvailability> => ({
  rt1: { available: true, probeBeforeAssign: true, ...overrides.rt1 },
  rt2: { available: true, probeBeforeAssign: false, ...overrides.rt2 },
});

describe("K2 stable bucket assignment", () => {
  it("uses the approved SHA-256 domain and first 32-bit bucket vector", async () => {
    const { stableRoomBucket } = await import(
      "../../supabase/functions/note-session/realtime-hub-routing.ts"
    );
    await expect(stableRoomBucket("synthetic-room-42")).resolves.toBe(1_650);
    await expect(stableRoomBucket("synthetic-room-42")).resolves.toBe(1_650);
  });

  it("moves only buckets inside the changed interval and preserves unchanged targets", () => {
    const before = (bucket: number) => chooseHubForBucket(bucket, 9_000, 1_000);
    const after = (bucket: number) => chooseHubForBucket(bucket, 5_000, 5_000);
    for (let bucket = 0; bucket < 10_000; bucket++) {
      const changed = before(bucket) !== after(bucket);
      expect(changed).toBe(bucket >= 1_000 && bucket < 5_000);
    }
  });

  it("rejects overlapping effective weight ranges", () => {
    expect(() => chooseHubForBucket(0, 7_000, 4_000)).toThrow(/effective weights/i);
  });
});

describe("failover and metrics guards", () => {
  it("fails over idempotently to the only available hub and honors probe-before-assign", () => {
    const hubsRequiringProbe = {
      ...baselineHubs,
      rt2: { ...baselineHubs.rt2, probeBeforeAssign: true },
    };
    const routed = planHubAssignment({
      bucket: 9_500,
      currentHub: "rt1",
      hubs: hubsRequiringProbe,
      availability: availability({ rt1: { available: false } }),
      health: { rt1: { ...unknown, healthStatus: "down" }, rt2: unknown },
      budgetStatus: "ok",
      budgetReadiness: true,
      nowMs: now,
      destinationWasJustProbedHealthy: false,
    });
    expect(routed.hubId).toBe("slow");
    expect(routed.reason).toBe("destination_probe_required");

    const justProbed = planHubAssignment({
      bucket: 9_500,
      currentHub: "rt1",
      hubs: hubsRequiringProbe,
      availability: availability({ rt1: { available: false } }),
      health: { rt1: { ...unknown, healthStatus: "down" }, rt2: unknown },
      budgetStatus: "ok",
      budgetReadiness: true,
      nowMs: now,
      destinationWasJustProbedHealthy: true,
    });
    expect(justProbed.hubId).toBe("rt2");
    expect(justProbed.effectiveWeights).toEqual({ rt1: 0, rt2: 10_000 });

    const replay = planHubAssignment({
      bucket: 9_500,
      currentHub: "rt2",
      hubs: hubsRequiringProbe,
      availability: availability({ rt1: { available: false } }),
      health: { rt1: { ...unknown, healthStatus: "down" }, rt2: unknown },
      budgetStatus: "ok",
      budgetReadiness: true,
      nowMs: now,
      destinationWasJustProbedHealthy: false,
    });
    expect(replay.hubId).toBe("rt2");
  });

  it("does not assign Hub 2 and returns its cohort to slow sync when metrics are stale", () => {
    const metrics = healthyMetrics();
    metrics.metrics.worker_requests = { used: 10, observedThrough: now - 301_000 };
    const budget = evaluateHub2Budget(
      metrics,
      SAFE_FREE_BUDGET_THRESHOLDS,
      now,
    );
    expect(budget.status).toBe("stale");
    const route = planHubAssignment({
      bucket: 500,
      currentHub: "rt2",
      hubs: baselineHubs,
      availability: availability(),
      health: { rt1: healthy(), rt2: healthy() },
      budgetStatus: budget.status,
      budgetReadiness: true,
      nowMs: now,
    });
    expect(route.hubId).toBe("slow");
    expect(route.reason).toBe("metrics_stale");
  });

  it("fails closed when a metric is absent, malformed, future-dated, or hard-stopped", () => {
    const cases: BudgetMetricsSnapshot[] = [];
    const missing = healthyMetrics();
    delete missing.metrics.do_gb_s;
    cases.push(missing);
    const malformed = healthyMetrics();
    malformed.metrics.worker_requests = { used: -1, observedThrough: now - 1_000 };
    cases.push(malformed);
    const future = healthyMetrics();
    future.metrics.do_billed_requests = { used: 1, observedThrough: now + 1 };
    cases.push(future);
    const hardStop = healthyMetrics();
    hardStop.metrics.do_sqlite_rows_written = { used: 70_000, observedThrough: now - 1_000 };
    cases.push(hardStop);

    for (const sample of cases) {
      expect(evaluateHub2Budget(sample, SAFE_FREE_BUDGET_THRESHOLDS, now).status)
        .not.toBe("ok");
    }
  });

  it("checks every quota metric independently and stops at its configured threshold", () => {
    const metricNames: BudgetMetricName[] = [
      "worker_requests",
      "do_billed_requests",
      "do_gb_s",
      "do_sqlite_rows_written",
    ];
    for (const name of metricNames) {
      const metrics = healthyMetrics();
      const threshold = SAFE_FREE_BUDGET_THRESHOLDS[name];
      metrics.metrics[name] = { used: threshold.hardStop, observedThrough: now - 1_000 };
      expect(evaluateHub2Budget(metrics, SAFE_FREE_BUDGET_THRESHOLDS, now))
        .toMatchObject({ status: "blocked", blockedBy: name });
    }
  });

  it("stops ramp growth at the warning threshold and only accepts 80k after staging proof", () => {
    const metrics = healthyMetrics();
    metrics.metrics.worker_requests = { used: 70_000, observedThrough: now - 1_000 };
    expect(evaluateHub2Budget(metrics, SAFE_FREE_BUDGET_THRESHOLDS, now).status)
      .toBe("blocked");

    const thresholds = {
      ...SAFE_FREE_BUDGET_THRESHOLDS,
      worker_requests: { warning: 70_000, hardStop: 80_000 },
    };
    metrics.metrics.worker_requests = { used: 75_000, observedThrough: now - 1_000 };
    expect(evaluateHub2Budget(metrics, thresholds, now).status).toBe("stale");
    expect(evaluateHub2Budget(metrics, thresholds, now, true).status).toBe("warning");
    metrics.metrics.worker_requests = { used: 80_000, observedThrough: now - 1_000 };
    expect(evaluateHub2Budget(metrics, thresholds, now, true))
      .toMatchObject({ status: "blocked", blockedBy: "worker_requests" });
  });
});

describe("failback ramp", () => {
  it("starts at a 5% canary and adds exactly 10 points every five minutes", () => {
    let runtime = beginRecoveryRamp("rt1", 9_000, now, {
      canaryBp: 500,
      stepBp: 1_000,
      intervalSeconds: 300,
    });
    expect(runtime).toMatchObject({ currentWeightBp: 500, targetWeightBp: 9_000, active: true });

    expect(advanceRamp(runtime, now + 299_999, 1_000, 300, "ok")).toEqual(runtime);
    runtime = advanceRamp(runtime, now + 300_000, 1_000, 300, "ok");
    expect(runtime.currentWeightBp).toBe(1_500);
    expect(runtime.lastStepAtMs).toBe(now + 300_000);
    runtime = advanceRamp(runtime, now + 600_000, 1_000, 300, "ok");
    expect(runtime.currentWeightBp).toBe(2_500);
  });

  it("does not catch up multiple missed steps at once and terminates exactly at target", () => {
    let runtime: RampRuntime = {
      active: true,
      recoveringHubId: "rt2",
      currentWeightBp: 500,
      targetWeightBp: 1_000,
      lastStepAtMs: now,
      startedAtMs: now,
    };
    runtime = advanceRamp(runtime, now + 30 * 60_000, 1_000, 300, "ok");
    expect(runtime).toMatchObject({ currentWeightBp: 1_000, targetWeightBp: 1_000, active: false });
  });

  it("holds ramp on budget warning and stops it on probe failure", () => {
    const runtime = beginRecoveryRamp("rt1", 9_000, now, {
      canaryBp: 500,
      stepBp: 1_000,
      intervalSeconds: 300,
    });
    expect(advanceRamp(runtime, now + 300_000, 1_000, 300, "warning")).toEqual(runtime);
    expect(stopRamp(runtime, now + 300_000, "probe_failed")).toMatchObject({
      active: false,
      stoppedReason: "probe_failed",
      stoppedAtMs: now + 300_000,
    });
  });
});
