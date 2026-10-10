import type { HubBudgetMetricsProvider } from "../note-session/realtime-hub-edge.ts";
import type { BudgetMetricsSnapshot } from "../note-session/realtime-hub-routing.ts";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const REQUEST_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60_000;
const MAX_QUERY_ROWS = 10_000;
const MINUTE_MS = 60_000;

/**
 * Cloudflare documentation references:
 * - Workers invocation dataset and documented requests/datetime/scriptName fields:
 *   https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
 * - Account settings node and maxPageSize/maxDuration/notOlderThan:
 *   https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/
 * - Durable Object datasets and WebSocket analytics availability:
 *   https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
 * - Billing formulas, including the 20:1 inbound WebSocket ratio and 128 MB allocation:
 *   https://developers.cloudflare.com/durable-objects/platform/pricing/
 *
 * The public Durable Objects docs do not name Analytics fields for inbound
 * WebSocket messages, active duration, or SQLite rows written. Those metrics are
 * deliberately omitted rather than querying undocumented/guessed fields.
 */

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

function unavailableSnapshot(): BudgetMetricsSnapshot {
  return { status: "unavailable", metrics: {} };
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

function metricsQuery(accountId: string, start: string, end: string, limit: number): string {
  return `query HubBudgetWorkerRequests {
    viewer {
      accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
        workersInvocationsAdaptive(
          limit: ${limit}
          filter: {
            datetime_geq: ${JSON.stringify(start)}
            datetime_leq: ${JSON.stringify(end)}
          }
        ) {
          sum { requests }
          dimensions { datetime scriptName }
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

function parseWorkerUsage(
  envelope: Record<string, unknown>,
  scriptName: string,
  startMs: number,
  nowMs: number,
  limit: number,
): BudgetMetricsSnapshot {
  const account = accountFromEnvelope(envelope);
  const rows = account.workersInvocationsAdaptive;
  if (!Array.isArray(rows)) throw new Error("Invalid Workers Analytics rows");
  // A full page may be truncated. Do not report a partial account-wide total.
  if (rows.length >= limit) throw new Error("Workers Analytics page may be truncated");

  let requests = 0;
  let latestRt2Minute: number | null = null;
  for (const row of rows) {
    if (!isRecord(row) || !isRecord(row.sum) || !isRecord(row.dimensions)) {
      throw new Error("Invalid Workers Analytics row");
    }
    const count = row.sum.requests;
    const datetime = row.dimensions.datetime;
    const rowScriptName = row.dimensions.scriptName;
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
      || typeof datetime !== "string" || typeof rowScriptName !== "string"
    ) throw new Error("Invalid Workers Analytics value");
    const timestamp = Date.parse(datetime);
    if (
      !Number.isFinite(timestamp) || timestamp < startMs || timestamp > nowMs
      || requests > Number.MAX_SAFE_INTEGER - count
    ) throw new Error("Invalid Workers Analytics timestamp or count");
    requests += count;
    if (rowScriptName === scriptName) {
      const minute = Math.floor(timestamp / MINUTE_MS) * MINUTE_MS;
      latestRt2Minute = latestRt2Minute === null ? minute : Math.max(latestRt2Minute, minute);
    }
  }

  if (latestRt2Minute === null) return unavailableSnapshot();
  return {
    // Workers fields are documented, but the requested DO fields are not. Keep
    // the useful partial sample while marking the complete budget snapshot unavailable.
    status: "unavailable",
    metrics: {
      worker_requests: { used: requests, observedThrough: latestRt2Minute },
    },
  };
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
      metricsQuery(input.accountId, start, end, limit),
      controller.signal,
    );
    return parseWorkerUsage(
      metricsEnvelope,
      input.rt2ScriptName,
      input.startMs,
      input.nowMs,
      limit,
    );
  })();

  try {
    return await Promise.race([operation, timedOut]);
  } catch {
    return errorSnapshot();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Calculate the Durable Objects request billing formula from normalized evidence.
 * The GraphQL provider does not publish the inbound-message field required to
 * populate this value, so this helper is not used to fabricate a live metric.
 */
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

/** Convert active time to GB-s using Cloudflare's 128 MB allocation per second. */
export function calculateDoGbSeconds(activeTimeSeconds: number): number {
  if (!Number.isFinite(activeTimeSeconds) || activeTimeSeconds < 0) {
    throw new RangeError("Active time must be finite and non-negative");
  }
  const gbSeconds = activeTimeSeconds * (128 / 1_024);
  if (!Number.isFinite(gbSeconds)) throw new RangeError("GB-s total is invalid");
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
