// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCloudflareHubBudgetMetricsProvider,
  calculateDoBilledRequests,
  calculateDoGbSeconds,
} from "../../supabase/functions/_shared/hub-budget-metrics.ts";
import {
  evaluateHub2Budget,
  MAX_METRIC_AGE_MS,
  SAFE_FREE_BUDGET_THRESHOLDS,
  type BudgetMetricsSnapshot,
} from "../../supabase/functions/note-session/realtime-hub-routing.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const ENV = {
  SNOTE_CF_ANALYTICS_TOKEN: "fixture-only-token",
  SNOTE_CF_ACCOUNT_ID: "fixture-account-id-not-real",
  SNOTE_CF_RT2_SCRIPT_NAME: "fixture-rt2-script",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function settingsResponse(options: {
  enabled?: boolean;
  maxPageSize?: number;
  maxDuration?: number;
  notOlderThan?: number;
} = {}): Response {
  return response({
    data: {
      viewer: {
        accounts: [{
          settings: {
            workersInvocationsAdaptive: {
              enabled: options.enabled ?? true,
              maxPageSize: options.maxPageSize ?? 100,
              maxDuration: options.maxDuration ?? 86_400,
              notOlderThan: options.notOlderThan ?? 86_400,
            },
          },
        }],
      },
    },
    errors: null,
  });
}

function metricsResponse(rows: unknown[]): Response {
  return response({
    data: {
      viewer: {
        accounts: [{ workersInvocationsAdaptive: rows }],
      },
    },
    errors: null,
  });
}

function workerRow(input: {
  requests: number;
  scriptName: string;
  datetime: string;
}) {
  return {
    sum: { requests: input.requests },
    dimensions: { datetime: input.datetime, scriptName: input.scriptName },
  };
}

function fixtureFetcher(rows: unknown[], onRequest?: (body: string) => void) {
  let call = 0;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    onRequest?.(body);
    call += 1;
    return call % 2 === 1 ? settingsResponse() : metricsResponse(rows);
  });
  return fetcher;
}

function provider(
  fetcher: typeof fetch,
  clock: () => number = () => NOW,
  env: Record<string, string | undefined> = ENV,
) {
  return createCloudflareHubBudgetMetricsProvider(env, { fetcher, clock });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare hub budget metrics provider", () => {
  it("requires all three environment values and accepts fixture-only values", () => {
    expect(createCloudflareHubBudgetMetricsProvider({}, { fetcher: fetch, clock: () => NOW }))
      .toBeNull();
    expect(createCloudflareHubBudgetMetricsProvider({
      ...ENV,
      SNOTE_CF_RT2_SCRIPT_NAME: "",
    }, { fetcher: fetch, clock: () => NOW })).toBeNull();
    expect(provider(fixtureFetcher([]))).not.toBeNull();
  });

  it("counts Workers requests account-wide and uses rt2's latest data minute", async () => {
    const bodies: string[] = [];
    const rows = [
      workerRow({
        requests: 11,
        scriptName: "unrelated-account-worker",
        datetime: "2026-10-10T09:04:03.000Z",
      }),
      workerRow({
        requests: 17,
        scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
        datetime: "2026-10-10T11:58:47.000Z",
      }),
      workerRow({
        requests: 3,
        scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
        datetime: "2026-10-10T11:59:34.000Z",
      }),
    ];
    const fetcher = fixtureFetcher(rows, (body) => bodies.push(body));
    const result = await provider(fetcher)!.readSnapshot({ nowMs: NOW });

    expect(result).toEqual({
      status: "unavailable",
      metrics: {
        worker_requests: {
          used: 31,
          observedThrough: Date.parse("2026-10-10T11:59:00.000Z"),
        },
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("workersInvocationsAdaptive");
    expect(bodies[1]).toContain("workersInvocationsAdaptive");
    expect(bodies[1]).toContain("sum { requests }");
    expect(bodies[1]).toContain("dimensions { datetime scriptName }");
    expect(bodies[1]).toContain("datetime_geq");
    expect(bodies[1]).toContain("datetime_leq");
    expect(bodies[1]).not.toContain("scriptName:");
    expect(bodies[1]).toContain("2026-10-10T00:00:00.000Z");
    expect(bodies[1]).toContain("2026-10-10T12:00:00.000Z");
    expect(bodies.join("\n")).not.toContain("durableObjects");
  });

  it("marks unsupported DO analytics unavailable instead of inventing GraphQL fields", async () => {
    const result = await provider(fixtureFetcher([
      workerRow({
        requests: 5,
        scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
        datetime: "2026-10-10T11:59:00.000Z",
      }),
    ]))!.readSnapshot({ nowMs: NOW });

    expect(result.status).toBe("unavailable");
    expect(result.metrics).not.toHaveProperty("do_billed_requests");
    expect(result.metrics).not.toHaveProperty("do_gb_s");
    expect(result.metrics).not.toHaveProperty("do_sqlite_rows_written");
  });

  it("calculates billed Durable Object requests from request and inbound-message evidence", () => {
    expect(calculateDoBilledRequests(7, 0)).toBe(7);
    expect(calculateDoBilledRequests(7, 1)).toBe(8);
    expect(calculateDoBilledRequests(7, 20)).toBe(8);
    expect(calculateDoBilledRequests(7, 21)).toBe(9);
    expect(() => calculateDoBilledRequests(-1, 0)).toThrow(RangeError);
    expect(() => calculateDoBilledRequests(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("converts active time to GB-seconds using Cloudflare's 128 MB allocation", () => {
    expect(calculateDoGbSeconds(0)).toBe(0);
    expect(calculateDoGbSeconds(8)).toBe(1);
    expect(calculateDoGbSeconds(10)).toBe(1.25);
    expect(() => calculateDoGbSeconds(-1)).toThrow(RangeError);
    expect(() => calculateDoGbSeconds(Number.NaN)).toThrow(RangeError);
  });

  it("preserves the latest rt2 minute so data older than five minutes evaluates stale", async () => {
    const observedThrough = NOW - MAX_METRIC_AGE_MS - 1_000;
    const result = await provider(fixtureFetcher([
      workerRow({
        requests: 5,
        scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
        datetime: new Date(observedThrough).toISOString(),
      }),
    ]))!.readSnapshot({ nowMs: NOW });
    const workerSample = result.metrics.worker_requests;
    expect(workerSample?.observedThrough).toBe(
      Math.floor(observedThrough / 60_000) * 60_000,
    );

    const staleFixture: BudgetMetricsSnapshot = {
      status: "ok",
      metrics: {
        worker_requests: workerSample!,
        do_billed_requests: { used: 1, observedThrough: workerSample!.observedThrough },
        do_gb_s: { used: 1, observedThrough: workerSample!.observedThrough },
        do_sqlite_rows_written: { used: 1, observedThrough: workerSample!.observedThrough },
      },
    };
    expect(evaluateHub2Budget(staleFixture, SAFE_FREE_BUDGET_THRESHOLDS, NOW))
      .toMatchObject({ status: "stale", reason: "metrics_stale" });
  });

  it("returns error for HTTP failures and GraphQL errors", async () => {
    const httpFailure = vi.fn(async () => response({}, 502));
    await expect(provider(httpFailure as typeof fetch)!.readSnapshot({ nowMs: NOW }))
      .resolves.toEqual({ status: "error", metrics: {} });

    const graphqlFailure = vi.fn(async () => response({ errors: [{ message: "fixture" }] }));
    await expect(provider(graphqlFailure as typeof fetch)!.readSnapshot({ nowMs: NOW }))
      .resolves.toEqual({ status: "error", metrics: {} });
  });

  it("returns error for malformed JSON, negative, non-finite, or malformed metric values", async () => {
    const malformedJson = {
      ok: true,
      json: async () => { throw new SyntaxError("fixture"); },
    } as unknown as Response;
    const badJsonFetcher = vi.fn(async () => malformedJson);
    await expect(provider(badJsonFetcher as typeof fetch)!.readSnapshot({ nowMs: NOW }))
      .resolves.toEqual({ status: "error", metrics: {} });

    for (const requests of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fetcher = fixtureFetcher([
        workerRow({
          requests,
          scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
          datetime: "2026-10-10T11:59:00.000Z",
        }),
      ]);
      await expect(provider(fetcher)!.readSnapshot({ nowMs: NOW }))
        .resolves.toEqual({ status: "error", metrics: {} });
    }
  });

  it("times out a stalled Analytics request after three seconds", async () => {
    vi.useFakeTimers();
    const stalledFetcher = vi.fn(() => new Promise<Response>(() => {}));
    const pending = provider(stalledFetcher as typeof fetch)!.readSnapshot({ nowMs: NOW });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ status: "error", metrics: {} });
  });

  it("caches for 60 seconds and coalesces concurrent reads into one fetch flight", async () => {
    let clockMs = NOW;
    const rows = [workerRow({
      requests: 5,
      scriptName: ENV.SNOTE_CF_RT2_SCRIPT_NAME,
      datetime: "2026-10-10T11:59:00.000Z",
    })];
    const fetcher = fixtureFetcher(rows);
    const metricsProvider = provider(fetcher, () => clockMs)!;

    const firstReads = await Promise.all([
      metricsProvider.readSnapshot({ nowMs: NOW }),
      metricsProvider.readSnapshot({ nowMs: NOW }),
    ]);
    expect(firstReads[0]).toEqual(firstReads[1]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await metricsProvider.readSnapshot({ nowMs: NOW + 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    clockMs += 60_001;
    await metricsProvider.readSnapshot({ nowMs: NOW + 60_001 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
