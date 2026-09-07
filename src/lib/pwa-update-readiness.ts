// Shared schema/validator for the PWA update readiness state exposed on
// `window.__SNOTE_PWA_UPDATE_STATE__`. Used by:
//   - <PwaUpdateDebugPanel> to gate mounting on a fully valid object.
//   - src/lib/pwa-update.ts as the source-of-truth type (no drift).
//   - E2E specs (via `window.__SNOTE_PWA_READINESS_VALIDATE__` in DEV).

export type PwaReloadStrategy = "waiting-sw" | "hard" | null;

export type PwaUpdateReadinessState = {
  currentBuildId: string;
  pendingBuildId: string | null;
  updateAvailable: boolean;
  updateInProgress: boolean;
  reloadAttemptCount: number;
  reloadStrategy: PwaReloadStrategy;
  lastRemoteBuildId?: string | null;
  lastAcceptedAt?: number | null;
};

const RELOAD_STRATEGIES = new Set(["waiting-sw", "hard"]);

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

export type PwaReadinessInvalidReason = {
  /** Field name that failed validation (e.g. "reloadStrategy" or "<root>"). */
  field: string;
  /** Alias of `field`, kept for QA/E2E consumers that use dot-path naming. */
  path: string;
  /** Human-readable reason the field is invalid. */
  reason: string;
  /** Runtime typeof / stringified value received. */
  received: string;
};

function mk(field: string, reason: string, received: string): PwaReadinessInvalidReason {
  return { field, path: field, reason, received };
}

/** Returns null when valid; otherwise a single reason describing the first
 *  field that failed the schema. */
export function explainPwaReadinessState(input: unknown): PwaReadinessInvalidReason | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return mk("<root>", "not-object", input === null ? "null" : Array.isArray(input) ? "array" : typeof input);
  }
  const s = input as Record<string, unknown>;
  const t = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

  if (typeof s.currentBuildId !== "string" || s.currentBuildId.length === 0)
    return mk("currentBuildId", "must be non-empty string", t(s.currentBuildId));
  if (!isStringOrNull(s.pendingBuildId))
    return mk("pendingBuildId", "must be string|null", t(s.pendingBuildId));
  if (typeof s.updateAvailable !== "boolean")
    return mk("updateAvailable", "must be boolean", t(s.updateAvailable));
  if (typeof s.updateInProgress !== "boolean")
    return mk("updateInProgress", "must be boolean", t(s.updateInProgress));
  if (
    typeof s.reloadAttemptCount !== "number" ||
    !Number.isFinite(s.reloadAttemptCount) ||
    s.reloadAttemptCount < 0 ||
    !Number.isInteger(s.reloadAttemptCount)
  )
    return mk("reloadAttemptCount", "must be non-negative integer", String(s.reloadAttemptCount));
  if (s.reloadStrategy !== null && !(typeof s.reloadStrategy === "string" && RELOAD_STRATEGIES.has(s.reloadStrategy)))
    return mk("reloadStrategy", "must be 'waiting-sw'|'hard'|null", String(s.reloadStrategy));
  if ("lastRemoteBuildId" in s && s.lastRemoteBuildId !== undefined && !isStringOrNull(s.lastRemoteBuildId))
    return mk("lastRemoteBuildId", "must be string|null|undefined", t(s.lastRemoteBuildId));
  if (
    "lastAcceptedAt" in s &&
    s.lastAcceptedAt !== undefined &&
    s.lastAcceptedAt !== null &&
    (typeof s.lastAcceptedAt !== "number" || !Number.isFinite(s.lastAcceptedAt))
  )
    return mk("lastAcceptedAt", "must be number|null|undefined", t(s.lastAcceptedAt));

  return null;
}

export function validatePwaReadinessState(input: unknown): input is PwaUpdateReadinessState {
  return explainPwaReadinessState(input) === null;
}

/** Fire a CustomEvent with the first invalid-field reason. No-op when valid
 *  or when window is unavailable. */
export function emitPwaReadinessInvalidEvent(input: unknown): PwaReadinessInvalidReason | null {
  if (typeof window === "undefined") return null;
  const reason = explainPwaReadinessState(input);
  if (!reason) return null;
  try {
    window.dispatchEvent(
      new CustomEvent<PwaReadinessInvalidEventDetail>(PWA_READINESS_INVALID_EVENT, { detail: reason }),
    );
  } catch {
    /* ignore */
  }
  return reason;
}

/** Fired whenever `window.__SNOTE_PWA_UPDATE_STATE__` is rewritten. */
export const PWA_UPDATE_STATE_EVENT = "snote:pwa-update-state" as const;

/** Canonical event name for readiness-validator rejections. */
export const PWA_READINESS_INVALID_EVENT = "snote:pwa-readiness-invalid" as const;

/** Canonical `detail` shape carried by {@link PWA_READINESS_INVALID_EVENT}.
 *  Alias of {@link PwaReadinessInvalidReason} so consumers can import a
 *  name that reads as "event payload" at the callsite. */
export type PwaReadinessInvalidEventDetail = PwaReadinessInvalidReason;

/** Strongly-typed CustomEvent for listeners:
 *  `window.addEventListener(PWA_READINESS_INVALID_EVENT, (e: PwaReadinessInvalidEvent) => …)` */
export type PwaReadinessInvalidEvent = CustomEvent<PwaReadinessInvalidEventDetail>;

declare global {
  interface WindowEventMap {
    "snote:pwa-readiness-invalid": PwaReadinessInvalidEvent;
    "snote:pwa-update-state": Event;
  }
  interface Window {
    __SNOTE_PWA_APPLY_UPDATE__?: () => void;
    __SNOTE_PWA_SYNC_UPDATE_UI__?: () => void;
  }
}

/** Runtime schema (Zod-compatible surface without adding a dep) plus JSON
 *  Schema (draft-07) for {@link PwaReadinessInvalidEventDetail}. Consumers
 *  can use `PwaReadinessInvalidEventDetailSchema.parse(v)` in tests / at
 *  runtime, or feed the JSON Schema to any generic validator (ajv, etc.). */
export const PwaReadinessInvalidEventDetailJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://note.syrin.online/schemas/pwa-readiness-invalid-event-detail.json",
  title: "PwaReadinessInvalidEventDetail",
  type: "object",
  required: ["field", "path", "reason", "received"],
  additionalProperties: false,
  properties: {
    field: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    received: { type: "string" },
  },
} as const;

export const PwaReadinessInvalidEventDetailSchema = {
  parse(v: unknown): PwaReadinessInvalidEventDetail {
    if (!v || typeof v !== "object")
      throw new TypeError("PwaReadinessInvalidEventDetail: not an object");
    const o = v as Record<string, unknown>;
    for (const k of ["field", "path", "reason"] as const) {
      if (typeof o[k] !== "string" || (o[k] as string).length === 0)
        throw new TypeError(`PwaReadinessInvalidEventDetail: invalid ${k}`);
    }
    if (typeof o.received !== "string")
      throw new TypeError("PwaReadinessInvalidEventDetail: invalid received");
    if (o.field !== o.path)
      throw new TypeError("PwaReadinessInvalidEventDetail: path must equal field");
    return v as PwaReadinessInvalidEventDetail;
  },
  safeParse(v: unknown): { success: true; data: PwaReadinessInvalidEventDetail } | { success: false; error: Error } {
    try {
      return { success: true, data: this.parse(v) };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
} as const;

/** Read the env flag that gates {@link installPwaReadinessInvalidReporter}.
 *  Default: **disabled** — analytics/logging are opt-in so production
 *  clients never ship a reporter unless the deployer explicitly enables it.
 *
 *  Env vars (Vite, prefixed `VITE_` so they're readable client-side):
 *  - `VITE_PWA_READINESS_REPORTER_ENABLED` — `"true"` / `"1"` to enable.
 *    Any other value (including unset) leaves the reporter disabled.
 *  - `VITE_PWA_READINESS_REPORTER_SAMPLE_RATE` — float `0..1`, default `0.01`.
 *    Ignored when the reporter is disabled. */
export function resolvePwaReadinessReporterEnv(): { enabled: boolean; sampleRate: number } {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const raw = String(env.VITE_PWA_READINESS_REPORTER_ENABLED ?? "").toLowerCase();
  const enabled = raw === "true" || raw === "1";
  const parsed = Number(env.VITE_PWA_READINESS_REPORTER_SAMPLE_RATE);
  const sampleRate = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.01;
  return { enabled, sampleRate };
}

/** Optional production-safe reporter. Samples events at the given rate
 *  (0..1) and forwards them to a user-supplied sink (analytics, logger).
 *  No-op if window is unavailable, or when env-gated and disabled. Returns
 *  unsubscribe. Pass `force: true` to bypass the env gate (tests). */
export function installPwaReadinessInvalidReporter(opts: {
  sampleRate?: number;
  sink?: (detail: PwaReadinessInvalidEventDetail) => void;
  rng?: () => number;
  force?: boolean;
} = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const envCfg = resolvePwaReadinessReporterEnv();
  if (!opts.force && !envCfg.enabled) return () => {};
  const rate = Math.max(0, Math.min(1, opts.sampleRate ?? envCfg.sampleRate));
  const rng = opts.rng ?? Math.random;
  const sink =
    opts.sink ??
    ((detail) => {
      try {
        console.warn("[pwa-readiness-invalid]", detail);
      } catch {
        /* ignore */
      }
    });
  const handler = (e: PwaReadinessInvalidEvent) => {
    if (rate <= 0) return;
    if (rate < 1 && rng() >= rate) return;
    const parsed = PwaReadinessInvalidEventDetailSchema.safeParse(e.detail);
    if (!parsed.success) return;
    try {
      sink(parsed.data);
    } catch {
      /* sink must never throw */
    }
  };
  window.addEventListener(PWA_READINESS_INVALID_EVENT, handler);
  return () => window.removeEventListener(PWA_READINESS_INVALID_EVENT, handler);
}

/** Install the validator on window so E2E can call the exact same check. */
export function exposeReadinessValidatorForE2E(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __SNOTE_PWA_READINESS_VALIDATE__?: typeof validatePwaReadinessState;
    __SNOTE_PWA_READINESS_EXPLAIN__?: typeof explainPwaReadinessState;
    __SNOTE_PWA_READINESS_REPORTER_ENV__?: typeof resolvePwaReadinessReporterEnv;
    __SNOTE_PWA_READINESS_INSTALL_REPORTER__?: typeof installPwaReadinessInvalidReporter;
  };
  w.__SNOTE_PWA_READINESS_VALIDATE__ = validatePwaReadinessState;
  w.__SNOTE_PWA_READINESS_EXPLAIN__ = explainPwaReadinessState;
  w.__SNOTE_PWA_READINESS_REPORTER_ENV__ = resolvePwaReadinessReporterEnv;
  w.__SNOTE_PWA_READINESS_INSTALL_REPORTER__ = installPwaReadinessInvalidReporter;
}
