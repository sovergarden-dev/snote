// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../../src/lib/realtime/protocol";
import {
  loadRealtimeSigningConfig,
  type RealtimeSigningConfig,
} from "../../supabase/functions/_shared/realtime-edge";
import {
  accountRt2HealthProbeRequests,
  createRealtimeMonitorHandler,
  runRealtimeMonitor,
  type MonitorRpc,
  type MonitorRpcName,
  type RealtimeMonitorDependencies,
} from "../../supabase/functions/realtime-monitor/monitor";
import type { BudgetMetricsSnapshot, HubId } from "../../supabase/functions/note-session/realtime-hub-routing";

const BASE_NOW = 1_800_000_000_000;
const SECRET = "m".repeat(48);
const LEASE_ID = "12345678-1234-4234-8234-123456789abc";

async function makeSigning(): Promise<RealtimeSigningConfig> {
  const [ticketPair, ackPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  ]);
  const [ticketJwk, ackJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", ticketPair.privateKey),
    crypto.subtle.exportKey("jwk", ackPair.privateKey),
  ]);
  return loadRealtimeSigningConfig({
    ticketPrivateJwk: JSON.stringify(ticketJwk),
    ticketKid: "monitor-test-ticket-v1",
    savedAckPrivateJwk: JSON.stringify(ackJwk),
    savedAckKid: "monitor-test-ack-v1",
    hubId: "legacy-hub",
    assignmentEpoch: "1",
    roomHmacKey: encodeBase64Url(new Uint8Array(32).fill(11)),
    writeMacMasterKey: encodeBase64Url(new Uint8Array(32).fill(23)),
    relayMasterKey: encodeBase64Url(new Uint8Array(32).fill(37)),
    relayKeyKid: "monitor-test-relay-v1",
  });
}

const thresholds = {
  worker_requests: { warning: 1_000, hard_stop: 1_000 },
  do_billed_requests: { warning: 1_000, hard_stop: 1_000 },
  do_gb_s: { warning: 1_000, hard_stop: 1_000 },
  do_sqlite_rows_written: { warning: 1_000, hard_stop: 1_000 },
};

function hub(enabled: boolean, weightBp: number, cacheTtlSeconds: 10 | 60) {
  return {
    weight_bp: weightBp,
    enabled,
    drain: false,
    probe: {
      timeout_ms: 2_000,
      retry_count: 1,
      retry_delay_ms: 1_000,
      down_ttl_seconds: 60,
      probe_cache_ttl_seconds: cacheTtlSeconds,
      probe_on_report: true,
      probe_before_assign: true,
    },
    budget_thresholds: thresholds,
    staging_headroom_verified: true,
  };
}

function metrics(nowMs: number, workerUsed = 1, doUsed = 1): BudgetMetricsSnapshot {
  const sample = (used: number) => ({ used, observedThrough: nowMs });
  return {
    status: "ok",
    metrics: {
      worker_requests: sample(workerUsed),
      do_billed_requests: sample(doUsed),
      do_gb_s: sample(1),
      do_sqlite_rows_written: sample(1),
    },
  };
}

function makeFakeMonitor(options: {
  nowMs?: number;
  ready?: boolean;
  rt1Enabled?: boolean;
  rt2Enabled?: boolean;
  rt1Health?: "healthy" | "down" | "unknown";
  rt2Health?: "healthy" | "down" | "unknown";
  rt1Weight?: number;
  rt2Weight?: number;
  runtime?: Record<string, unknown>;
  metricsSnapshot?: (nowMs: number) => BudgetMetricsSnapshot;
  probeResult?: (hubId: HubId, attempt: number) => Response;
  signing: RealtimeSigningConfig;
}) {
  let nowMs = options.nowMs ?? BASE_NOW;
  const calls: Array<{ name: MonitorRpcName; args: Record<string, unknown> }> = [];
  const fetchCalls: string[] = [];
  const health: Record<HubId, {
    healthStatus: "healthy" | "down" | "unknown";
    checkedAt: number | null;
    downUntil: number | null;
    consecutiveFailures: number;
    probeLeaseActive: boolean;
  }> = {
    rt1: {
      healthStatus: options.rt1Health ?? "unknown",
      checkedAt: options.rt1Health === "healthy" ? nowMs : null,
      downUntil: options.rt1Health === "down" ? nowMs - 1 : null,
      consecutiveFailures: options.rt1Health === "down" ? 1 : 0,
      probeLeaseActive: false,
    },
    rt2: {
      healthStatus: options.rt2Health ?? "healthy",
      checkedAt: options.rt2Health === "unknown" ? null : nowMs,
      downUntil: options.rt2Health === "down" ? nowMs - 1 : null,
      consecutiveFailures: options.rt2Health === "down" ? 1 : 0,
      probeLeaseActive: false,
    },
  };
  const topology = {
    ready: options.ready ?? true,
    version: 2,
    assignmentEpoch: 2,
    hubConfig: {
      rt1: hub(options.rt1Enabled ?? true, options.rt1Weight ?? 5_000, 10),
      rt2: hub(options.rt2Enabled ?? true, options.rt2Weight ?? 5_000, 60),
    },
    ramp: { canary_bp: 500, step_bp: 1_000, interval_seconds: 300 },
    hub2NewRoomAdmissionReady: true,
  };
  let rampState = {
    stateVersion: 1,
    topologyVersion: topology.version,
    assignmentEpoch: topology.assignmentEpoch,
    runtime: options.runtime ?? { active: false },
  };
  let lease: { hubId: HubId; id: string; until: number } | null = null;
  let probeAttempt = 0;

  const rpc: MonitorRpc = vi.fn(async (name, args) => {
    calls.push({ name, args });
    if (name === "realtime_hub_monitor_snapshot") {
      const at = Date.parse(String(args.p_at));
      const healthSnapshot = Object.fromEntries(HUB_IDS.map((hubId) => {
        const current = health[hubId];
        const cacheTtl = topology.hubConfig[hubId].probe.probe_cache_ttl_seconds * 1_000;
        let healthStatus = current.healthStatus;
        if (healthStatus === "down" && current.downUntil !== null && current.downUntil <= at) {
          healthStatus = "unknown";
        }
        if (
          healthStatus === "healthy"
          && (current.checkedAt === null || current.checkedAt + cacheTtl <= at)
        ) healthStatus = "unknown";
        return [hubId, { status: "ok", ...current, healthStatus }];
      }));
      return {
        data: {
          status: topology.ready ? "ok" : "not_ready",
          ready: topology.ready,
          version: topology.version,
          assignmentEpoch: topology.assignmentEpoch,
          hubConfig: topology.hubConfig,
          ramp: topology.ramp,
          hub2NewRoomAdmissionReady: topology.hub2NewRoomAdmissionReady,
          health: healthSnapshot,
          rampState: { status: "ok", ...rampState },
        },
        error: null,
      };
    }
    if (name === "realtime_hub_probe_claim") {
      const hubId = args.p_hub_id as HubId;
      if (lease && lease.until > nowMs) {
        return { data: { status: "lease_held" }, error: null };
      }
      const config = topology.hubConfig[hubId];
      if (!config.enabled) return { data: { status: "probe_disabled" }, error: null };
      if (health[hubId].checkedAt !== null
        && nowMs - health[hubId].checkedAt! < config.probe.probe_cache_ttl_seconds * 1_000) {
        return { data: { status: "health_cached" }, error: null };
      }
      if (health[hubId].healthStatus === "down" && health[hubId].downUntil! > nowMs) {
        return { data: { status: "down_cached" }, error: null };
      }
      lease = { hubId, id: LEASE_ID, until: nowMs + 10_000 };
      health[hubId].probeLeaseActive = true;
      return { data: { status: "probe_started", leaseId: LEASE_ID, leaseSeconds: 10 }, error: null };
    }
    if (name === "realtime_hub_probe_complete") {
      const hubId = args.p_hub_id as HubId;
      if (!lease || lease.id !== args.p_lease_id || lease.until <= nowMs) {
        return { data: { status: "stale_lease" }, error: null };
      }
      const succeeded = args.p_probe_succeeded === true;
      health[hubId] = {
        healthStatus: succeeded ? "healthy" : "down",
        checkedAt: nowMs,
        downUntil: succeeded ? null : nowMs + 60_000,
        consecutiveFailures: succeeded ? 0 : health[hubId].consecutiveFailures + 1,
        probeLeaseActive: false,
      };
      lease = null;
      return { data: { status: "accepted" }, error: null };
    }
    if (name === "realtime_hub_ramp_state_cas") {
      if (args.p_expected_state_version !== rampState.stateVersion) {
        return { data: { status: "version_conflict" }, error: null };
      }
      rampState = {
        stateVersion: rampState.stateVersion + 1,
        topologyVersion: topology.version,
        assignmentEpoch: topology.assignmentEpoch,
        runtime: args.p_runtime as Record<string, unknown>,
      };
      return { data: { status: "updated", ...rampState }, error: null };
    }
    if (name === "realtime_room_assignment_cleanup") {
      return { data: 100, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });

  const dependencies: RealtimeMonitorDependencies = {
    routingEnabled: true,
    rpc,
    getSigning: async () => options.signing,
    metricsProvider: {
      readSnapshot: async ({ nowMs: metricsNow }) =>
        options.metricsSnapshot?.(metricsNow) ?? metrics(metricsNow),
    },
    healthUrl: (hubId) => `https://${hubId}.example.test/healthz`,
    now: () => nowMs,
    fetcher: async (input) => {
      const url = String(input);
      fetchCalls.push(url);
      probeAttempt++;
      return options.probeResult?.(url.includes("rt2") ? "rt2" : "rt1", probeAttempt)
        ?? new Response(null, { status: 200 });
    },
    sleep: async () => {},
  };
  return {
    dependencies,
    calls,
    fetchCalls,
    health,
    get rampState() { return rampState; },
    setNow(value: number) { nowMs = value; },
  };
}

const HUB_IDS: HubId[] = ["rt1", "rt2"];

describe("scheduled realtime monitor", () => {
  it("rejects requests when the server-side Edge secret is missing", async () => {
    const createRpc = vi.fn(async (): Promise<MonitorRpc | null> => null);
    const handler = createRealtimeMonitorHandler({
      secret: null,
      routingEnabled: () => true,
      createRpc,
      createMonitorDependencies: (rpc) => ({
        routingEnabled: true,
        rpc,
        getSigning: async () => null,
        healthUrl: () => null,
      }),
    });
    const response = await handler(new Request(
      "https://edge.test/functions/v1/realtime-monitor",
      { method: "POST", headers: { "x-snote-monitor-secret": SECRET } },
    ));
    expect(response.status).toBe(401);
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("leaves the production snapshot clock to Postgres; only injected fake clocks send p_at", async () => {
    const rpc: MonitorRpc = vi.fn(async () => ({
      data: { status: "not_ready", ready: false },
      error: null,
    }));
    const result = await runRealtimeMonitor({
      routingEnabled: true,
      rpc,
      getSigning: async () => null,
      healthUrl: () => null,
    });
    expect(result).toEqual({ status: "not_ready" });
    expect(rpc).toHaveBeenCalledWith("realtime_hub_monitor_snapshot", {});
  });

  it("rejects missing or wrong secret before creating an RPC client, and flag-off is a no-op", async () => {
    const createRpc = vi.fn(async (): Promise<MonitorRpc> => {
      throw new Error("must not create RPC client");
    });
    const handler = createRealtimeMonitorHandler({
      secret: SECRET,
      routingEnabled: () => false,
      createRpc,
      createMonitorDependencies: (rpc) => ({
        routingEnabled: false,
        rpc,
        getSigning: async () => null,
        healthUrl: () => null,
      }),
    });

    const missing = await handler(new Request("https://edge.test/functions/v1/realtime-monitor", {
      method: "POST",
    }));
    const wrong = await handler(new Request("https://edge.test/functions/v1/realtime-monitor", {
      method: "POST",
      headers: { "x-snote-monitor-secret": "x".repeat(48) },
    }));
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(createRpc).not.toHaveBeenCalled();

    const disabled = await handler(new Request("https://edge.test/functions/v1/realtime-monitor", {
      method: "POST",
      headers: { "x-snote-monitor-secret": SECRET },
    }));
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ status: "feature_disabled" });
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("does no probe or follow-up RPC when the topology snapshot is not ready", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({ ready: false, signing });
    const result = await runRealtimeMonitor(fake.dependencies);
    expect(result).toEqual({ status: "not_ready" });
    expect(fake.calls.map((call) => call.name)).toEqual(["realtime_hub_monitor_snapshot"]);
    expect(fake.fetchCalls).toHaveLength(0);
  });

  it("serializes overlapping monitor runs to one probe using the 10-second hub lease", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({ rt1Health: "unknown", rt2Health: "healthy", signing });
    const [first, second] = await Promise.all([
      runRealtimeMonitor(fake.dependencies),
      runRealtimeMonitor(fake.dependencies),
    ]);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(fake.fetchCalls).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "realtime_hub_probe_complete")).toHaveLength(1);
  });

  it("starts recovery at canary and advances only after interval_seconds", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({ rt1Health: "down", rt2Health: "healthy", signing });
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.rampState.runtime).toMatchObject({
      active: true,
      recovering_hub_id: "rt1",
      current_bp: 500,
      target_bp: 5_000,
    });

    fake.setNow(BASE_NOW + 299_999);
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.rampState.runtime).toMatchObject({ active: true, current_bp: 500 });

    fake.setNow(BASE_NOW + 300_000);
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.rampState.runtime).toMatchObject({ active: true, current_bp: 1_500 });
  });

  it("stops an active recovery ramp after a failed probe", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({
      rt1Health: "unknown",
      rt2Health: "healthy",
      runtime: {
        active: true,
        recovering_hub_id: "rt1",
        current_bp: 1_500,
        target_bp: 5_000,
        last_step_at_ms: BASE_NOW - 300_000,
        started_at_ms: BASE_NOW - 600_000,
      },
      probeResult: () => new Response(null, { status: 503 }),
      signing,
    });
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.fetchCalls).toHaveLength(2);
    expect(fake.rampState.runtime).toMatchObject({
      active: false,
      stopped_reason: "probe_failed",
    });
  });

  it("counts both possible rt2 health attempts in Worker and DO request budgets", async () => {
    const base = metrics(BASE_NOW, 7, 11);
    const charged = accountRt2HealthProbeRequests(base, 2);
    expect(charged.metrics.worker_requests?.used).toBe(9);
    expect(charged.metrics.do_billed_requests?.used).toBe(13);
    expect(charged.metrics.do_gb_s?.used).toBe(1);
    expect(charged.metrics.do_sqlite_rows_written?.used).toBe(1);
  });

  it("does not claim or call rt2 when its projected health request crosses the hard stop", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({
      rt1Health: "healthy",
      rt2Health: "unknown",
      metricsSnapshot: (nowMs) => metrics(nowMs, 999, 999),
      signing,
    });
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.calls.some((call) => call.name === "realtime_hub_probe_claim")).toBe(false);
    expect(fake.fetchCalls).toHaveLength(0);
  });

  it("runs cleanup through the same secret gate, leaving batching and 10-minute throttle to the existing RPC", async () => {
    const rpc = vi.fn(async (name: MonitorRpcName) => ({
      data: name === "realtime_room_assignment_cleanup" ? 100 : null,
      error: null,
    }));
    const handler = createRealtimeMonitorHandler({
      secret: SECRET,
      routingEnabled: () => false,
      createRpc: async () => rpc,
      createMonitorDependencies: (monitorRpc) => ({
        routingEnabled: false,
        rpc: monitorRpc,
        getSigning: async () => null,
        healthUrl: () => null,
      }),
    });
    const response = await handler(new Request(
      "https://edge.test/functions/v1/realtime-monitor?task=cleanup",
      { method: "POST", headers: { "x-snote-monitor-secret": SECRET } },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cleanup_complete", removed: 100 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("realtime_room_assignment_cleanup", {});
  });

  it("never probes a disabled hub even if its health is unknown", async () => {
    const signing = await makeSigning();
    const fake = makeFakeMonitor({
      rt1Health: "healthy",
      rt1Weight: 10_000,
      rt2Enabled: false,
      rt2Health: "unknown",
      rt2Weight: 0,
      signing,
    });
    expect((await runRealtimeMonitor(fake.dependencies)).status).toBe("ok");
    expect(fake.calls.some((call) => call.name === "realtime_hub_probe_claim")).toBe(false);
    expect(fake.fetchCalls).toHaveLength(0);
  });
});
