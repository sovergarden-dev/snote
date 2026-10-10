import {
  advanceRamp,
  beginRecoveryRamp,
  evaluateHub2Budget,
  stopRamp,
  type BudgetDecision,
  type BudgetMetricsSnapshot,
  type HubBudgetThresholds,
  type HubId,
  type RampRuntime,
} from "../note-session/realtime-hub-routing.ts";
import {
  runHubHealthProbeRound,
  unavailableHubBudgetMetricsProvider,
  type HubBudgetMetricsProvider,
} from "../note-session/realtime-hub-edge.ts";
import type { RealtimeSigningConfig } from "../_shared/realtime-edge.ts";

const HUB_IDS: HubId[] = ["rt1", "rt2"];
const SECRET_HEADER = "x-snote-monitor-secret";
const MAX_SECRET_BYTES = 512;

export type MonitorRpcName =
  | "realtime_hub_monitor_snapshot"
  | "realtime_hub_probe_claim"
  | "realtime_hub_probe_complete"
  | "realtime_hub_ramp_state_cas"
  | "realtime_room_assignment_cleanup";

export type MonitorRpc = (
  name: MonitorRpcName,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

interface ProbeConfig {
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  downTtlSeconds: number;
  cacheTtlSeconds: number;
}

interface MonitorHubConfig {
  weightBp: number;
  enabled: boolean;
  drain: boolean;
  probe: ProbeConfig;
  budgetThresholds: unknown;
  stagingHeadroomVerified: boolean;
}

interface MonitorHealth {
  healthStatus: "healthy" | "down" | "unknown";
  checkedAt: number | null;
  downUntil: number | null;
  consecutiveFailures: number;
  probeLeaseActive: boolean;
}

interface RampState {
  stateVersion: number;
  topologyVersion: number;
  assignmentEpoch: number;
  runtimeValue: unknown;
  runtime: RampRuntime | null;
}

interface MonitorSnapshot {
  version: number;
  assignmentEpoch: number;
  hubs: Record<HubId, MonitorHubConfig>;
  ramp: { canaryBp: number; stepBp: number; intervalSeconds: number };
  hub2NewRoomAdmissionReady: boolean;
  health: Record<HubId, MonitorHealth>;
  rampState: RampState;
}

export interface RealtimeMonitorDependencies {
  routingEnabled: boolean;
  rpc: MonitorRpc;
  getSigning: () => Promise<RealtimeSigningConfig | null>;
  metricsProvider?: HubBudgetMetricsProvider;
  healthUrl: (hubId: HubId) => string | null;
  now?: () => number;
  fetcher?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface MonitorEndpointDependencies {
  secret: string | null;
  routingEnabled: () => boolean;
  createRpc: () => Promise<MonitorRpc | null>;
  createMonitorDependencies: (rpc: MonitorRpc) => RealtimeMonitorDependencies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = safeInteger(value, 1);
  return parsed;
}

function timestampMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseProbe(value: unknown): ProbeConfig | null {
  if (!isRecord(value)) return null;
  const timeoutMs = positiveInteger(value.timeout_ms);
  const retryCount = safeInteger(value.retry_count);
  const retryDelayMs = safeInteger(value.retry_delay_ms);
  const downTtlSeconds = positiveInteger(value.down_ttl_seconds);
  const cacheTtlSeconds = positiveInteger(value.probe_cache_ttl_seconds);
  if (
    timeoutMs !== 2_000 || retryCount !== 1 || retryDelayMs !== 1_000
    || downTtlSeconds !== 60 || (cacheTtlSeconds !== 10 && cacheTtlSeconds !== 60)
  ) return null;
  return {
    timeoutMs,
    retryCount,
    retryDelayMs,
    downTtlSeconds,
    cacheTtlSeconds,
  };
}

function parseHub(value: unknown): MonitorHubConfig | null {
  if (!isRecord(value)) return null;
  const weightBp = safeInteger(value.weight_bp);
  const probe = parseProbe(value.probe);
  if (
    weightBp === null || weightBp > 10_000
    || typeof value.enabled !== "boolean" || typeof value.drain !== "boolean" || !probe
  ) return null;
  return {
    weightBp,
    enabled: value.enabled,
    drain: value.drain,
    probe,
    budgetThresholds: value.budget_thresholds,
    stagingHeadroomVerified: value.staging_headroom_verified === true,
  };
}

function parseHealth(value: unknown): MonitorHealth | null {
  if (!isRecord(value) || value.status !== "ok") return null;
  if (
    value.healthStatus !== "healthy" && value.healthStatus !== "down"
    && value.healthStatus !== "unknown"
  ) return null;
  const checkedAt = timestampMs(value.checkedAt);
  const downUntil = timestampMs(value.downUntil);
  const consecutiveFailures = safeInteger(value.consecutiveFailures);
  if (
    checkedAt === undefined || downUntil === undefined || consecutiveFailures === null
    || typeof value.probeLeaseActive !== "boolean"
  ) return null;
  return {
    healthStatus: value.healthStatus,
    checkedAt,
    downUntil,
    consecutiveFailures,
    probeLeaseActive: value.probeLeaseActive,
  };
}

function parseRampRuntime(value: unknown): RampRuntime | null {
  if (!isRecord(value) || value.active !== true) return null;
  if (value.recovering_hub_id !== "rt1" && value.recovering_hub_id !== "rt2") return null;
  const currentWeightBp = positiveInteger(value.current_bp);
  const targetWeightBp = positiveInteger(value.target_bp);
  const lastStepAtMs = safeInteger(value.last_step_at_ms);
  const startedAtMs = safeInteger(value.started_at_ms);
  if (
    currentWeightBp === null || targetWeightBp === null || lastStepAtMs === null
    || startedAtMs === null || currentWeightBp >= targetWeightBp
    || targetWeightBp > 10_000
  ) return null;
  return {
    active: true,
    recoveringHubId: value.recovering_hub_id,
    currentWeightBp,
    targetWeightBp,
    lastStepAtMs,
    startedAtMs,
  };
}

function parseRampState(value: unknown): RampState | null {
  if (!isRecord(value) || value.status !== "ok" || !isRecord(value.runtime)) return null;
  const stateVersion = positiveInteger(value.stateVersion);
  const topologyVersion = positiveInteger(value.topologyVersion);
  const assignmentEpoch = positiveInteger(value.assignmentEpoch);
  if (stateVersion === null || topologyVersion === null || assignmentEpoch === null) return null;
  const runtime = value.runtime.active === true ? parseRampRuntime(value.runtime) : null;
  if (value.runtime.active === true && !runtime) return null;
  return {
    stateVersion,
    topologyVersion,
    assignmentEpoch,
    runtimeValue: value.runtime,
    runtime,
  };
}

function parseSnapshot(value: unknown):
  | { status: "not_ready" }
  | { status: "unavailable" }
  | { status: "ok"; snapshot: MonitorSnapshot } {
  if (!isRecord(value)) return { status: "unavailable" };
  if (value.status === "not_ready") return { status: "not_ready" };
  if (value.status !== "ok" || value.ready !== true) return { status: "unavailable" };
  const version = positiveInteger(value.version);
  const assignmentEpoch = positiveInteger(value.assignmentEpoch);
  const rampValue = isRecord(value.ramp) ? value.ramp : null;
  const canaryBp = rampValue ? positiveInteger(rampValue.canary_bp) : null;
  const stepBp = rampValue ? positiveInteger(rampValue.step_bp) : null;
  const intervalSeconds = rampValue ? positiveInteger(rampValue.interval_seconds) : null;
  const hubConfig = isRecord(value.hubConfig) ? value.hubConfig : null;
  const healthValue = isRecord(value.health) ? value.health : null;
  const rampState = parseRampState(value.rampState);
  const rt1 = hubConfig ? parseHub(hubConfig.rt1) : null;
  const rt2 = hubConfig ? parseHub(hubConfig.rt2) : null;
  const rt1Health = healthValue ? parseHealth(healthValue.rt1) : null;
  const rt2Health = healthValue ? parseHealth(healthValue.rt2) : null;
  if (
    version === null || assignmentEpoch === null || canaryBp === null || canaryBp > 10_000
    || stepBp === null || stepBp > 10_000 || intervalSeconds === null
    || intervalSeconds > 2_147_483_647 || !rt1 || !rt2 || !rt1Health || !rt2Health
    || !rampState || typeof value.hub2NewRoomAdmissionReady !== "boolean"
  ) return { status: "unavailable" };
  return {
    status: "ok",
    snapshot: {
      version,
      assignmentEpoch,
      hubs: { rt1, rt2 },
      ramp: { canaryBp, stepBp, intervalSeconds },
      hub2NewRoomAdmissionReady: value.hub2NewRoomAdmissionReady,
      health: { rt1: rt1Health, rt2: rt2Health },
      rampState,
    },
  };
}

function parseThresholds(value: unknown): HubBudgetThresholds | null {
  if (!isRecord(value)) return null;
  const names = [
    "worker_requests",
    "do_billed_requests",
    "do_gb_s",
    "do_sqlite_rows_written",
  ] as const;
  const result: Partial<HubBudgetThresholds> = {};
  for (const name of names) {
    const threshold = value[name];
    if (!isRecord(threshold)) return null;
    const warning = threshold.warning;
    const hardStop = threshold.hard_stop ?? threshold.hardStop;
    if (
      typeof warning !== "number" || !Number.isFinite(warning)
      || typeof hardStop !== "number" || !Number.isFinite(hardStop)
    ) return null;
    result[name] = { warning, hardStop };
  }
  return result as HubBudgetThresholds;
}

/**
 * Reserve every possible attempt in the configured health-probe round. A rt2
 * /healthz call consumes one Worker request and one Durable Object request;
 * no unit-price or GB-second estimate is invented here.
 */
export function accountRt2HealthProbeRequests(
  snapshot: BudgetMetricsSnapshot,
  attempts: number,
): BudgetMetricsSnapshot {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    return { status: "error", metrics: {} };
  }
  const metrics = { ...snapshot.metrics };
  for (const name of ["worker_requests", "do_billed_requests"] as const) {
    const sample = metrics[name];
    if (sample) {
      metrics[name] = { ...sample, used: sample.used + attempts };
    }
  }
  return { ...snapshot, metrics };
}

function budgetDecision(
  topology: MonitorSnapshot,
  metrics: BudgetMetricsSnapshot,
  nowMs: number,
): BudgetDecision {
  const thresholds = parseThresholds(topology.hubs.rt2.budgetThresholds);
  if (!thresholds) return { status: "stale", reason: "thresholds_invalid" };
  return evaluateHub2Budget(
    metrics,
    thresholds,
    nowMs,
    topology.hubs.rt2.stagingHeadroomVerified,
  );
}

async function readMetrics(
  dependencies: RealtimeMonitorDependencies,
  nowMs: number,
): Promise<BudgetMetricsSnapshot> {
  try {
    return await (dependencies.metricsProvider ?? unavailableHubBudgetMetricsProvider)
      .readSnapshot({ nowMs });
  } catch {
    return { status: "error", metrics: {} };
  }
}

function serializeRamp(runtime: RampRuntime): Record<string, unknown> {
  return {
    active: runtime.active,
    recovering_hub_id: runtime.recoveringHubId,
    current_bp: runtime.currentWeightBp,
    target_bp: runtime.targetWeightBp,
    last_step_at_ms: runtime.lastStepAtMs,
    started_at_ms: runtime.startedAtMs,
    ...(runtime.stoppedAtMs === undefined ? {} : { stopped_at_ms: runtime.stoppedAtMs }),
    ...(runtime.stoppedReason === undefined ? {} : { stopped_reason: runtime.stoppedReason }),
  };
}

async function persistRamp(
  dependencies: RealtimeMonitorDependencies,
  snapshot: MonitorSnapshot,
  state: RampState,
  runtime: RampRuntime,
): Promise<RampState | null> {
  const reply = await dependencies.rpc("realtime_hub_ramp_state_cas", {
    p_expected_state_version: state.stateVersion,
    p_expected_topology_version: snapshot.version,
    p_expected_assignment_epoch: snapshot.assignmentEpoch,
    p_runtime: serializeRamp(runtime),
  });
  if (reply.error || !isRecord(reply.data) || reply.data.status !== "updated") return null;
  const updated = parseRampState(reply.data);
  if (
    !updated || updated.stateVersion <= state.stateVersion
    || updated.topologyVersion !== snapshot.version
    || updated.assignmentEpoch !== snapshot.assignmentEpoch
  ) return null;
  return updated;
}

async function updateRampAfterProbe(input: {
  dependencies: RealtimeMonitorDependencies;
  snapshot: MonitorSnapshot;
  state: RampState;
  hubId: HubId;
  probeSucceeded: boolean;
  previousHealth: MonitorHealth;
  budget: BudgetDecision;
  nowMs: number;
}): Promise<RampState> {
  const current = input.state.runtime;
  let next: RampRuntime | null = null;
  if (current?.active && current.recoveringHubId === input.hubId) {
    if (!input.probeSucceeded) {
      next = stopRamp(current, input.nowMs, "probe_failed");
    } else if (input.budget.status === "blocked") {
      next = stopRamp(current, input.nowMs, "budget_blocked");
    } else if (input.budget.status === "ok") {
      next = advanceRamp(
        current,
        input.nowMs,
        input.snapshot.ramp.stepBp,
        input.snapshot.ramp.intervalSeconds,
        input.budget.status,
      );
    }
  } else if (
    input.probeSucceeded && !current?.active
    && (input.previousHealth.healthStatus === "down"
      || input.previousHealth.consecutiveFailures > 0)
  ) {
    const other: HubId = input.hubId === "rt1" ? "rt2" : "rt1";
    const otherAvailable = input.snapshot.hubs[other].enabled
      && !input.snapshot.hubs[other].drain
      && input.snapshot.health[other].healthStatus !== "down";
    const targetWeightBp = input.snapshot.hubs[input.hubId].weightBp;
    if (
      targetWeightBp > 0 && otherAvailable && input.budget.status === "ok"
      && input.snapshot.hub2NewRoomAdmissionReady
    ) {
      next = beginRecoveryRamp(input.hubId, targetWeightBp, input.nowMs, {
        canaryBp: input.snapshot.ramp.canaryBp,
        stepBp: input.snapshot.ramp.stepBp,
        intervalSeconds: input.snapshot.ramp.intervalSeconds,
      });
    }
  }
  if (!next || next === current) return input.state;
  return await persistRamp(input.dependencies, input.snapshot, input.state, next)
    ?? input.state;
}

async function updateRampForKnownHealthy(input: {
  dependencies: RealtimeMonitorDependencies;
  snapshot: MonitorSnapshot;
  state: RampState;
  budget: BudgetDecision;
  nowMs: number;
}): Promise<RampState> {
  const current = input.state.runtime;
  if (!current?.active) return input.state;
  if (input.budget.status === "blocked") {
    const stopped = stopRamp(current, input.nowMs, "budget_blocked");
    return await persistRamp(input.dependencies, input.snapshot, input.state, stopped)
      ?? input.state;
  }
  if (input.budget.status !== "ok") return input.state;
  const advanced = advanceRamp(
    current,
    input.nowMs,
    input.snapshot.ramp.stepBp,
    input.snapshot.ramp.intervalSeconds,
    input.budget.status,
  );
  if (advanced === current) return input.state;
  return await persistRamp(input.dependencies, input.snapshot, input.state, advanced)
    ?? input.state;
}

function probeIsCacheFresh(health: MonitorHealth, hub: MonitorHubConfig, nowMs: number): boolean {
  return health.checkedAt !== null
    && nowMs - health.checkedAt < hub.probe.cacheTtlSeconds * 1_000;
}

function validProbeUrl(value: string | null): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.search === "" && url.hash === "" && url.pathname === "/healthz";
  } catch {
    return false;
  }
}

async function currentBudget(
  dependencies: RealtimeMonitorDependencies,
  snapshot: MonitorSnapshot,
  nowMs: number,
  rt2ProbeAttempts = 0,
): Promise<BudgetDecision> {
  const read = await readMetrics(dependencies, nowMs);
  const accounted = rt2ProbeAttempts > 0
    ? accountRt2HealthProbeRequests(read, rt2ProbeAttempts)
    : read;
  return budgetDecision(snapshot, accounted, nowMs);
}

export async function runRealtimeMonitor(
  dependencies: RealtimeMonitorDependencies,
): Promise<{ status: "feature_disabled" | "not_ready" | "ok" | "unavailable" }> {
  if (!dependencies.routingEnabled) return { status: "feature_disabled" };
  const nowMs = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { status: "unavailable" };

  let snapshotReply: { data: unknown; error: unknown };
  try {
    const snapshotArgs = dependencies.now
      ? { p_at: new Date(nowMs).toISOString() }
      : {};
    snapshotReply = await dependencies.rpc("realtime_hub_monitor_snapshot", {
      ...snapshotArgs,
    });
  } catch {
    return { status: "unavailable" };
  }
  if (snapshotReply.error) return { status: "unavailable" };
  const parsed = parseSnapshot(snapshotReply.data);
  if (parsed.status === "not_ready") return { status: "not_ready" };
  if (parsed.status !== "ok") return { status: "unavailable" };
  const snapshot = parsed.snapshot;

  let rampState = snapshot.rampState;
  if (
    rampState.runtime?.active
    && (rampState.topologyVersion !== snapshot.version
      || rampState.assignmentEpoch !== snapshot.assignmentEpoch)
  ) {
    const stopped = stopRamp(rampState.runtime, nowMs, "configuration_changed");
    const updated = await persistRamp(dependencies, snapshot, rampState, stopped);
    if (!updated) return { status: "unavailable" };
    rampState = updated;
  }

  const probed = new Set<HubId>();
  for (const hubId of HUB_IDS) {
    const hub = snapshot.hubs[hubId];
    let health = snapshot.health[hubId];
    if (!hub.enabled) continue;

    const activeRamp = rampState.runtime;
    if (
      health.healthStatus === "down" && activeRamp?.active
      && activeRamp.recoveringHubId === hubId
    ) {
      const stopped = stopRamp(activeRamp, nowMs, "probe_failed");
      const updated = await persistRamp(dependencies, snapshot, rampState, stopped);
      if (updated) rampState = updated;
    }

    if (health.healthStatus !== "down" && health.healthStatus !== "unknown") continue;
    if (health.probeLeaseActive || probeIsCacheFresh(health, hub, nowMs)) continue;
    if (health.healthStatus === "down" && health.downUntil !== null && health.downUntil > nowMs) continue;

    let budget: BudgetDecision = { status: "stale" };
    if (hubId === "rt2") {
      budget = await currentBudget(
        dependencies,
        snapshot,
        nowMs,
        hub.probe.retryCount + 1,
      );
      if (budget.status === "blocked") {
        if (rampState.runtime?.active && rampState.runtime.recoveringHubId === hubId) {
          const stopped = stopRamp(rampState.runtime, nowMs, "budget_blocked");
          const updated = await persistRamp(dependencies, snapshot, rampState, stopped);
          if (updated) rampState = updated;
        }
        continue;
      }
      if (budget.status === "stale") continue;
    }

    const healthUrl = dependencies.healthUrl(hubId);
    if (!validProbeUrl(healthUrl)) continue;
    let signing: RealtimeSigningConfig | null;
    try {
      signing = await dependencies.getSigning();
    } catch {
      return { status: "unavailable" };
    }
    if (!signing) return { status: "unavailable" };

    let claim: { data: unknown; error: unknown };
    try {
      claim = await dependencies.rpc("realtime_hub_probe_claim", {
        p_hub_id: hubId,
        p_assignment_epoch: snapshot.assignmentEpoch,
      });
    } catch {
      return { status: "unavailable" };
    }
    if (claim.error || !isRecord(claim.data) || claim.data.status !== "probe_started") continue;
    const leaseId = claim.data.leaseId;
    if (
      typeof leaseId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(leaseId)
    ) continue;

    probed.add(hubId);
    let probeSucceeded = false;
    try {
      probeSucceeded = await runHubHealthProbeRound({
        hubId,
        url: healthUrl,
        config: signing,
        timeoutMs: hub.probe.timeoutMs,
        retryCount: hub.probe.retryCount,
        retryDelayMs: hub.probe.retryDelayMs,
        nowMs,
        fetcher: dependencies.fetcher,
        sleep: dependencies.sleep,
      });
    } catch {
      probeSucceeded = false;
    }

    let completed: { data: unknown; error: unknown };
    try {
      completed = await dependencies.rpc("realtime_hub_probe_complete", {
        p_hub_id: hubId,
        p_assignment_epoch: snapshot.assignmentEpoch,
        p_lease_id: leaseId,
        p_probe_succeeded: probeSucceeded,
      });
    } catch {
      return { status: "unavailable" };
    }
    if (completed.error || !isRecord(completed.data) || completed.data.status !== "accepted") continue;

    const previousHealth = health;
    health = {
      ...health,
      healthStatus: probeSucceeded ? "healthy" : "down",
      checkedAt: nowMs,
      downUntil: probeSucceeded ? null : nowMs + hub.probe.downTtlSeconds * 1_000,
      consecutiveFailures: probeSucceeded ? 0 : health.consecutiveFailures + 1,
      probeLeaseActive: false,
    };
    snapshot.health[hubId] = health;

    if (hubId !== "rt2") {
      budget = await currentBudget(dependencies, snapshot, nowMs);
    }
    rampState = await updateRampAfterProbe({
      dependencies,
      snapshot,
      state: rampState,
      hubId,
      probeSucceeded,
      previousHealth,
      budget,
      nowMs,
    });
  }

  if (rampState.runtime?.active) {
    const recoveringHub = rampState.runtime.recoveringHubId;
    const health = snapshot.health[recoveringHub];
    if (!probed.has(recoveringHub) && health.healthStatus === "healthy") {
      const budget = await currentBudget(dependencies, snapshot, nowMs);
      rampState = await updateRampForKnownHealthy({
        dependencies,
        snapshot,
        state: rampState,
        budget,
        nowMs,
      });
    }
  }
  return { status: "ok" };
}

function equalSecret(secret: string | null, provided: string | null): boolean {
  if (secret === null || provided === null) return false;
  const encoder = new TextEncoder();
  const expected = encoder.encode(secret);
  const actual = encoder.encode(provided);
  if (
    expected.byteLength < 32 || expected.byteLength > MAX_SECRET_BYTES
    || actual.byteLength !== expected.byteLength
  ) return false;
  let difference = 0;
  for (let index = 0; index < expected.byteLength; index++) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
    },
  });
}

/** The endpoint is invoked by future Vault-backed schedules; no schedule is made here. */
export function createRealtimeMonitorHandler(
  dependencies: MonitorEndpointDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!equalSecret(dependencies.secret, request.headers.get(SECRET_HEADER))) {
      return response({ error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);

    const task = new URL(request.url).searchParams.get("task");
    if (task !== null && task !== "cleanup") return response({ error: "invalid_task" }, 400);
    if (task === null) {
      let enabled = false;
      try {
        enabled = dependencies.routingEnabled();
      } catch {
        return response({ error: "unavailable" }, 503);
      }
      if (!enabled) return response({ status: "feature_disabled" }, 200);
    }

    let rpc: MonitorRpc | null;
    try {
      rpc = await dependencies.createRpc();
    } catch {
      return response({ error: "unavailable" }, 503);
    }
    if (!rpc) return response({ error: "unavailable" }, 503);

    if (task === "cleanup") {
      try {
        const result = await rpc("realtime_room_assignment_cleanup", {});
        if (result.error || typeof result.data !== "number" || !Number.isSafeInteger(result.data)) {
          return response({ error: "unavailable" }, 503);
        }
        return response({ status: "cleanup_complete", removed: result.data }, 200);
      } catch {
        return response({ error: "unavailable" }, 503);
      }
    }

    try {
      const monitorDependencies = dependencies.createMonitorDependencies(rpc);
      const result = await runRealtimeMonitor(monitorDependencies);
      return response(result, result.status === "unavailable" ? 503 : 200);
    } catch {
      return response({ error: "unavailable" }, 503);
    }
  };
}
