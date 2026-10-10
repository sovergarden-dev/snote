import {
  advanceRamp,
  beginRecoveryRamp,
  evaluateHub2Budget,
  planHubAssignment,
  stableRoomBucket,
  stopRamp,
  type AssignmentHub,
  type BudgetDecision,
  type BudgetMetricsSnapshot,
  type HubBudgetThresholds,
  type HubHealthSnapshot,
  type HubId,
  type HubRoutingConfig,
  type RampRuntime,
} from "./realtime-hub-routing.ts";
import {
  deriveOpaqueRoomId,
  issueRealtimeHealthProbeToken,
  issueRealtimeTicketFromContext,
  verifyRealtimeTicketClaims,
  type RealtimeSigningConfig,
  type RealtimeTicket,
} from "../_shared/realtime-edge.ts";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const HUB_ID_RE = /^(rt1|rt2)$/u;

export type RealtimeHubRpcName =
  | "realtime_topology_read"
  | "realtime_hub_ramp_state_read"
  | "realtime_hub_ramp_state_cas"
  | "realtime_hub_health_read"
  | "realtime_hub_probe_claim"
  | "realtime_hub_probe_complete"
  | "realtime_room_assignment_read"
  | "realtime_room_assignment_apply"
  | "capability_note_realtime_ticket_context";

export interface RealtimeHubRpcReply {
  data: unknown;
  error: unknown;
}

export type RealtimeHubRpc = (
  name: RealtimeHubRpcName,
  args: Record<string, unknown>,
) => Promise<RealtimeHubRpcReply>;

export interface HubBudgetMetricsProvider {
  readSnapshot(input: { nowMs: number }): Promise<BudgetMetricsSnapshot>;
}

export const unavailableHubBudgetMetricsProvider: HubBudgetMetricsProvider = {
  async readSnapshot() {
    return { status: "unavailable", metrics: {} };
  },
};

export interface RealtimeHubEdgeDependencies {
  rpc: RealtimeHubRpc;
  metricsProvider?: HubBudgetMetricsProvider;
  now?: () => number;
  healthUrl?: (hubId: HubId) => string | null;
  fetcher?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface RoutedTicketSuccess {
  ok: true;
  ticket: RealtimeTicket;
  assignment: { hubId: HubId; assignmentEpoch: number; topologyEpoch: number; bucket: number };
}

export interface RoutedTicketFailure {
  ok: false;
  status: string;
  syncTransport?: "slow_sync";
  hubId?: AssignmentHub;
  assignmentEpoch?: number;
  topologyEpoch?: number;
}

export type RoutedTicketResult = RoutedTicketSuccess | RoutedTicketFailure;

export interface RealtimeHubReportResult {
  status: string;
  hubId?: string;
  probeSucceeded?: boolean;
  assignmentEpoch?: number;
  topologyEpoch?: number;
  ticket?: RealtimeTicket;
  reason?: string;
}

interface HubProbeConfig {
  timeout_ms: number;
  retry_count: number;
  retry_delay_ms: number;
  down_ttl_seconds: number;
  probe_cache_ttl_seconds: number;
  probe_on_report: boolean;
  probe_before_assign: boolean;
}

interface HubConfig {
  weight_bp: number;
  enabled: boolean;
  drain: boolean;
  probe: HubProbeConfig;
  budget_profile: string | null;
  budget_thresholds: unknown;
  unit_prices: unknown;
  billing_cycle_started_at: string | null;
  max_active_rooms: number | null;
  staging_headroom_verified?: boolean;
}

type HubMap = Record<HubId, HubConfig>;

interface TopologySnapshot {
  status: "ok";
  version: number;
  assignmentEpoch: number;
  minFallbackBp: number;
  hubConfig: HubMap;
  ramp: Record<string, unknown>;
  hub2NewRoomAdmissionReady: boolean;
}

interface AssignmentSnapshot {
  status: "unassigned" | "ok";
  bucket?: number;
  hubId?: AssignmentHub;
  assignmentEpoch?: number;
  topologyEpoch?: number;
}

interface ParsedHealth extends HubHealthSnapshot {
  status: "ok";
}

interface RampStateSnapshot {
  stateVersion: number;
  topologyVersion: number;
  assignmentEpoch: number;
  runtime: unknown;
}

interface LoadedRampState {
  snapshot: RampStateSnapshot;
  runtime: RampRuntime | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSafeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function rpcStatus(value: unknown): string {
  return isRecord(value) && typeof value.status === "string" ? value.status : "unavailable";
}

function parseHub(value: unknown): HubConfig | null {
  if (!isRecord(value) || !isRecord(value.probe)) return null;
  const weight = asSafeInteger(value.weight_bp);
  const maxActiveRooms = value.max_active_rooms === null ? null : asSafeInteger(value.max_active_rooms, 1);
  const probe = value.probe;
  const timeout = asSafeInteger(probe.timeout_ms, 1);
  const retryCount = asSafeInteger(probe.retry_count);
  const retryDelay = asSafeInteger(probe.retry_delay_ms);
  const downTtl = asSafeInteger(probe.down_ttl_seconds);
  const cacheTtl = asSafeInteger(probe.probe_cache_ttl_seconds);
  if (
    weight === null || typeof value.enabled !== "boolean" || typeof value.drain !== "boolean"
    || (value.max_active_rooms !== null && maxActiveRooms === null)
    || timeout !== 2_000 || retryCount !== 1 || retryDelay !== 1_000 || downTtl !== 60
    || (cacheTtl !== 10 && cacheTtl !== 60)
    || typeof probe.probe_on_report !== "boolean"
    || typeof probe.probe_before_assign !== "boolean"
    || (value.budget_profile !== null && typeof value.budget_profile !== "string")
    || (value.billing_cycle_started_at !== null && typeof value.billing_cycle_started_at !== "string")
  ) return null;
  return {
    weight_bp: weight,
    enabled: value.enabled,
    drain: value.drain,
    probe: {
      timeout_ms: timeout,
      retry_count: retryCount,
      retry_delay_ms: retryDelay,
      down_ttl_seconds: downTtl,
      probe_cache_ttl_seconds: cacheTtl,
      probe_on_report: probe.probe_on_report,
      probe_before_assign: probe.probe_before_assign,
    },
    budget_profile: value.budget_profile as string | null,
    budget_thresholds: value.budget_thresholds,
    unit_prices: value.unit_prices,
    billing_cycle_started_at: value.billing_cycle_started_at as string | null,
    max_active_rooms: maxActiveRooms,
    ...(value.staging_headroom_verified === true ? { staging_headroom_verified: true } : {}),
  };
}

function parseTopology(value: unknown): TopologySnapshot | null {
  if (!isRecord(value) || value.status !== "ok" || !isRecord(value.hubConfig) || !isRecord(value.ramp)) {
    return null;
  }
  const version = asSafeInteger(value.version, 1);
  const assignmentEpoch = asSafeInteger(value.assignmentEpoch, 1);
  const minFallbackBp = asSafeInteger(value.minFallbackBp, 100);
  const rt1 = parseHub(value.hubConfig.rt1);
  const rt2 = parseHub(value.hubConfig.rt2);
  if (
    version === null || assignmentEpoch === null || minFallbackBp === null
    || minFallbackBp > 1_000 || !rt1 || !rt2
    || typeof value.hub2NewRoomAdmissionReady !== "boolean"
  ) return null;
  return {
    status: "ok",
    version,
    assignmentEpoch,
    minFallbackBp,
    hubConfig: { rt1, rt2 },
    ramp: value.ramp,
    hub2NewRoomAdmissionReady: value.hub2NewRoomAdmissionReady,
  };
}

function parseAssignment(value: unknown): AssignmentSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.status === "unassigned") return { status: "unassigned" };
  if (value.status !== "ok") return null;
  const bucket = asSafeInteger(value.bucket);
  const assignmentEpoch = asSafeInteger(value.assignmentEpoch, 1);
  const topologyEpoch = asSafeInteger(value.topologyEpoch, 1);
  if (
    bucket === null || bucket > 9_999 || assignmentEpoch === null || topologyEpoch === null
    || (value.hubId !== "rt1" && value.hubId !== "rt2" && value.hubId !== "slow")
  ) return null;
  return {
    status: "ok",
    bucket,
    assignmentEpoch,
    topologyEpoch,
    hubId: value.hubId,
  };
}

function parseHealth(value: unknown): ParsedHealth | null {
  if (!isRecord(value) || value.status !== "ok") return null;
  const healthStatus = value.healthStatus;
  if (healthStatus !== "healthy" && healthStatus !== "down" && healthStatus !== "unknown") return null;
  const checkedAt = value.checkedAt === null ? null : typeof value.checkedAt === "string"
    ? Date.parse(value.checkedAt)
    : typeof value.checkedAt === "number" ? value.checkedAt : Number.NaN;
  const downUntil = value.downUntil === null ? null : typeof value.downUntil === "string"
    ? Date.parse(value.downUntil)
    : typeof value.downUntil === "number" ? value.downUntil : Number.NaN;
  const failures = asSafeInteger(value.consecutiveFailures);
  if (
    (checkedAt !== null && !Number.isFinite(checkedAt))
    || (downUntil !== null && !Number.isFinite(downUntil))
    || failures === null
  ) return null;
  return { status: "ok", healthStatus, checkedAt, downUntil, consecutiveFailures: failures };
}

function parseBudgetThresholds(value: unknown): HubBudgetThresholds | null {
  if (!isRecord(value)) return null;
  const names = ["worker_requests", "do_billed_requests", "do_gb_s", "do_sqlite_rows_written"] as const;
  const parsed: Partial<HubBudgetThresholds> = {};
  for (const name of names) {
    const entry = value[name];
    if (!isRecord(entry)) return null;
    const warning = asSafeInteger(entry.warning, 1);
    const hardStop = asSafeInteger(entry.hard_stop ?? entry.hardStop, 1);
    if (warning === null || hardStop === null) return null;
    parsed[name] = { warning, hardStop };
  }
  return parsed as HubBudgetThresholds;
}

function parseRampRuntime(value: unknown): RampRuntime | null {
  if (!isRecord(value) || value.active !== true || (value.recovering_hub_id !== "rt1" && value.recovering_hub_id !== "rt2")) {
    return null;
  }
  const currentWeightBp = asSafeInteger(value.current_bp, 1);
  const targetWeightBp = asSafeInteger(value.target_bp, 1);
  const lastStepAtMs = asSafeInteger(value.last_step_at_ms);
  const startedAtMs = asSafeInteger(value.started_at_ms);
  if (
    currentWeightBp === null || targetWeightBp === null || lastStepAtMs === null || startedAtMs === null
    || currentWeightBp > 10_000 || targetWeightBp > 10_000
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

function serializeRampRuntime(runtime: RampRuntime): Record<string, unknown> {
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

function routerConfig(topology: TopologySnapshot): HubRoutingConfig {
  return {
    rt1: {
      weightBp: topology.hubConfig.rt1.weight_bp,
      enabled: topology.hubConfig.rt1.enabled,
      drain: topology.hubConfig.rt1.drain,
      probeBeforeAssign: topology.hubConfig.rt1.probe.probe_before_assign,
      maxActiveRooms: topology.hubConfig.rt1.max_active_rooms,
    },
    rt2: {
      weightBp: topology.hubConfig.rt2.weight_bp,
      enabled: topology.hubConfig.rt2.enabled,
      drain: topology.hubConfig.rt2.drain,
      probeBeforeAssign: topology.hubConfig.rt2.probe.probe_before_assign,
      maxActiveRooms: topology.hubConfig.rt2.max_active_rooms,
    },
  };
}

async function roomKeyHash(roomId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(roomId)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readTopology(dependencies: RealtimeHubEdgeDependencies): Promise<TopologySnapshot | null> {
  const reply = await dependencies.rpc("realtime_topology_read", {});
  return reply.error ? null : parseTopology(reply.data);
}

function parseRampState(value: unknown): RampStateSnapshot | null {
  if (
    !isRecord(value) || (value.status !== "ok" && value.status !== "updated")
    || !isRecord(value.runtime)
  ) return null;
  const stateVersion = asSafeInteger(value.stateVersion, 1);
  const topologyVersion = asSafeInteger(value.topologyVersion, 1);
  const assignmentEpoch = asSafeInteger(value.assignmentEpoch, 1);
  if (stateVersion === null || topologyVersion === null || assignmentEpoch === null) return null;
  return { stateVersion, topologyVersion, assignmentEpoch, runtime: value.runtime };
}

async function readRampState(
  dependencies: RealtimeHubEdgeDependencies,
): Promise<RampStateSnapshot | null> {
  const reply = await dependencies.rpc("realtime_hub_ramp_state_read", {});
  return reply.error ? null : parseRampState(reply.data);
}

async function readHealth(
  dependencies: RealtimeHubEdgeDependencies,
  hubId: HubId,
  topologyEpoch: number,
): Promise<ParsedHealth | null> {
  const reply = await dependencies.rpc("realtime_hub_health_read", {
    p_hub_id: hubId,
    p_assignment_epoch: topologyEpoch,
  });
  return reply.error ? null : parseHealth(reply.data);
}

async function readMetrics(
  dependencies: RealtimeHubEdgeDependencies,
  nowMs: number,
): Promise<BudgetMetricsSnapshot> {
  try {
    return await (dependencies.metricsProvider ?? unavailableHubBudgetMetricsProvider).readSnapshot({ nowMs });
  } catch {
    return { status: "error", metrics: {} };
  }
}

function evaluateBudget(
  topology: TopologySnapshot,
  metrics: BudgetMetricsSnapshot,
  nowMs: number,
): BudgetDecision {
  const thresholds = parseBudgetThresholds(topology.hubConfig.rt2.budget_thresholds);
  if (!thresholds) return { status: "stale", reason: "thresholds_invalid" };
  return evaluateHub2Budget(
    metrics,
    thresholds,
    nowMs,
    topology.hubConfig.rt2.staging_headroom_verified === true,
  );
}

async function readAssignment(
  dependencies: RealtimeHubEdgeDependencies,
  keyHash: string,
): Promise<AssignmentSnapshot | null> {
  const reply = await dependencies.rpc("realtime_room_assignment_read", { p_room_key_hash: keyHash });
  return reply.error ? null : parseAssignment(reply.data);
}

function makeAssignmentDecision(input: {
  topology: TopologySnapshot;
  assignment: AssignmentSnapshot;
  rampRuntime: RampRuntime | null;
  bucket: number;
  health: Record<HubId, ParsedHealth>;
  metrics: BudgetMetricsSnapshot;
  budget: BudgetDecision;
  nowMs: number;
  destinationWasJustProbedHealthy?: boolean;
}): ReturnType<typeof planHubAssignment> {
  const topology = input.topology;
  const hubs = routerConfig(topology);
  const availability = {
    rt1: {
      available: hubs.rt1.enabled && !hubs.rt1.drain && input.health.rt1.healthStatus !== "down",
      probeBeforeAssign: hubs.rt1.probeBeforeAssign,
    },
    rt2: {
      available: hubs.rt2.enabled && !hubs.rt2.drain && input.health.rt2.healthStatus !== "down",
      probeBeforeAssign: hubs.rt2.probeBeforeAssign,
    },
  };
  return planHubAssignment({
    bucket: input.bucket,
    currentHub: input.assignment.status === "ok" ? input.assignment.hubId : null,
    hubs,
    availability,
    health: input.health,
    budgetStatus: input.budget.status,
    budgetReadiness: topology.hub2NewRoomAdmissionReady,
    nowMs: input.nowMs,
    destinationWasJustProbedHealthy: input.destinationWasJustProbedHealthy,
    rampRuntime: input.rampRuntime,
    metrics: input.metrics,
  });
}

export async function issueRoutedRealtimeTicketFromContext(
  context: unknown,
  sessionId: string,
  signing: RealtimeSigningConfig,
  dependencies: RealtimeHubEdgeDependencies,
): Promise<RoutedTicketResult> {
  if (!isRecord(context) || context.status !== "ok" || typeof context.noteId !== "string") {
    return { ok: false, status: "invalid" };
  }
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, status: "invalid" };
  const nowMs = dependencies.now?.() ?? Date.now();
  const topology = await readTopology(dependencies);
  if (!topology) return { ok: false, status: "unavailable" };
  const rampState = await loadRampState(dependencies, topology, nowMs);
  if (!rampState) return { ok: false, status: "unavailable", syncTransport: "slow_sync" };

  let roomId: string;
  try {
    const generation = asSafeInteger(context.generation, 1);
    if (generation === null) return { ok: false, status: "invalid" };
    roomId = await deriveOpaqueRoomId(signing.roomHmacKey, context.noteId, generation);
  } catch {
    return { ok: false, status: "unavailable" };
  }
  const bucket = await stableRoomBucket(roomId);
  const keyHash = await roomKeyHash(roomId);
  const [assignment, rt1Health, rt2Health, metrics] = await Promise.all([
    readAssignment(dependencies, keyHash),
    readHealth(dependencies, "rt1", topology.assignmentEpoch),
    readHealth(dependencies, "rt2", topology.assignmentEpoch),
    readMetrics(dependencies, nowMs),
  ]);
  if (!assignment || !rt1Health || !rt2Health) return { ok: false, status: "unavailable" };
  if (assignment.status === "ok" && assignment.bucket !== bucket) {
    return { ok: false, status: "assignment_conflict" };
  }
  const health = { rt1: rt1Health, rt2: rt2Health };
  const budget = evaluateBudget(topology, metrics, nowMs);
  const decision = makeAssignmentDecision({
    topology,
    assignment,
    rampRuntime: rampState.runtime,
    bucket,
    health,
    metrics,
    budget,
    nowMs,
  });
  const applyReply = await dependencies.rpc("realtime_room_assignment_apply", {
    p_room_key_hash: keyHash,
    p_bucket: bucket,
    p_target_hub_id: decision.hubId,
    p_topology_epoch: topology.assignmentEpoch,
    p_expected_assignment_epoch: assignment.status === "ok" ? assignment.assignmentEpoch : null,
  });
  if (applyReply.error || !isRecord(applyReply.data)) return { ok: false, status: "unavailable" };
  const appliedStatus = rpcStatus(applyReply.data);
  const applied = ["assigned", "changed", "unchanged"].includes(appliedStatus)
    ? parseAssignment({ ...applyReply.data, status: "ok" })
    : null;
  if (
    !applied || applied.status !== "ok" || !applied.hubId
    || applied.assignmentEpoch === undefined || applied.topologyEpoch !== topology.assignmentEpoch
  ) {
    const status = rpcStatus(applyReply.data);
    const nextEpoch = asSafeInteger((applyReply.data as Record<string, unknown>).assignmentEpoch, 1) ?? undefined;
    if (status === "stale_topology" || status === "assignment_conflict" || status === "bucket_conflict") {
      return { ok: false, status, syncTransport: "slow_sync", topologyEpoch: topology.assignmentEpoch, assignmentEpoch: nextEpoch };
    }
    return { ok: false, status: status === "hub_not_ready" || status === "hub_unavailable" ? "slow_sync" : status };
  }
  if (applied.hubId === "slow") {
    return {
      ok: false,
      status: "slow_sync",
      syncTransport: "slow_sync",
      hubId: "slow",
      assignmentEpoch: applied.assignmentEpoch,
      topologyEpoch: applied.topologyEpoch,
    };
  }
  if (!HUB_ID_RE.test(applied.hubId)) return { ok: false, status: "unavailable" };
  const issued = await issueRealtimeTicketFromContext(
    { ...context, sessionId },
    signing,
    undefined,
    {
      hubId: applied.hubId,
      assignmentEpoch: applied.assignmentEpoch,
      topologyEpoch: applied.topologyEpoch,
    },
  );
  if (issued.ok === false) return { ok: false, status: issued.status };
  return {
    ok: true,
    ticket: issued.ticket,
    assignment: {
      hubId: applied.hubId,
      assignmentEpoch: applied.assignmentEpoch,
      topologyEpoch: applied.topologyEpoch,
      bucket,
    },
  };
}

function validProbeUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      && url.search === "" && url.hash === "" && url.pathname === "/healthz";
  } catch {
    return false;
  }
}

export async function runHubHealthProbeRound(input: {
  hubId: HubId;
  url: string;
  config: RealtimeSigningConfig;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  nowMs: number;
  fetcher?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<boolean> {
  if (
    !validProbeUrl(input.url) || input.timeoutMs !== 2_000 || input.retryCount !== 1
    || input.retryDelayMs !== 1_000 || !Number.isFinite(input.nowMs) || input.nowMs < 0
  ) return false;
  const token = await issueRealtimeHealthProbeToken(
    input.hubId,
    input.config,
    Math.floor(input.nowMs / 1_000),
  );
  const fetcher = input.fetcher ?? fetch;
  const sleep = input.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 0; attempt <= input.retryCount; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let succeeded = false;
    try {
      const response = await fetcher(input.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      succeeded = response.status >= 200 && response.status < 300;
    } catch {
      succeeded = false;
    } finally {
      clearTimeout(timeout);
    }
    if (succeeded) return true;
    if (attempt < input.retryCount) await sleep(input.retryDelayMs);
  }
  return false;
}

async function persistRamp(
  dependencies: RealtimeHubEdgeDependencies,
  topology: TopologySnapshot,
  snapshot: RampStateSnapshot,
  runtime: RampRuntime,
): Promise<RampStateSnapshot | null> {
  const serialized = serializeRampRuntime(runtime);
  const reply = await dependencies.rpc("realtime_hub_ramp_state_cas", {
    p_expected_state_version: snapshot.stateVersion,
    p_expected_topology_version: topology.version,
    p_expected_assignment_epoch: topology.assignmentEpoch,
    p_runtime: serialized,
  });
  if (reply.error || rpcStatus(reply.data) !== "updated") return null;
  const updated = parseRampState(reply.data);
  if (
    !updated || updated.stateVersion <= snapshot.stateVersion
    || updated.topologyVersion !== topology.version
    || updated.assignmentEpoch !== topology.assignmentEpoch
  ) return null;
  return updated;
}

async function loadRampState(
  dependencies: RealtimeHubEdgeDependencies,
  topology: TopologySnapshot,
  nowMs: number,
): Promise<LoadedRampState | null> {
  const snapshot = await readRampState(dependencies);
  if (!snapshot) return null;
  const runtime = parseRampRuntime(snapshot.runtime);
  const configMatches = snapshot.topologyVersion === topology.version
    && snapshot.assignmentEpoch === topology.assignmentEpoch;
  if (configMatches) return { snapshot, runtime };
  if (!runtime?.active) return { snapshot, runtime: null };

  const stopped = stopRamp(runtime, nowMs, "configuration_changed");
  const updated = await persistRamp(dependencies, topology, snapshot, stopped);
  return updated ? { snapshot: updated, runtime: null } : null;
}

async function updateRecoveryRampAfterProbe(input: {
  hubId: HubId;
  probeSucceeded: boolean;
  previousHealth: Record<HubId, ParsedHealth>;
  topology: TopologySnapshot;
  dependencies: RealtimeHubEdgeDependencies;
  nowMs: number;
}): Promise<void> {
  const loaded = await loadRampState(input.dependencies, input.topology, input.nowMs);
  if (!loaded) return;
  const current = loaded.runtime;
  const metrics = await readMetrics(input.dependencies, input.nowMs);
  const budget = evaluateBudget(input.topology, metrics, input.nowMs);
  let next = current;
  if (!input.probeSucceeded && current?.active && current.recoveringHubId === input.hubId) {
    next = stopRamp(current, input.nowMs, "probe_failed");
  } else if (
    input.probeSucceeded && current?.active && current.recoveringHubId === input.hubId
  ) {
    next = advanceRamp(
      current,
      input.nowMs,
      asSafeInteger(input.topology.ramp.step_bp, 1) ?? 1_000,
      asSafeInteger(input.topology.ramp.interval_seconds, 1) ?? 300,
      budget.status,
    );
    if (budget.status === "blocked") {
      next = stopRamp(current, input.nowMs, "budget_blocked");
    }
  } else if (
    input.probeSucceeded
    && !current?.active
    && (input.previousHealth[input.hubId].healthStatus === "down"
      || input.previousHealth[input.hubId].consecutiveFailures > 0)
  ) {
    const other: HubId = input.hubId === "rt1" ? "rt2" : "rt1";
    const otherAvailable = input.topology.hubConfig[other].enabled
      && !input.topology.hubConfig[other].drain
      && input.previousHealth[other].healthStatus !== "down";
    const configuredTargetBp = input.topology.hubConfig[input.hubId].weight_bp;
    if (
      configuredTargetBp > 0 && otherAvailable && budget.status === "ok"
      && input.topology.hub2NewRoomAdmissionReady
    ) {
      next = beginRecoveryRamp(input.hubId, configuredTargetBp, input.nowMs, {
        canaryBp: asSafeInteger(input.topology.ramp.canary_bp, 1) ?? 500,
        stepBp: asSafeInteger(input.topology.ramp.step_bp, 1) ?? 1_000,
        intervalSeconds: asSafeInteger(input.topology.ramp.interval_seconds, 1) ?? 300,
      });
    }
  }
  if (!next || next === current) return;
  await persistRamp(input.dependencies, input.topology, loaded.snapshot, next);
}

export async function handleRealtimeHubReport(
  bodyValue: unknown,
  contextValue: unknown,
  signing: RealtimeSigningConfig,
  dependencies: RealtimeHubEdgeDependencies,
): Promise<RealtimeHubReportResult> {
  if (!isRecord(bodyValue) || bodyValue.report !== "hub_unreachable") return { status: "invalid_report" };
  const ticket = typeof bodyValue.ticket === "string" ? bodyValue.ticket : "";
  const sessionId = typeof bodyValue.session_id === "string" ? bodyValue.session_id : "";
  if (!ticket || !SESSION_ID_RE.test(sessionId) || !isRecord(contextValue) || contextValue.status !== "ok") {
    return { status: "invalid" };
  }
  const nowMs = dependencies.now?.() ?? Date.now();
  const verification = await verifyRealtimeTicketClaims(ticket, signing, Math.floor(nowMs / 1_000));
  if (verification.ok === false) return { status: verification.status };
  const claims = verification.claims;
  if (
    claims.session_id !== sessionId
    || typeof contextValue.sessionId !== "string"
    || contextValue.sessionId !== sessionId
    || typeof contextValue.noteId !== "string"
    || asSafeInteger(contextValue.generation, 1) !== claims.generation
    || asSafeInteger(contextValue.permissionEpoch) !== claims.permission_epoch
    || claims.assignment_epoch < 1
  ) return { status: "session_or_ticket_mismatch" };

  let roomId: string;
  try {
    roomId = await deriveOpaqueRoomId(signing.roomHmacKey, contextValue.noteId, claims.generation);
  } catch {
    return { status: "invalid" };
  }
  if (roomId !== claims.room_id || !HUB_ID_RE.test(claims.hub_id)) return { status: "invalid" };
  const bucket = await stableRoomBucket(roomId);
  const keyHash = await roomKeyHash(roomId);
  const topology = await readTopology(dependencies);
  if (!topology) return { status: "unavailable" };

  const [assignment, rt1Health, rt2Health] = await Promise.all([
    readAssignment(dependencies, keyHash),
    readHealth(dependencies, "rt1", topology.assignmentEpoch),
    readHealth(dependencies, "rt2", topology.assignmentEpoch),
  ]);
  if (!assignment || !rt1Health || !rt2Health) return { status: "unavailable" };
  if (
    assignment.status !== "ok"
    || assignment.bucket !== bucket
    || assignment.hubId !== claims.hub_id
    || assignment.assignmentEpoch !== claims.assignment_epoch
  ) return { status: "stale_epoch" };
  const hubId = claims.hub_id as HubId;
  const probeConfig = topology.hubConfig[hubId].probe;
  if (!probeConfig.probe_on_report) return { status: "probe_disabled" };
  const healthUrl = dependencies.healthUrl?.(hubId) ?? null;
  if (!validProbeUrl(healthUrl)) return { status: "probe_unavailable" };

  const previousHealth = { rt1: rt1Health, rt2: rt2Health };
  // No claim/lease is created until the signed ticket, session, lifetime,
  // report type, current room assignment, and room-local epoch all match.
  const claimReply = await dependencies.rpc("realtime_hub_probe_claim", {
    p_hub_id: hubId,
    p_assignment_epoch: topology.assignmentEpoch,
  });
  if (claimReply.error || !isRecord(claimReply.data)) return { status: "unavailable" };
  const claimStatus = rpcStatus(claimReply.data);
  if (claimStatus !== "probe_started") {
    return { status: claimStatus, hubId, topologyEpoch: topology.assignmentEpoch };
  }
  const leaseId = isRecord(claimReply.data) && typeof claimReply.data.leaseId === "string"
    ? claimReply.data.leaseId
    : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(leaseId)) {
    return { status: "unavailable" };
  }

  let probeSucceeded = false;
  try {
    probeSucceeded = await runHubHealthProbeRound({
      hubId,
      url: healthUrl,
      config: signing,
      timeoutMs: probeConfig.timeout_ms,
      retryCount: probeConfig.retry_count,
      retryDelayMs: probeConfig.retry_delay_ms,
      nowMs,
      fetcher: dependencies.fetcher,
      sleep: dependencies.sleep,
    });
  } catch {
    probeSucceeded = false;
  }
  // Exactly one aggregated completion per claimed round; the retry lives above.
  const completeReply = await dependencies.rpc("realtime_hub_probe_complete", {
    p_hub_id: hubId,
    p_assignment_epoch: topology.assignmentEpoch,
    p_lease_id: leaseId,
    p_probe_succeeded: probeSucceeded,
  });
  if (completeReply.error || rpcStatus(completeReply.data) !== "accepted") {
    return { status: completeReply.error ? "unavailable" : rpcStatus(completeReply.data), hubId };
  }

  await updateRecoveryRampAfterProbe({
    hubId,
    probeSucceeded,
    previousHealth,
    topology,
    dependencies,
    nowMs,
  });
  const routed = await issueRoutedRealtimeTicketFromContext(
    contextValue,
    sessionId,
    signing,
    dependencies,
  );
  if (routed.ok === false) {
    return {
      status: routed.status === "slow_sync" ? "slow_sync" : routed.status,
      hubId,
      probeSucceeded,
      topologyEpoch: topology.assignmentEpoch,
      reason: routed.status,
    };
  }
  const moved = routed.assignment.hubId !== hubId || routed.assignment.assignmentEpoch !== claims.assignment_epoch;
  return {
    status: moved ? "hub-change" : "ok",
    hubId: routed.assignment.hubId,
    probeSucceeded,
    assignmentEpoch: routed.assignment.assignmentEpoch,
    topologyEpoch: routed.assignment.topologyEpoch,
    ticket: routed.ticket,
  };
}
