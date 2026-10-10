// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateDoBilledRequests,
  calculateDoGbSeconds,
  createCloudflareHubBudgetMetricsProvider,
  HUB_BUDGET_GRAPHQL_FIELD_MAPPING,
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

type AnalyticsPayloadOptions = Partial<{
  workerRequestTotals: unknown[];
  doRequestTotals: unknown[];
  doPeriodicTotals: unknown[];
  rt2Latest: unknown[];
}>;

function analyticsPayload(options: AnalyticsPayloadOptions = {}) {
  return {
    data: {
      viewer: {
        accounts: [{
          workerRequestTotals: options.workerRequestTotals ?? [
            { sum: { requests: 11 } },
            { sum: { requests: 20 } },
          ],
          doRequestTotals: options.doRequestTotals ?? [
            { sum: { requests: 7 } },
            { sum: { requests: 4 } },
          ],
          doPeriodicTotals: options.doPeriodicTotals ?? [
            { sum: { activeTime: 4_000_000, inboundWebsocketMsgCount: 1, rowsWritten: 100 } },
            { sum: { activeTime: 4_000_000, inboundWebsocketMsgCount: 20, rowsWritten: 20 } },
          ],
          rt2Latest: options.rt2Latest ?? [{
            dimensions: { datetimeMinute: "2026-10-10T11:59:00.000Z" },
          }],
        }],
      },
    },
    errors: null,
  };
}

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

function fixtureFetcher(
  body: unknown,
  onRequest?: (body: string) => void,
) {
  let call = 0;
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    onRequest?.(String(init?.body ?? ""));
    call += 1;
    return call % 2 === 1 ? settingsResponse() : response(body);
  });
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
    expect(provider(fixtureFetcher(analyticsPayload()))).not.toBeNull();
  });

  it("returns ok only with all four account-wide metrics and rt2's latest minute", async () => {
    const bodies: string[] = [];
    const fetcher = fixtureFetcher(analyticsPayload(), (body) => bodies.push(body));
    const result = await provider(fetcher)!.readSnapshot({ nowMs: NOW });
    const observedThrough = Date.parse("2026-10-10T11:59:00.000Z");

    expect(result).toEqual({
      status: "ok",
      metrics: {
        worker_requests: { used: 31, observedThrough },
        do_billed_requests: { used: 13, observedThrough },
        do_gb_s: { used: 1, observedThrough },
        do_sqlite_rows_written: { used: 120, observedThrough },
      },
    });
    expect(bodies).toHaveLength(2);

    const query = JSON.parse(bodies[1]!).query as string;
    expect(query).toContain("workerRequestTotals: workersInvocationsAdaptive");
    expect(query).toContain("doRequestTotals: durableObjectsInvocationsAdaptiveGroups");
    expect(query).toContain("doPeriodicTotals: durableObjectsPeriodicGroups");
    expect(query).toContain("sum { requests }");
    expect(query).toMatch(/sum\s*{\s*activeTime\s+inboundWebsocketMsgCount\s+rowsWritten\s*}/);
    expect(query).toContain("date_geq: \"2026-10-10\"");
    expect(query).toContain("date_leq: \"2026-10-10\"");
    expect(query).toContain("datetime_geq: \"2026-10-10T00:00:00.000Z\"");
    expect(query).toContain("datetime_leq: \"2026-10-10T12:00:00.000Z\"");

    const accountWideTotals = query.slice(0, query.indexOf("rt2Latest:"));
    expect(accountWideTotals).not.toContain("dimensions");
    expect(accountWideTotals).not.toContain("scriptName");
    const freshnessQuery = query.slice(query.indexOf("rt2Latest:"));
    expect(freshnessQuery).toContain("workersInvocationsAdaptive");
    expect(freshnessQuery).toContain("scriptName: \"fixture-rt2-script\"");
    expect(freshnessQuery).toContain("orderBy: [datetimeMinute_DESC]");
    expect(freshnessQuery).toContain("limit: 1");
    expect(freshnessQuery).toContain("dimensions { datetimeMinute }");
    expect(HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doSqliteRowsWritten.sumField).toBe("rowsWritten");
    expect(HUB_BUDGET_GRAPHQL_FIELD_MAPPING.sqliteRowsWrittenAlternatives).toEqual([
      { dataset: "durableObjectsSqlStorageGroups", sumField: "rowsWritten" },
    ]);
    expect(HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doGbSecondsAlternatives).toEqual([
      { dataset: "durableObjectsPeriodicGroups", sumField: "duration" },
    ]);
  });

  it("returns zero for empty DO datasets when rt2 has a fresh sample", async () => {
    const result = await provider(fixtureFetcher(analyticsPayload({
      doRequestTotals: [],
      doPeriodicTotals: [],
    })))!.readSnapshot({ nowMs: NOW });
    const observedThrough = Date.parse("2026-10-10T11:59:00.000Z");

    expect(result).toEqual({
      status: "ok",
      metrics: {
        worker_requests: { used: 31, observedThrough },
        do_billed_requests: { used: 0, observedThrough },
        do_gb_s: { used: 0, observedThrough },
        do_sqlite_rows_written: { used: 0, observedThrough },
      },
    });
  });

  it("stays unavailable when rt2 has no latest sample", async () => {
    const result = await provider(fixtureFetcher(analyticsPayload({
      rt2Latest: [],
    })))!.readSnapshot({ nowMs: NOW });

    expect(result.status).toBe("unavailable");
  });

  it("stays unavailable when a DO dataset row has a null sum", async () => {
    const result = await provider(fixtureFetcher(analyticsPayload({
      doPeriodicTotals: [{ sum: null }],
    })))!.readSnapshot({ nowMs: NOW });

    expect(result.status).toBe("unavailable");
    expect(result.metrics.do_billed_requests).toBeUndefined();
    expect(result.metrics.do_gb_s).toBeUndefined();
    expect(result.metrics.do_sqlite_rows_written).toBeUndefined();
  });

  it("marks the snapshot unavailable when any required metric is missing", async () => {
    const missingRowsWritten = analyticsPayload({
      doPeriodicTotals: [
        { sum: { activeTime: 8_000_000, inboundWebsocketMsgCount: 21 } },
      ],
    });
    const result = await provider(fixtureFetcher(missingRowsWritten))!
      .readSnapshot({ nowMs: NOW });

    expect(result.status).toBe("unavailable");
    expect(result.metrics.do_sqlite_rows_written).toBeUndefined();
    expect(result.metrics.worker_requests?.used).toBe(31);
  });

  it("returns error for a GraphQL unknown-field error", async () => {
    const fetcher = fixtureFetcher({
      data: null,
      errors: [{ message: 'Cannot query field "rowsWritten" on type "DurableObjectPeriodicSum".' }],
    });
    await expect(provider(fetcher)!.readSnapshot({ nowMs: NOW }))
      .resolves.toEqual({ status: "error", metrics: {} });
  });

  it("sums high-volume aggregate rows without treating traffic as a truncated page", async () => {
    const fetcher = fixtureFetcher(analyticsPayload({
      workerRequestTotals: [{ sum: { requests: 25_000_001 } }],
    }));
    const result = await provider(fetcher)!.readSnapshot({ nowMs: NOW });

    expect(result.status).toBe("ok");
    expect(result.metrics.worker_requests?.used).toBe(25_000_001);
  });

  it("calculates billed Durable Object requests from request and inbound-message evidence", () => {
    expect(calculateDoBilledRequests(7, 0)).toBe(7);
    expect(calculateDoBilledRequests(7, 1)).toBe(8);
    expect(calculateDoBilledRequests(7, 20)).toBe(8);
    expect(calculateDoBilledRequests(7, 21)).toBe(9);
    expect(() => calculateDoBilledRequests(-1, 0)).toThrow(RangeError);
    expect(() => calculateDoBilledRequests(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("converts active-time microseconds to GB-seconds using 128 MB per second", () => {
    expect(calculateDoGbSeconds(0)).toBe(0);
    expect(calculateDoGbSeconds(8_000_000)).toBe(1);
    expect(calculateDoGbSeconds(10_000_000)).toBe(1.25);
    expect(() => calculateDoGbSeconds(-1)).toThrow(RangeError);
    expect(() => calculateDoGbSeconds(Number.NaN)).toThrow(RangeError);
  });

  it("preserves rt2's latest minute so data older than five minutes evaluates stale", async () => {
    const observedThrough = NOW - MAX_METRIC_AGE_MS - 1_000;
    const result = await provider(fixtureFetcher(analyticsPayload({
      rt2Latest: [{ dimensions: { datetimeMinute: new Date(observedThrough).toISOString() } }],
    })))!.readSnapshot({ nowMs: NOW });
    const workerSample = result.metrics.worker_requests;
    expect(workerSample?.observedThrough).toBe(Math.floor(observedThrough / 60_000) * 60_000);

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

    const graphqlFailure = fixtureFetcher({ errors: [{ message: "fixture" }] });
    await expect(provider(graphqlFailure)!.readSnapshot({ nowMs: NOW }))
      .resolves.toEqual({ status: "error", metrics: {} });
  });

  it("returns error for malformed JSON and invalid metric values", async () => {
    const malformedJson = {
      ok: true,
      json: async () => { throw new SyntaxError("fixture"); },
    } as unknown as Response;
    await expect(provider(vi.fn(async () => malformedJson) as typeof fetch)!
      .readSnapshot({ nowMs: NOW })).resolves.toEqual({ status: "error", metrics: {} });

    for (const requests of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = analyticsPayload({ workerRequestTotals: [{ sum: { requests } }] });
      let call = 0;
      const fetcher = vi.fn(async () => {
        call += 1;
        if (call % 2 === 1) return settingsResponse();
        return { ok: true, json: async () => body } as unknown as Response;
      });
      await expect(provider(fetcher as typeof fetch)!.readSnapshot({ nowMs: NOW }))
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
    const fetcher = fixtureFetcher(analyticsPayload());
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
