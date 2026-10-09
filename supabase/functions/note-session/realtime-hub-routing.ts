export const HUB_BUCKET_COUNT = 10_000;
export const HUB_BUCKET_DOMAIN = "syrin:hub-bucket:v1";
export const MAX_METRIC_AGE_MS = 5 * 60_000;
export const MAX_FAILOVER_HEALTH_AGE_MS = 10_000;

export type HubId = "rt1" | "rt2";
export type AssignmentHub = HubId | "slow";
export type BudgetMetricName =
  | "worker_requests"
  | "do_billed_requests"
  | "do_gb_s"
  | "do_sqlite_rows_written";
export type BudgetStatus = "ok" | "warning" | "blocked" | "stale";

export interface MetricSample {
  used: number;
  observedThrough: number;
}

export interface BudgetMetricsSnapshot {
  status: "ok" | "unavailable" | "error";
  metrics: Partial<Record<BudgetMetricName, MetricSample>>;
  activeRooms?: Partial<Record<HubId, MetricSample>>;
}

export interface MetricThreshold {
  warning: number;
  hardStop: number;
}

export type HubBudgetThresholds = Record<BudgetMetricName, MetricThreshold>;

/**
 * Safe local defaults only. The topology seed remains disabled and carries no
 * quota values; these defaults never make an unready Hub 2 ready by themselves.
 * A configured 80k hard stop is rejected unless staging headroom was explicitly
 * confirmed in the audited topology configuration.
 */
export const SAFE_FREE_BUDGET_THRESHOLDS: HubBudgetThresholds = {
  worker_requests: { warning: 70_000, hardStop: 70_000 },
  do_billed_requests: { warning: 70_000, hardStop: 70_000 },
  do_gb_s: { warning: 9_100, hardStop: 9_100 },
  do_sqlite_rows_written: { warning: 70_000, hardStop: 70_000 },
};

export interface HubHealthSnapshot {
  healthStatus: "healthy" | "down" | "unknown";
  checkedAt: number | null;
  downUntil: number | null;
  consecutiveFailures: number;
}

export interface HubRoutingConfig {
  rt1: {
    weightBp: number;
    enabled: boolean;
    drain: boolean;
    probeBeforeAssign: boolean;
    maxActiveRooms: number | null;
  };
  rt2: {
    weightBp: number;
    enabled: boolean;
    drain: boolean;
    probeBeforeAssign: boolean;
    maxActiveRooms: number | null;
  };
}

export interface HubAvailability {
  available: boolean;
  probeBeforeAssign: boolean;
}

export interface RampRuntime {
  active: boolean;
  recoveringHubId: HubId;
  currentWeightBp: number;
  targetWeightBp: number;
  lastStepAtMs: number;
  startedAtMs: number;
  stoppedAtMs?: number;
  stoppedReason?: "probe_failed" | "budget_blocked" | "configuration_changed";
}

export interface RampParameters {
  canaryBp: number;
  stepBp: number;
  intervalSeconds: number;
}

export interface BudgetDecision {
  status: BudgetStatus;
  blockedBy?: BudgetMetricName;
  warningBy?: BudgetMetricName[];
  reason?: "metrics_unavailable" | "metrics_stale" | "metrics_invalid" | "thresholds_invalid";
}

export interface AssignmentDecision {
  hubId: AssignmentHub;
  reason:
    | "weighted_bucket"
    | "failover"
    | "failback_or_weight_ramp"
    | "slow_bucket_gap"
    | "hub_unavailable"
    | "destination_probe_required"
    | "metrics_stale"
    | "hub2_not_ready"
    | "capacity_reached"
    | "capacity_metrics_stale";
  effectiveWeights: { rt1: number; rt2: number };
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export async function stableRoomBucket(opaqueRoomId: string): Promise<number> {
  if (typeof opaqueRoomId !== "string" || opaqueRoomId.length === 0) {
    throw new Error("Invalid opaque room ID");
  }
  const encoder = new TextEncoder();
  const prefix = encoder.encode(HUB_BUCKET_DOMAIN);
  const room = encoder.encode(opaqueRoomId);
  const input = new Uint8Array(prefix.length + room.length);
  input.set(prefix);
  input.set(room, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const first32Bits = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
    .getUint32(0, false);
  return first32Bits % HUB_BUCKET_COUNT;
}

export function chooseHubForBucket(
  bucket: number,
  effectiveRt1Bp: number,
  effectiveRt2Bp: number,
): AssignmentHub {
  if (!isSafeIntegerInRange(bucket, 0, HUB_BUCKET_COUNT - 1)) {
    throw new Error("Invalid room bucket");
  }
  if (
    !isSafeIntegerInRange(effectiveRt1Bp, 0, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(effectiveRt2Bp, 0, HUB_BUCKET_COUNT)
    || effectiveRt1Bp + effectiveRt2Bp > HUB_BUCKET_COUNT
  ) throw new Error("Invalid effective weights");

  if (bucket < effectiveRt2Bp) return "rt2";
  if (bucket >= HUB_BUCKET_COUNT - effectiveRt1Bp) return "rt1";
  return "slow";
}

export function evaluateHub2Budget(
  snapshot: BudgetMetricsSnapshot,
  thresholds: HubBudgetThresholds,
  nowMs: number,
  stagingHeadroomVerified = false,
): BudgetDecision {
  if (snapshot.status !== "ok") {
    return { status: "stale", reason: "metrics_unavailable" };
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return { status: "stale", reason: "metrics_invalid" };
  }

  const names: BudgetMetricName[] = [
    "worker_requests",
    "do_billed_requests",
    "do_gb_s",
    "do_sqlite_rows_written",
  ];
  const warningBy: BudgetMetricName[] = [];
  for (const name of names) {
    const sample = snapshot.metrics[name];
    const threshold = thresholds?.[name];
    if (
      !sample
      || !Number.isFinite(sample.used)
      || sample.used < 0
      || !Number.isFinite(sample.observedThrough)
      || sample.observedThrough > nowMs
    ) return { status: "stale", reason: "metrics_invalid" };
    if (nowMs - sample.observedThrough > MAX_METRIC_AGE_MS) {
      return { status: "stale", reason: "metrics_stale" };
    }
    if (
      !threshold
      || !Number.isFinite(threshold.warning)
      || !Number.isFinite(threshold.hardStop)
      || threshold.warning <= 0
      || threshold.hardStop <= 0
      || threshold.warning > threshold.hardStop
    ) return { status: "stale", reason: "thresholds_invalid" };
    if (threshold.hardStop > 80_000) {
      return { status: "stale", reason: "thresholds_invalid" };
    }
    if (
      threshold.hardStop === 80_000
      && (name === "worker_requests" || name === "do_sqlite_rows_written")
      && !stagingHeadroomVerified
    ) return { status: "stale", reason: "thresholds_invalid" };
    if (sample.used >= threshold.hardStop) {
      return { status: "blocked", blockedBy: name };
    }
    if (sample.used >= threshold.warning) warningBy.push(name);
  }

  return warningBy.length > 0
    ? { status: "warning", warningBy }
    : { status: "ok" };
}

function isFreshHealthy(
  health: HubHealthSnapshot | undefined,
  nowMs: number,
): boolean {
  return health?.healthStatus === "healthy"
    && health.checkedAt !== null
    && Number.isFinite(health.checkedAt)
    && health.checkedAt <= nowMs
    && nowMs - health.checkedAt <= MAX_FAILOVER_HEALTH_AGE_MS;
}

function weightedRanges(
  hubs: HubRoutingConfig,
  availability: Record<HubId, HubAvailability>,
  rampRuntime?: RampRuntime | null,
): { rt1: number; rt2: number } {
  const rt1Available = availability.rt1.available;
  const rt2Available = availability.rt2.available;
  if (!rt1Available && !rt2Available) return { rt1: 0, rt2: 0 };
  if (!rt1Available) return { rt1: 0, rt2: HUB_BUCKET_COUNT };
  if (!rt2Available) return { rt1: HUB_BUCKET_COUNT, rt2: 0 };

  let rt1 = hubs.rt1.weightBp;
  let rt2 = hubs.rt2.weightBp;
  if (rampRuntime?.active) {
    if (rampRuntime.recoveringHubId === "rt1") {
      rt1 = rampRuntime.currentWeightBp;
      rt2 = HUB_BUCKET_COUNT - rt1;
    } else {
      rt2 = rampRuntime.currentWeightBp;
      rt1 = HUB_BUCKET_COUNT - rt2;
    }
  }
  if (
    !isSafeIntegerInRange(rt1, 0, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(rt2, 0, HUB_BUCKET_COUNT)
    || rt1 + rt2 > HUB_BUCKET_COUNT
  ) throw new Error("Invalid effective weights");
  return { rt1, rt2 };
}

function isNewRoomCapacityAvailable(
  hubId: HubId,
  hubs: HubRoutingConfig,
  metrics: BudgetMetricsSnapshot | undefined,
  nowMs: number,
): { available: boolean; stale: boolean } {
  const maxRooms = hubs[hubId].maxActiveRooms;
  if (maxRooms === null) return { available: true, stale: false };
  const count = metrics?.activeRooms?.[hubId];
  if (
    !count
    || !Number.isFinite(count.used)
    || count.used < 0
    || !Number.isFinite(count.observedThrough)
    || count.observedThrough > nowMs
    || nowMs - count.observedThrough > MAX_METRIC_AGE_MS
  ) return { available: false, stale: true };
  return { available: count.used < maxRooms, stale: false };
}

export function planHubAssignment(input: {
  bucket: number;
  currentHub?: AssignmentHub | null;
  hubs: HubRoutingConfig;
  availability: Record<HubId, HubAvailability>;
  health: Record<HubId, HubHealthSnapshot>;
  budgetStatus: BudgetStatus;
  budgetReadiness: boolean;
  nowMs: number;
  destinationWasJustProbedHealthy?: boolean;
  rampRuntime?: RampRuntime | null;
  metrics?: BudgetMetricsSnapshot;
}): AssignmentDecision {
  const currentHub = input.currentHub ?? null;
  const availability = {
    rt1: { ...input.availability.rt1 },
    rt2: { ...input.availability.rt2 },
  };
  const effective = weightedRanges(input.hubs, availability, input.rampRuntime);
  const weightedCandidate = chooseHubForBucket(input.bucket, effective.rt1, effective.rt2);

  if (
    input.budgetStatus === "stale"
    && (currentHub === "rt2" || weightedCandidate === "rt2")
  ) {
    return { hubId: "slow", reason: "metrics_stale", effectiveWeights: effective };
  }

  if (!input.budgetReadiness) {
    availability.rt2.available = false;
  }
  if (input.budgetStatus === "blocked") availability.rt2.available = false;

  let candidate: AssignmentHub;
  let reason: AssignmentDecision["reason"] = "weighted_bucket";
  if (
    (currentHub === "rt1" && !availability.rt1.available)
    || (currentHub === "rt2" && !availability.rt2.available)
  ) {
    const other: HubId = currentHub === "rt1" ? "rt2" : "rt1";
    if (!availability[other].available) {
      candidate = "slow";
      reason = input.budgetReadiness ? "hub_unavailable" : "hub2_not_ready";
    } else {
      candidate = other;
      reason = "failover";
    }
  } else if (weightedCandidate === "rt2" && !availability.rt2.available) {
    candidate = availability.rt1.available ? "rt1" : "slow";
    reason = input.budgetReadiness ? "hub_unavailable" : "hub2_not_ready";
  } else if (weightedCandidate === "rt1" && !availability.rt1.available) {
    candidate = availability.rt2.available ? "rt2" : "slow";
    reason = "hub_unavailable";
  } else {
    candidate = weightedCandidate;
    if (currentHub && currentHub !== "slow" && currentHub !== candidate) {
      reason = "failback_or_weight_ramp";
    } else if (candidate === "slow") {
      reason = "slow_bucket_gap";
    }
  }

  if (candidate === "slow") {
    return { hubId: candidate, reason, effectiveWeights: effective };
  }

  const currentUnavailable = currentHub !== null
    && currentHub !== "slow"
    && !availability[currentHub].available;
  const isFailover = currentUnavailable && candidate !== currentHub;
  if (
    isFailover
    && input.hubs[candidate].probeBeforeAssign
    && !input.destinationWasJustProbedHealthy
    && !isFreshHealthy(input.health[candidate], input.nowMs)
  ) {
    return {
      hubId: "slow",
      reason: "destination_probe_required",
      effectiveWeights: effective,
    };
  }

  if (currentHub !== candidate) {
    const capacity = isNewRoomCapacityAvailable(candidate, input.hubs, input.metrics, input.nowMs);
    if (!capacity.available) {
      if (capacity.stale) {
        return {
          hubId: "slow",
          reason: "capacity_metrics_stale",
          effectiveWeights: effective,
        };
      }
      const other: HubId = candidate === "rt1" ? "rt2" : "rt1";
      if (availability[other].available) {
        const otherCapacity = isNewRoomCapacityAvailable(other, input.hubs, input.metrics, input.nowMs);
        if (otherCapacity.available) {
          if (
            isFailover
            && input.hubs[other].probeBeforeAssign
            && !input.destinationWasJustProbedHealthy
            && !isFreshHealthy(input.health[other], input.nowMs)
          ) return {
            hubId: "slow",
            reason: "destination_probe_required",
            effectiveWeights: effective,
          };
          return { hubId: other, reason: "capacity_reached", effectiveWeights: effective };
        }
      }
      return { hubId: "slow", reason: "capacity_reached", effectiveWeights: effective };
    }
  }

  return { hubId: candidate, reason, effectiveWeights: effective };
}

export function beginRecoveryRamp(
  recoveringHubId: HubId,
  targetWeightBp: number,
  nowMs: number,
  params: RampParameters,
): RampRuntime {
  if (
    !isSafeIntegerInRange(targetWeightBp, 1, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(params.canaryBp, 1, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(params.stepBp, 1, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(params.intervalSeconds, 1, 2_147_483_647)
    || !Number.isFinite(nowMs)
    || nowMs < 0
  ) throw new Error("Invalid failback ramp configuration");
  const currentWeightBp = Math.min(params.canaryBp, targetWeightBp);
  return {
    active: currentWeightBp < targetWeightBp,
    recoveringHubId,
    currentWeightBp,
    targetWeightBp,
    lastStepAtMs: nowMs,
    startedAtMs: nowMs,
  };
}

export function advanceRamp(
  runtime: RampRuntime,
  nowMs: number,
  stepBp: number,
  intervalSeconds: number,
  budgetStatus: BudgetStatus,
): RampRuntime {
  if (!runtime.active || budgetStatus !== "ok") return runtime;
  if (
    !Number.isFinite(nowMs)
    || nowMs < runtime.lastStepAtMs
    || !isSafeIntegerInRange(stepBp, 1, HUB_BUCKET_COUNT)
    || !isSafeIntegerInRange(intervalSeconds, 1, 2_147_483_647)
  ) return runtime;
  if (nowMs - runtime.lastStepAtMs < intervalSeconds * 1_000) return runtime;

  const remaining = runtime.targetWeightBp - runtime.currentWeightBp;
  const delta = Math.sign(remaining) * Math.min(Math.abs(remaining), stepBp);
  const currentWeightBp = runtime.currentWeightBp + delta;
  const active = currentWeightBp !== runtime.targetWeightBp;
  return {
    ...runtime,
    active,
    currentWeightBp,
    lastStepAtMs: nowMs,
    ...(active ? {} : { stoppedAtMs: nowMs }),
  };
}

export function stopRamp(
  runtime: RampRuntime,
  nowMs: number,
  reason: NonNullable<RampRuntime["stoppedReason"]>,
): RampRuntime {
  if (!runtime.active) return runtime;
  return {
    ...runtime,
    active: false,
    stoppedAtMs: nowMs,
    stoppedReason: reason,
  };
}
