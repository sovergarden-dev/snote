// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../../src/lib/realtime/protocol";
import {
  deriveOpaqueRoomId,
  issueRealtimeTicket,
  loadRealtimeSigningConfig,
  type RealtimeSigningConfig,
} from "../../supabase/functions/_shared/realtime-edge";
import {
  handleRealtimeHubReport,
  runHubHealthProbeRound,
  type RealtimeHubEdgeDependencies,
  type RealtimeHubRpcName,
} from "../../supabase/functions/note-session/realtime-hub-edge";
import { stableRoomBucket } from "../../supabase/functions/note-session/realtime-hub-routing";

const NOW_SECONDS = 1_800_000_000;
const NOW_MS = NOW_SECONDS * 1_000;
const NOTE_ID = "f49c87a3-1bdf-4d1b-9d45-6e8c9cf2b21a";
const SESSION_ID = "session-edge-01";
const GENERATION = 4;
const PERMISSION_EPOCH = 7;
const ASSIGNMENT_EPOCH = 2;
const TOPOLOGY_EPOCH_AT_ISSUE = 3;
const CURRENT_TOPOLOGY_EPOCH = 4;
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
    ticketKid: "edge-routing-ticket-v1",
    savedAckPrivateJwk: JSON.stringify(ackJwk),
    savedAckKid: "edge-routing-ack-v1",
    hubId: "legacy-hub",
    assignmentEpoch: "1",
    roomHmacKey: encodeBase64Url(new Uint8Array(32).fill(11)),
    writeMacMasterKey: encodeBase64Url(new Uint8Array(32).fill(23)),
    relayMasterKey: encodeBase64Url(new Uint8Array(32).fill(37)),
    relayKeyKid: "edge-routing-relay-v1",
  });
}

function hub(enabled: boolean, weight: number, probeBeforeAssign: boolean) {
  return {
    weight_bp: weight,
    enabled,
    drain: false,
    probe: {
      timeout_ms: 2_000,
      retry_count: 1,
      retry_delay_ms: 1_000,
      down_ttl_seconds: 60,
      probe_cache_ttl_seconds: 10,
      probe_on_report: true,
      probe_before_assign: probeBeforeAssign,
    },
    budget_profile: null,
    budget_thresholds: null,
    unit_prices: null,
    billing_cycle_started_at: null,
    max_active_rooms: null,
  };
}

const topology = {
  status: "ok",
  version: 4,
  assignmentEpoch: CURRENT_TOPOLOGY_EPOCH,
  minFallbackBp: 1_000,
  hubConfig: { rt1: hub(true, 10_000, true), rt2: hub(false, 0, false) },
  ramp: { canary_bp: 500, step_bp: 1_000, interval_seconds: 300, runtime: null },
  hub2NewRoomAdmissionReady: false,
};

async function makeScenario(options: {
  assignmentEpoch?: number;
  topologyEpochAtIssue?: number;
  nowMs?: number;
  fetcher?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  rampRuntime?: Record<string, unknown>;
} = {}) {
  const signing = await makeSigning();
  const nowMs = options.nowMs ?? NOW_MS;
  let currentTopology = options.rampRuntime
    ? { ...topology, ramp: { ...topology.ramp, runtime: options.rampRuntime } }
    : topology;
  const roomId = await deriveOpaqueRoomId(signing.roomHmacKey, NOTE_ID, GENERATION);
  const bucket = await stableRoomBucket(roomId);
  const assignmentEpoch = options.assignmentEpoch ?? ASSIGNMENT_EPOCH;
  let assignment = {
    status: "ok",
    bucket,
    hubId: "rt1",
    assignmentEpoch,
    topologyEpoch: TOPOLOGY_EPOCH_AT_ISSUE,
  };
  const ticket = await issueRealtimeTicket({
    roomId,
    generation: GENERATION,
    permissionEpoch: PERMISSION_EPOCH,
    permission: "edit",
    sessionId: SESSION_ID,
    nowSeconds: NOW_SECONDS,
    ttlSeconds: 300,
    routing: {
      hubId: "rt1",
      assignmentEpoch: ASSIGNMENT_EPOCH,
      topologyEpoch: options.topologyEpochAtIssue ?? TOPOLOGY_EPOCH_AT_ISSUE,
    },
  }, signing);
  const calls: Array<{ name: RealtimeHubRpcName; args: Record<string, unknown> }> = [];
  let latestRt1Health: "healthy" | "down" = "healthy";
  const rpc = vi.fn(async (name: RealtimeHubRpcName, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "realtime_topology_read") return { data: currentTopology, error: null };
    if (name === "realtime_hub_health_read") {
      return {
        data: {
          status: "ok",
          hubId: args.p_hub_id,
          assignmentEpoch: currentTopology.assignmentEpoch,
          healthStatus: args.p_hub_id === "rt1" ? latestRt1Health : "unknown",
          checkedAt: args.p_hub_id === "rt1" ? new Date(nowMs).toISOString() : null,
          downUntil: latestRt1Health === "down" ? new Date(nowMs + 60_000).toISOString() : null,
          consecutiveFailures: latestRt1Health === "down" ? 1 : 0,
          stateVersion: 1,
        },
        error: null,
      };
    }
    if (name === "realtime_room_assignment_read") return { data: assignment, error: null };
    if (name === "realtime_hub_probe_claim") {
      return {
        data: { status: "probe_started", hubId: "rt1", assignmentEpoch: currentTopology.assignmentEpoch, leaseId: LEASE_ID },
        error: null,
      };
    }
    if (name === "realtime_hub_probe_complete") {
      latestRt1Health = args.p_probe_succeeded === true ? "healthy" : "down";
      return {
        data: { status: "accepted", hubId: "rt1", healthStatus: args.p_probe_succeeded ? "healthy" : "down" },
        error: null,
      };
    }
    if (name === "realtime_topology_update") {
      currentTopology = {
        ...currentTopology,
        version: currentTopology.version + 1,
        assignmentEpoch: currentTopology.assignmentEpoch + 1,
        hubConfig: args.p_hubs as typeof topology.hubConfig,
        ramp: args.p_ramp as typeof topology.ramp,
      };
      return { data: { status: "updated" }, error: null };
    }
    if (name === "realtime_room_assignment_apply") {
      if (args.p_target_hub_id === "slow") {
        const changed = assignment.hubId !== "slow";
        assignment = {
          ...assignment,
          hubId: "slow",
          assignmentEpoch: assignment.assignmentEpoch + (changed ? 1 : 0),
          topologyEpoch: currentTopology.assignmentEpoch,
        };
        return {
          data: {
            status: changed ? "changed" : "unchanged",
            bucket,
            hubId: "slow",
            assignmentEpoch: assignment.assignmentEpoch,
            topologyEpoch: currentTopology.assignmentEpoch,
          },
          error: null,
        };
      }
      return {
        data: {
          status: "unchanged",
          bucket,
          hubId: assignment.hubId,
          assignmentEpoch: assignment.assignmentEpoch,
          topologyEpoch: currentTopology.assignmentEpoch,
        },
        error: null,
      };
    }
    return { data: { status: "unavailable" }, error: null };
  });
  const dependencies: RealtimeHubEdgeDependencies = {
    rpc,
    now: () => nowMs,
    healthUrl: () => "https://rt1.example.test/healthz",
    fetcher: options.fetcher,
    sleep: options.sleep,
  };
  return {
    signing,
    ticket,
    roomId,
    bucket,
    calls,
    rpc,
    dependencies,
    get assignment() {
      return assignment;
    },
    context: {
      status: "ok",
      noteId: NOTE_ID,
      revision: 9,
      generation: GENERATION,
      permissionEpoch: PERMISSION_EPOCH,
      ydocState: "AQID",
      sessionId: SESSION_ID,
    },
  };
}

function reportBody(ticket: string, overrides: Record<string, unknown> = {}) {
  return { report: "hub_unreachable", ticket, session_id: SESSION_ID, ...overrides };
}

describe("K2 Edge report validation and health probe round", () => {
  it("rejects an invalid report before any RPC or probe can run", async () => {
    const scenario = await makeScenario();
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket, { report: "hub_healthy" }),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result.status).toBe("invalid_report");
    expect(scenario.rpc).not.toHaveBeenCalled();
  });

  it("rejects an expired signed ticket before claiming a probe lease", async () => {
    const scenario = await makeScenario({ nowMs: (NOW_SECONDS + 301) * 1_000 });
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result.status).toBe("expired");
    expect(scenario.calls.some((call) => call.name === "realtime_hub_probe_claim")).toBe(false);
  });

  it("checks the session binding before claiming a probe lease", async () => {
    const scenario = await makeScenario();
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket, { session_id: "session-other-01" }),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result.status).toBe("session_or_ticket_mismatch");
    expect(scenario.calls.some((call) => call.name === "realtime_hub_probe_claim")).toBe(false);
  });

  it("checks the current per-room epoch before claiming a probe lease", async () => {
    const scenario = await makeScenario({ assignmentEpoch: ASSIGNMENT_EPOCH + 1 });
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result.status).toBe("stale_epoch");
    expect(scenario.calls.some((call) => call.name === "realtime_hub_probe_claim")).toBe(false);
  });

  it("accepts an older topology epoch for an unchanged room, then claims with current topology epoch", async () => {
    const scenario = await makeScenario({ topologyEpochAtIssue: CURRENT_TOPOLOGY_EPOCH - 1 });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    scenario.dependencies.fetcher = fetcher;
    scenario.dependencies.sleep = vi.fn(async () => {});
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result.status).toBe("ok");
    const claim = scenario.calls.find((call) => call.name === "realtime_hub_probe_claim");
    expect(claim?.args).toMatchObject({ p_hub_id: "rt1", p_assignment_epoch: CURRENT_TOPOLOGY_EPOCH });
    expect(scenario.calls.filter((call) => call.name === "realtime_hub_probe_complete")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once after one second and sends one aggregated success to probe_complete", async () => {
    const first = new Response("not yet", { status: 503 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as typeof fetch;
    const sleep = vi.fn(async () => {});
    const scenario = await makeScenario({ fetcher, sleep });
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result).toMatchObject({ status: "ok", probeSucceeded: true, hubId: "rt1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(scenario.calls.filter((call) => call.name === "realtime_hub_probe_claim")).toHaveLength(1);
    const completeCalls = scenario.calls.filter((call) => call.name === "realtime_hub_probe_complete");
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].args).toMatchObject({
      p_hub_id: "rt1",
      p_assignment_epoch: CURRENT_TOPOLOGY_EPOCH,
      p_lease_id: LEASE_ID,
      p_probe_succeeded: true,
    });
  });

  it("sets the hub down only after both Edge attempts fail and moves the room to slow sync", async () => {
    const fetcher = vi.fn(async () => new Response("unhealthy", { status: 503 })) as typeof fetch;
    const sleep = vi.fn(async () => {});
    const scenario = await makeScenario({ fetcher, sleep });
    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );
    expect(result).toMatchObject({ status: "slow_sync", probeSucceeded: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    const completeCalls = scenario.calls.filter((call) => call.name === "realtime_hub_probe_complete");
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0].args).toMatchObject({ p_probe_succeeded: false, p_lease_id: LEASE_ID });
    expect(scenario.calls.some((call) => call.name === "realtime_room_assignment_apply"))
      .toBe(true);
  });

  it("stops a recovery ramp after probe failure and changes the room assignment epoch", async () => {
    const fetcher = vi.fn(async () => new Response("unhealthy", { status: 503 })) as typeof fetch;
    const scenario = await makeScenario({
      fetcher,
      sleep: vi.fn(async () => {}),
      rampRuntime: {
        active: true,
        recovering_hub_id: "rt1",
        current_weight_bp: 500,
        target_weight_bp: 9_000,
        last_step_at_ms: NOW_MS - 300_000,
        started_at_ms: NOW_MS - 600_000,
      },
    });

    const result = await handleRealtimeHubReport(
      reportBody(scenario.ticket.ticket),
      scenario.context,
      scenario.signing,
      scenario.dependencies,
    );

    expect(result).toMatchObject({
      status: "slow_sync",
      probeSucceeded: false,
      topologyEpoch: CURRENT_TOPOLOGY_EPOCH + 1,
    });
    const rampUpdate = scenario.calls.find((call) => call.name === "realtime_topology_update");
    expect(rampUpdate?.args.p_reason).toBe("Edge probe failed during recovery ramp");
    expect(rampUpdate?.args.p_ramp).toMatchObject({
      runtime: { active: false, stopped_reason: "probe_failed" },
    });
    const assignmentUpdates = scenario.calls.filter(
      (call) => call.name === "realtime_room_assignment_apply",
    );
    const assignmentUpdate = assignmentUpdates[assignmentUpdates.length - 1];
    expect(assignmentUpdate?.args).toMatchObject({
      p_target_hub_id: "slow",
      p_expected_assignment_epoch: ASSIGNMENT_EPOCH,
      p_topology_epoch: CURRENT_TOPOLOGY_EPOCH + 1,
    });
    expect(scenario.assignment).toMatchObject({
      hubId: "slow",
      assignmentEpoch: ASSIGNMENT_EPOCH + 1,
      topologyEpoch: CURRENT_TOPOLOGY_EPOCH + 1,
    });
  });

  it("keeps retry timing deterministic and reports failure only after both attempts fail", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push("fetch");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer /u) });
      return new Response("unhealthy", { status: 503 });
    }) as typeof fetch;
    const sleep = vi.fn(async (delayMs: number) => { calls.push(`sleep:${delayMs}`); });
    const signing = await makeSigning();
    const success = await runHubHealthProbeRound({
      hubId: "rt2",
      url: "https://rt2.example.test/healthz",
      config: signing,
      timeoutMs: 2_000,
      retryCount: 1,
      retryDelayMs: 1_000,
      nowMs: NOW_MS,
      fetcher,
      sleep,
    });
    expect(success).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(calls).toEqual(["fetch", "sleep:1000", "fetch"]);
  });
});
