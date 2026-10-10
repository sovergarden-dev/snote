import type { HubBudgetMetricsProvider } from "../note-session/realtime-hub-edge.ts";
import type { BudgetMetricsSnapshot } from "../note-session/realtime-hub-routing.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const REQUEST_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const MAX_QUERY_ROWS = 10_000;
const MINUTE_MS = 60_000;

/**
 * Candidate GraphQL mapping for the hub budget snapshot. A public working client
 * in Denoflare uses the same DO invocation and periodic datasets/fields for
 * requests, activeTime and inboundWebsocketMsgCount:
 * https://github.com/skymethod/denoflare/blob/master/common/analytics/cfgql_client.ts
 * That file does not include SQLite rowsWritten; the primary field and fallbacks
 * below are Syringa-authorized candidates checked by the rollout-only schema
 * script. An unknown field intentionally surfaces as a GraphQL error and blocks rt2.
 */
export const HUB_BUDGET_GRAPHQL_FIELD_MAPPING = {
  workerRequests: {
    dataset: "workersInvocationsAdaptive",
    sumField: "requests",
  },
  rt2Freshness: {
    dataset: "workersInvocationsAdaptive",
    scriptNameFilterField: "scriptName",
    datetimeMinuteField: "datetimeMinute",
    orderBy: "datetimeMinute_DESC",
  },
  doRequests: {
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    sumField: "requests",
  },
  inboundWebSocketMessages: {
    dataset: "durableObjectsPeriodicGroups",
    sumField: "inboundWebsocketMsgCount",
  },
  activeTimeMicroseconds: {
    dataset: "durableObjectsPeriodicGroups",
    sumField: "activeTime",
  },
  doGbSecondsAlternatives: [
    { dataset: "durableObjectsPeriodicGroups", sumField: "duration" },
  ],
  doSqliteRowsWritten: {
    dataset: "durableObjectsPeriodicGroups",
    sumField: "rowsWritten",
  },
  sqliteRowsWrittenAlternatives: [
    { dataset: "durableObjectsSqlStorageGroups", sumField: "rowsWritten" },
  ],
} as const;

/** Schema paths checked by scripts/cf-analytics-schema-check.ts at rollout. */
export const HUB_BUDGET_GRAPHQL_SCHEMA_CHECK_PATHS: readonly (readonly string[])[] = [
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.workerRequests.dataset,
    "sum",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.workerRequests.sumField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.workerRequests.dataset,
    "dimensions",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.rt2Freshness.scriptNameFilterField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.workerRequests.dataset,
    "dimensions",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.rt2Freshness.datetimeMinuteField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doRequests.dataset,
    "sum",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doRequests.sumField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.inboundWebSocketMessages.dataset,
    "sum",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.inboundWebSocketMessages.sumField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.activeTimeMicroseconds.dataset,
    "sum",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.activeTimeMicroseconds.sumField,
  ],
  [
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doSqliteRowsWritten.dataset,
    "sum",
    HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doSqliteRowsWritten.sumField,
  ],
  ...HUB_BUDGET_GRAPHQL_FIELD_MAPPING.doGbSecondsAlternatives.map((candidate) => [
    candidate.dataset,
    "sum",
    candidate.sumField,
  ]),
  ...HUB_BUDGET_GRAPHQL_FIELD_MAPPING.sqliteRowsWrittenAlternatives.map((candidate) => [
    candidate.dataset,
    "sum",
    candidate.sumField,
  ]),
];

export interface HubBudgetMetricsEnvironment {
  SNOTE_CF_ANALYTICS_TOKEN?: string;
  SNOTE_CF_ACCOUNT_ID?: string;
  SNOTE_CF_RT2_SCRIPT_NAME?: string;
}

export interface HubBudgetMetricsDependencies {
  fetcher?: typeof fetch;
  clock?: () => number;
}

interface DatasetSettings {
  enabled: boolean;
  maxPageSize: number;
  maxDuration: number;
  notOlderThan: number;
}

interface CacheEntry {
  expiresAt: number;
  snapshot: BudgetMetricsSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorSnapshot(): BudgetMetricsSnapshot {
  return { status: "error", metrics: {} };
}

function unavailableSnapshot(metrics: BudgetMetricsSnapshot["metrics"] = {}): BudgetMetricsSnapshot {
  return { status: "unavailable", metrics };
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseGraphqlEnvelope(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid GraphQL response");
  if ("errors" in value && value.errors !== null) {
    if (!Array.isArray(value.errors) || value.errors.length > 0) {
      throw new Error("GraphQL request failed");
    }
  }
  return value;
}

function accountFromEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  const data = value.data;
  const viewer = isRecord(data) ? data.viewer : null;
  const accounts = isRecord(viewer) ? viewer.accounts : null;
  if (!Array.isArray(accounts) || accounts.length !== 1 || !isRecord(accounts[0])) {
    throw new Error("Invalid account response");
  }
  return accounts[0];
}

async function postGraphql(
  fetcher: typeof fetch,
  token: string,
  query: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetcher(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok) throw new Error("Analytics HTTP request failed");
  return parseGraphqlEnvelope(await response.json());
}

function parseSettings(envelope: Record<string, unknown>): DatasetSettings | null {
  const account = accountFromEnvelope(envelope);
  const settings = account.settings;
  if (!isRecord(settings)) throw new Error("Invalid Analytics settings");
  const dataset = settings.workersInvocationsAdaptive;
  if (dataset === null || dataset === undefined) return null;
  if (!isRecord(dataset) || typeof dataset.enabled !== "boolean") {
    throw new Error("Invalid Workers dataset settings");
  }
  if (!dataset.enabled) return null;
  const maxPageSize = positiveSafeInteger(dataset.maxPageSize);
  const maxDuration = positiveSafeInteger(dataset.maxDuration);
  const notOlderThan = positiveSafeInteger(dataset.notOlderThan);
  if (maxPageSize === null || maxDuration === null || notOlderThan === null) {
    throw new Error("Invalid Workers dataset limits");
  }
  return { enabled: true, maxPageSize, maxDuration, notOlderThan };
}

function settingsQuery(accountId: string): string {
  return `query HubBudgetDatasetSettings {
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        settings {
          workersInvocationsAdaptive {
            enabled
            maxPageSize
            maxDuration
            notOlderThan
          }
        }
      }
    }
  }`;
}

function metricsQuery(
  accountId: string,
  scriptName: string,
  start: string,
  end: string,
  startDate: string,
  endDate: string,
  limit: number,
): string {
  const mapping = HUB_BUDGET_GRAPHQL_FIELD_MAPPING;
  return `query HubBudgetMetrics {
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        workerRequestTotals: ${mapping.workerRequests.dataset}(
          limit: ${limit}
          filter: {
            datetime_geq: ${JSON.stringify(start)}
            datetime_leq: ${JSON.stringify(end)}
          }
        ) {
          sum { ${mapping.workerRequests.sumField} }
        }
        doRequestTotals: ${mapping.doRequests.dataset}(
          limit: ${limit}
          filter: {
            date_geq: ${JSON.stringify(startDate)}
            date_leq: ${JSON.stringify(endDate)}
          }
        ) {
          sum { ${mapping.doRequests.sumField} }
        }
        doPeriodicTotals: ${mapping.activeTimeMicroseconds.dataset}(
          limit: ${limit}
          filter: {
            date_geq: ${JSON.stringify(startDate)}
            date_leq: ${JSON.stringify(endDate)}
          }
        ) {
          sum {
            ${mapping.activeTimeMicroseconds.sumField}
            ${mapping.inboundWebSocketMessages.sumField}
            ${mapping.doSqliteRowsWritten.sumField}
          }
        }
        rt2Latest: ${mapping.rt2Freshness.dataset}(
          limit: 1
          filter: {
            datetime_geq: ${JSON.stringify(start)}
            datetime_leq: ${JSON.stringify(end)}
            ${mapping.rt2Freshness.scriptNameFilterField}: ${JSON.stringify(scriptName)}
          }
          orderBy: [${mapping.rt2Freshness.orderBy}]
        ) {
          dimensions { ${mapping.rt2Freshness.datetimeMinuteField} }
        }
      }
    }
  }`;
}

function readSettingsWindow(
  settings: DatasetSettings,
  windowSeconds: number,
): "ok" | "unavailable" {
  if (windowSeconds > settings.maxDuration || windowSeconds > settings.notOlderThan) {
    return "unavailable";
  }
  return "ok";
}

function sumMetric(rowsValue: unknown, fieldName: string): number | null {
  if (rowsValue === null || rowsValue === undefined) return null;
  if (!Array.isArray(rowsValue)) throw new Error("Invalid Analytics rows");
  if (rowsValue.length === 0) return 0;

  let total = 0;
  for (const row of rowsValue) {
    if (!isRecord(row)) throw new Error("Invalid Analytics row");
    const sum = row.sum;
    if (sum === null || sum === undefined || !isRecord(sum)) return null;
    const value = sum[fieldName];
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid Analytics metric value");
    }
    if (total > Number.MAX_SAFE_INTEGER - value) {
      throw new Error("Analytics metric total is out of range");
    }
    total += value;
  }
  return total;
}

function parseLatestRt2Minute(
  account: Record<string, unknown>,
  startMs: number,
  nowMs: number,
): number | null {
  const rows = account.rt2Latest;
  if (rows === null || rows === undefined) return null;
  if (!Array.isArray(rows)) throw new Error("Invalid Workers freshness rows");
  if (rows.length === 0) return null;

  const row = rows[0];
  if (!isRecord(row)) throw new Error("Invalid Workers freshness row");
  const dimensions = row.dimensions;
  if (dimensions === null || dimensions === undefined || !isRecord(dimensions)) return null;
  const datetimeMinute = dimensions[HUB_BUDGET_GRAPHQL_FIELD_MAPPING.rt2Freshness.datetimeMinuteField];
  if (datetimeMinute === null || datetimeMinute === undefined) return null;
  if (typeof datetimeMinute !== "string") throw new Error("Invalid Workers freshness timestamp");
  const timestamp = Date.parse(datetimeMinute);
  if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp > nowMs) {
    throw new Error("Workers freshness timestamp is out of range");
  }
  return Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
}

function parseMetrics(
  envelope: Record<string, unknown>,
  startMs: number,
  nowMs: number,
): BudgetMetricsSnapshot {
  const account = accountFromEnvelope(envelope);
  const mapping = HUB_BUDGET_GRAPHQL_FIELD_MAPPING;
  const workerRequests = sumMetric(account.workerRequestTotals, mapping.workerRequests.sumField);
  const doRequests = sumMetric(account.doRequestTotals, mapping.doRequests.sumField);
  const inboundWebSocketMessages = sumMetric(
    account.doPeriodicTotals,
    mapping.inboundWebSocketMessages.sumField,
  );
  const activeTimeMicroseconds = sumMetric(
    account.doPeriodicTotals,
    mapping.activeTimeMicroseconds.sumField,
  );
  const sqliteRowsWritten = sumMetric(
    account.doPeriodicTotals,
    mapping.doSqliteRowsWritten.sumField,
  );
  const observedThrough = parseLatestRt2Minute(account, startMs, nowMs);

  const metrics: BudgetMetricsSnapshot["metrics"] = {};
  if (observedThrough !== null) {
    if (workerRequests !== null) {
      metrics.worker_requests = { used: workerRequests, observedThrough };
    }
    if (doRequests !== null && inboundWebSocketMessages !== null) {
      metrics.do_billed_requests = {
        used: calculateDoBilledRequests(doRequests, inboundWebSocketMessages),
        observedThrough,
      };
    }
    if (activeTimeMicroseconds !== null) {
      metrics.do_gb_s = {
        used: calculateDoGbSeconds(activeTimeMicroseconds),
        observedThrough,
      };
    }
    if (sqliteRowsWritten !== null) {
      metrics.do_sqlite_rows_written = { used: sqliteRowsWritten, observedThrough };
    }
  }

  if (
    observedThrough === null
    || workerRequests === null
    || doRequests === null
    || inboundWebSocketMessages === null
    || activeTimeMicroseconds === null
    || sqliteRowsWritten === null
  ) return unavailableSnapshot(metrics);

  return { status: "ok", metrics };
}

async function fetchSnapshot(input: {
  token: string;
  accountId: string;
  rt2ScriptName: string;
  fetcher: typeof fetch;
  nowMs: number;
  startMs: number;
}): Promise<BudgetMetricsSnapshot> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Analytics request timed out"));
    }, REQUEST_TIMEOUT_MS);
  });

  const operation = (async (): Promise<BudgetMetricsSnapshot> => {
    const start = new Date(input.startMs).toISOString();
    const end = new Date(input.nowMs).toISOString();
    const startDate = start.slice(0, 10);
    const endDate = end.slice(0, 10);
    const settingsEnvelope = await postGraphql(
      input.fetcher,
      input.token,
      settingsQuery(input.accountId),
      controller.signal,
    );
    const settings = parseSettings(settingsEnvelope);
    if (!settings) return unavailableSnapshot();
    const windowSeconds = Math.ceil((input.nowMs - input.startMs) / 1_000);
    if (readSettingsWindow(settings, windowSeconds) !== "ok") return unavailableSnapshot();

    const limit = Math.min(settings.maxPageSize, MAX_QUERY_ROWS);
    const metricsEnvelope = await postGraphql(
      input.fetcher,
      input.token,
      metricsQuery(
        input.accountId,
        input.rt2ScriptName,
        start,
        end,
        startDate,
        endDate,
        limit,
      ),
      controller.signal,
    );
    return parseMetrics(metricsEnvelope, input.startMs, input.nowMs);
  })();

  try {
    return await Promise.race([operation, timedOut]);
  } catch {
    return errorSnapshot();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Calculate DO billed requests, including one billed request per 20 inbound WebSocket messages. */
export function calculateDoBilledRequests(
  doRequests: number,
  inboundWebSocketMessages: number,
): number {
  if (
    !Number.isSafeInteger(doRequests) || doRequests < 0
    || !Number.isSafeInteger(inboundWebSocketMessages) || inboundWebSocketMessages < 0
  ) throw new RangeError("Durable Objects request inputs must be non-negative safe integers");
  const billed = doRequests + Math.ceil(inboundWebSocketMessages / 20);
  if (!Number.isSafeInteger(billed)) throw new RangeError("Durable Objects request total is invalid");
  return billed;
}

/** Convert active-time microseconds to GB-seconds using 128 MB allocated per second. */
export function calculateDoGbSeconds(activeTimeMicroseconds: number): number {
  if (!Number.isSafeInteger(activeTimeMicroseconds) || activeTimeMicroseconds < 0) {
    throw new RangeError("Active time must be a non-negative safe integer in microseconds");
  }
  const gbSeconds = activeTimeMicroseconds / 1_000_000 * 0.125;
  if (!Number.isFinite(gbSeconds) || gbSeconds < 0) {
    throw new RangeError("GB-s total is invalid");
  }
  return gbSeconds;
}

export function createCloudflareHubBudgetMetricsProvider(
  environment: HubBudgetMetricsEnvironment,
  dependencies: HubBudgetMetricsDependencies = {},
): HubBudgetMetricsProvider | null {
  const token = environment.SNOTE_CF_ANALYTICS_TOKEN?.trim();
  const accountId = environment.SNOTE_CF_ACCOUNT_ID?.trim();
  const rt2ScriptName = environment.SNOTE_CF_RT2_SCRIPT_NAME?.trim();
  if (!token || !accountId || !rt2ScriptName) return null;

  const fetcher = dependencies.fetcher ?? fetch;
  const clock = dependencies.clock ?? Date.now;
  const cache = new Map<number, CacheEntry>();
  const inFlight = new Map<number, Promise<BudgetMetricsSnapshot>>();

  return {
    readSnapshot({ nowMs }): Promise<BudgetMetricsSnapshot> {
      if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) {
        return Promise.resolve(errorSnapshot());
      }
      const cacheNow = clock();
      if (!Number.isFinite(cacheNow)) return Promise.resolve(errorSnapshot());
      const date = new Date(nowMs);
      const startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

      for (const [key, entry] of cache) {
        if (key !== startMs || entry.expiresAt <= cacheNow) cache.delete(key);
      }
      const cached = cache.get(startMs);
      if (cached && cached.expiresAt > cacheNow) return Promise.resolve(cached.snapshot);
      const pending = inFlight.get(startMs);
      if (pending) return pending;

      const request = fetchSnapshot({
        token,
        accountId,
        rt2ScriptName,
        fetcher,
        nowMs,
        startMs,
      })
        .catch(() => errorSnapshot())
        .then((snapshot) => {
          const completedAt = clock();
          if (Number.isFinite(completedAt)) {
            cache.set(startMs, { expiresAt: completedAt + CACHE_TTL_MS, snapshot });
          }
          return snapshot;
        })
        .finally(() => {
          inFlight.delete(startMs);
        });
      inFlight.set(startMs, request);
      return request;
    },
  };
}
