BEGIN;

-- Versioned K-based topology and shared report-triggered hub health monitor.
-- This migration is exercised only by isolated local SQL tests in PGlite.
-- It must not be applied to a hosted or production database by this PR.
SELECT pg_advisory_xact_lock(20261010000000);

CREATE TABLE public.realtime_topology_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL CHECK (version >= 1),
  assignment_epoch bigint NOT NULL CHECK (assignment_epoch >= 1),
  min_fallback_bp integer NOT NULL
    CHECK (min_fallback_bp BETWEEN 100 AND 1000),
  hubs jsonb NOT NULL CHECK (jsonb_typeof(hubs) = 'object'),
  ramp jsonb NOT NULL CHECK (jsonb_typeof(ramp) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid,
  update_reason text,
  CONSTRAINT realtime_topology_config_update_metadata CHECK (
    (updated_by IS NULL AND update_reason IS NULL)
    OR (updated_by IS NOT NULL AND length(btrim(update_reason)) BETWEEN 1 AND 500)
  )
);

COMMENT ON TABLE public.realtime_topology_config IS
  'Single shared, versioned K1 topology row; only service-role RPCs may read or change it.';
COMMENT ON COLUMN public.realtime_topology_config.hubs IS
  'Hub-ID keyed K1 settings including weights, enable/drain flags, probe, budget, and capacity; no room identifiers.';
COMMENT ON COLUMN public.realtime_topology_config.assignment_epoch IS
  'Monotonic global epoch; every accepted topology edit increments it and invalidates old assignments.';
COMMENT ON COLUMN public.realtime_topology_config.ramp IS
  'Versioned failback canary, step, and interval parameters from K1.';

CREATE TABLE public.realtime_topology_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  changed_by uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  emergency_override boolean NOT NULL DEFAULT false,
  old_version bigint NOT NULL,
  new_version bigint NOT NULL,
  old_assignment_epoch bigint NOT NULL,
  new_assignment_epoch bigint NOT NULL,
  old_min_fallback_bp integer NOT NULL,
  new_min_fallback_bp integer NOT NULL,
  old_hubs jsonb NOT NULL,
  new_hubs jsonb NOT NULL,
  old_ramp jsonb NOT NULL,
  new_ramp jsonb NOT NULL,
  CONSTRAINT realtime_topology_audit_version_increases CHECK (new_version = old_version + 1),
  CONSTRAINT realtime_topology_audit_epoch_increases CHECK (
    new_assignment_epoch = old_assignment_epoch + 1
  )
);

COMMENT ON TABLE public.realtime_topology_audit IS
  'Append-only audit snapshots for service-authorized topology changes; actor is an opaque user UUID, not PII.';

CREATE TABLE public.realtime_hub_health_state (
  hub_id text PRIMARY KEY CHECK (hub_id IN ('rt1', 'rt2')),
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'down')),
  checked_at timestamptz,
  down_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  state_changed_at timestamptz,
  probe_lease_id uuid,
  probe_lease_until timestamptz,
  CONSTRAINT realtime_hub_health_down_deadline CHECK (
    (health_status = 'down' AND down_until IS NOT NULL)
    OR (health_status <> 'down' AND down_until IS NULL)
  ),
  CONSTRAINT realtime_hub_health_lease_pair CHECK (
    (probe_lease_id IS NULL AND probe_lease_until IS NULL)
    OR (probe_lease_id IS NOT NULL AND probe_lease_until IS NOT NULL)
  )
);

COMMENT ON TABLE public.realtime_hub_health_state IS
  'Shared per-hub status/cache/down-TTL and 10-second monitor lease; stores no room, ticket, slug, or IP.';

INSERT INTO public.realtime_topology_config (
  singleton,
  version,
  assignment_epoch,
  min_fallback_bp,
  hubs,
  ramp
) VALUES (
  true,
  1,
  1,
  1000,
  '{
    "rt1": {
      "weight_bp": 0,
      "enabled": false,
      "drain": false,
      "probe": {
        "timeout_ms": 2000,
        "retry_count": 1,
        "retry_delay_ms": 1000,
        "down_ttl_seconds": 60,
        "probe_cache_ttl_seconds": 10,
        "probe_on_report": true,
        "probe_before_assign": true
      },
      "budget_profile": "none",
      "budget_thresholds": null,
      "unit_prices": null,
      "billing_cycle_started_at": null,
      "max_active_rooms": null
    },
    "rt2": {
      "weight_bp": 0,
      "enabled": false,
      "drain": false,
      "probe": {
        "timeout_ms": 2000,
        "retry_count": 1,
        "retry_delay_ms": 1000,
        "down_ttl_seconds": 60,
        "probe_cache_ttl_seconds": 60,
        "probe_on_report": true,
        "probe_before_assign": false
      },
      "budget_profile": null,
      "budget_thresholds": null,
      "unit_prices": null,
      "billing_cycle_started_at": null,
      "max_active_rooms": null
    }
  }'::jsonb,
  '{"canary_bp":500,"step_bp":1000,"interval_seconds":300}'::jsonb
);

INSERT INTO public.realtime_hub_health_state (hub_id)
VALUES ('rt1'), ('rt2');

ALTER TABLE public.realtime_topology_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_topology_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_hub_health_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.realtime_topology_config,
  public.realtime_topology_audit,
  public.realtime_hub_health_state
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.realtime_topology_budget_values_valid(
  p_values jsonb,
  p_allow_zero boolean
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_entry record;
  v_numeric numeric;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object'
    OR p_values = '{}'::jsonb OR p_allow_zero IS NULL
  THEN
    RETURN false;
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_each(p_values) LOOP
    IF jsonb_typeof(v_entry.value) = 'object' THEN
      IF NOT public.realtime_topology_budget_values_valid(v_entry.value, p_allow_zero) THEN
        RETURN false;
      END IF;
    ELSIF jsonb_typeof(v_entry.value) = 'number'
      AND (v_entry.value #>> '{}') ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
    THEN
      v_numeric := (v_entry.value #>> '{}')::numeric;
      IF (p_allow_zero AND v_numeric < 0) OR (NOT p_allow_zero AND v_numeric <= 0) THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_topology_timestamp_valid(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_timestamp timestamptz;
BEGIN
  IF p_value IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_value) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(p_value) <> 'string'
    OR p_value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN
    RETURN false;
  END IF;
  BEGIN
    v_timestamp := (p_value #>> '{}')::timestamptz;
    RETURN v_timestamp IS NOT NULL;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_topology_hubs_valid(
  p_min_fallback_bp integer,
  p_hubs jsonb,
  p_ramp jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hub_ids text[];
  v_hub_id text;
  v_hub jsonb;
  v_probe jsonb;
  v_weight_text text;
  v_weight integer;
  v_rt1_weight integer;
  v_rt2_weight integer;
  v_rt1_enabled boolean;
  v_rt2_enabled boolean;
  v_profile jsonb;
  v_value jsonb;
  v_field text;
BEGIN
  IF p_min_fallback_bp IS NULL
    OR p_min_fallback_bp NOT BETWEEN 100 AND 1000
    OR p_hubs IS NULL
    OR jsonb_typeof(p_hubs) <> 'object'
    OR p_ramp IS NULL
    OR jsonb_typeof(p_ramp) <> 'object'
    OR NOT (p_ramp ?& ARRAY['canary_bp', 'step_bp', 'interval_seconds'])
  THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_ramp -> 'canary_bp') <> 'number'
    OR (p_ramp ->> 'canary_bp') !~ '^[1-9][0-9]{0,4}$'
    OR (p_ramp ->> 'canary_bp')::integer > 10000
    OR jsonb_typeof(p_ramp -> 'step_bp') <> 'number'
    OR (p_ramp ->> 'step_bp') !~ '^[1-9][0-9]{0,4}$'
    OR (p_ramp ->> 'step_bp')::integer > 10000
    OR jsonb_typeof(p_ramp -> 'interval_seconds') <> 'number'
    OR (p_ramp ->> 'interval_seconds') !~ '^[1-9][0-9]{0,9}$'
    OR (p_ramp ->> 'interval_seconds')::bigint > 2147483647
  THEN
    RETURN false;
  END IF;

  SELECT array_agg(key ORDER BY key)
  INTO v_hub_ids
  FROM jsonb_object_keys(p_hubs) AS keys(key);
  IF v_hub_ids IS DISTINCT FROM ARRAY['rt1', 'rt2']::text[] THEN
    RETURN false;
  END IF;

  FOREACH v_hub_id IN ARRAY v_hub_ids LOOP
    v_hub := p_hubs -> v_hub_id;
    IF NOT (v_hub ?& ARRAY[
      'weight_bp',
      'enabled',
      'drain',
      'probe',
      'budget_profile',
      'budget_thresholds',
      'unit_prices',
      'billing_cycle_started_at',
      'max_active_rooms'
    ]) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v_hub) <> 'object'
      OR jsonb_typeof(v_hub -> 'weight_bp') <> 'number'
      OR jsonb_typeof(v_hub -> 'enabled') <> 'boolean'
      OR jsonb_typeof(v_hub -> 'drain') <> 'boolean'
      OR jsonb_typeof(v_hub -> 'probe') <> 'object'
      OR jsonb_typeof(v_hub -> 'budget_profile') NOT IN ('null', 'string')
      OR jsonb_typeof(v_hub -> 'budget_thresholds') NOT IN ('null', 'object')
      OR jsonb_typeof(v_hub -> 'unit_prices') NOT IN ('null', 'object')
      OR NOT public.realtime_topology_timestamp_valid(v_hub -> 'billing_cycle_started_at')
      OR jsonb_typeof(v_hub -> 'max_active_rooms') NOT IN ('null', 'number')
    THEN
      RETURN false;
    END IF;

    v_weight_text := v_hub ->> 'weight_bp';
    IF v_weight_text !~ '^(0|[1-9][0-9]{0,4})$' THEN
      RETURN false;
    END IF;
    v_weight := v_weight_text::integer;
    IF v_weight NOT BETWEEN 0 AND 10000 THEN
      RETURN false;
    END IF;
    IF v_hub_id = 'rt1' THEN
      v_rt1_weight := v_weight;
      v_rt1_enabled := (v_hub ->> 'enabled')::boolean;
    ELSE
      v_rt2_weight := v_weight;
      v_rt2_enabled := (v_hub ->> 'enabled')::boolean;
    END IF;

    v_value := v_hub -> 'max_active_rooms';
    IF jsonb_typeof(v_value) = 'number'
      AND ((v_value #>> '{}') !~ '^[1-9][0-9]{0,8}$'
        OR (v_value #>> '{}')::integer <= 0)
    THEN
      RETURN false;
    END IF;

    v_profile := v_hub -> 'budget_profile';
    IF jsonb_typeof(v_profile) = 'string'
      AND v_profile #>> '{}' NOT IN ('none', 'cf_free_daily', 'cf_paid_monthly')
    THEN
      RETURN false;
    END IF;
    FOREACH v_field IN ARRAY ARRAY['budget_thresholds', 'unit_prices'] LOOP
      v_value := v_hub -> v_field;
      IF jsonb_typeof(v_value) = 'object'
        AND NOT public.realtime_topology_budget_values_valid(
          v_value,
          v_field = 'unit_prices'
        )
      THEN
        RETURN false;
      END IF;
    END LOOP;

    v_probe := v_hub -> 'probe';
    IF NOT (v_probe ?& ARRAY[
      'timeout_ms',
      'retry_count',
      'retry_delay_ms',
      'down_ttl_seconds',
      'probe_cache_ttl_seconds',
      'probe_on_report',
      'probe_before_assign'
    ]) THEN
      RETURN false;
    END IF;
    FOREACH v_field IN ARRAY ARRAY[
      'timeout_ms',
      'retry_count',
      'retry_delay_ms',
      'down_ttl_seconds',
      'probe_cache_ttl_seconds'
    ] LOOP
      IF jsonb_typeof(v_probe -> v_field) <> 'number'
        OR (v_probe ->> v_field) !~ '^(0|[1-9][0-9]{0,4})$'
      THEN
        RETURN false;
      END IF;
    END LOOP;

    IF v_probe ->> 'timeout_ms' <> '2000'
      OR v_probe ->> 'retry_count' <> '1'
      OR v_probe ->> 'retry_delay_ms' <> '1000'
      OR v_probe ->> 'down_ttl_seconds' <> '60'
      OR v_probe ->> 'probe_cache_ttl_seconds' NOT IN ('10', '60')
      OR jsonb_typeof(v_probe -> 'probe_on_report') <> 'boolean'
      OR jsonb_typeof(v_probe -> 'probe_before_assign') <> 'boolean'
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF NOT v_rt1_enabled AND NOT v_rt2_enabled THEN
    RETURN v_rt1_weight = 0 AND v_rt2_weight = 0;
  ELSIF v_rt1_enabled AND NOT v_rt2_enabled THEN
    RETURN v_rt1_weight = 10000 AND v_rt2_weight = 0;
  ELSIF v_rt2_enabled AND NOT v_rt1_enabled THEN
    RETURN v_rt1_weight = 0 AND v_rt2_weight = 10000;
  END IF;

  RETURN v_rt1_weight + v_rt2_weight = 10000
    AND v_rt1_weight BETWEEN p_min_fallback_bp AND 10000 - p_min_fallback_bp
    AND v_rt2_weight BETWEEN p_min_fallback_bp AND 10000 - p_min_fallback_bp;
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_topology_read()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'status', 'ok',
    'version', c.version,
    'assignmentEpoch', c.assignment_epoch,
    'minFallbackBp', c.min_fallback_bp,
    'hubConfig', c.hubs,
    'ramp', c.ramp,
    'hub2NewRoomAdmissionReady', CASE
      WHEN (c.hubs -> 'rt2' ->> 'enabled')::boolean
        AND NOT (c.hubs -> 'rt2' ->> 'drain')::boolean
        AND (c.hubs -> 'rt2' ->> 'weight_bp')::integer > 0
        AND c.hubs -> 'rt2' ->> 'budget_profile' IN ('cf_free_daily', 'cf_paid_monthly')
        AND public.realtime_topology_budget_values_valid(
          c.hubs -> 'rt2' -> 'budget_thresholds', false
        )
        AND public.realtime_topology_budget_values_valid(
          c.hubs -> 'rt2' -> 'unit_prices', true
        )
        AND (c.hubs -> 'rt2' ->> 'max_active_rooms') IS NOT NULL
        AND (c.hubs -> 'rt2' ->> 'max_active_rooms')::integer > 0
        AND (
          c.hubs -> 'rt2' ->> 'budget_profile' <> 'cf_paid_monthly'
          OR c.hubs -> 'rt2' -> 'billing_cycle_started_at' <> 'null'::jsonb
        )
      THEN true ELSE false END,
    'updatedAt', c.updated_at,
    'updatedBy', c.updated_by
  )
  FROM public.realtime_topology_config AS c
  WHERE c.singleton
$$;

CREATE OR REPLACE FUNCTION public.realtime_topology_update(
  p_expected_version bigint,
  p_min_fallback_bp integer,
  p_hubs jsonb,
  p_ramp jsonb,
  p_actor_id uuid,
  p_reason text,
  p_emergency_override boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_current public.realtime_topology_config%ROWTYPE;
  v_new_version bigint;
  v_new_epoch bigint;
  v_hub_id text;
  v_old_weight integer;
  v_new_weight integer;
BEGIN
  IF p_expected_version IS NULL
    OR p_min_fallback_bp IS NULL
    OR p_actor_id IS NULL
    OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
    OR p_emergency_override IS NULL
    OR NOT public.realtime_topology_hubs_valid(p_min_fallback_bp, p_hubs, p_ramp)
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.*
  INTO v_current
  FROM public.realtime_topology_config AS c
  WHERE c.singleton
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF p_expected_version <> v_current.version THEN
    RETURN jsonb_build_object(
      'status', 'version_conflict',
      'version', v_current.version,
      'assignmentEpoch', v_current.assignment_epoch
    );
  END IF;

  IF p_min_fallback_bp = v_current.min_fallback_bp
    AND p_hubs = v_current.hubs
    AND p_ramp = v_current.ramp
  THEN
    RETURN jsonb_build_object(
      'status', 'unchanged',
      'version', v_current.version,
      'assignmentEpoch', v_current.assignment_epoch
    );
  END IF;

  FOREACH v_hub_id IN ARRAY ARRAY['rt1', 'rt2']::text[] LOOP
    v_old_weight := (v_current.hubs -> v_hub_id ->> 'weight_bp')::integer;
    v_new_weight := (p_hubs -> v_hub_id ->> 'weight_bp')::integer;
    IF abs(v_new_weight - v_old_weight) > 2500 AND NOT p_emergency_override THEN
      RETURN jsonb_build_object(
        'status', 'emergency_override_required',
        'hubId', v_hub_id
      );
    END IF;
  END LOOP;

  UPDATE public.realtime_topology_config AS c
  SET version = c.version + 1,
      assignment_epoch = c.assignment_epoch + 1,
      min_fallback_bp = p_min_fallback_bp,
      hubs = p_hubs,
      ramp = p_ramp,
      updated_at = clock_timestamp(),
      updated_by = p_actor_id,
      update_reason = btrim(p_reason)
  WHERE c.singleton
  RETURNING c.version, c.assignment_epoch
  INTO v_new_version, v_new_epoch;

  INSERT INTO public.realtime_topology_audit (
    changed_by,
    reason,
    emergency_override,
    old_version,
    new_version,
    old_assignment_epoch,
    new_assignment_epoch,
    old_min_fallback_bp,
    new_min_fallback_bp,
    old_hubs,
    new_hubs,
    old_ramp,
    new_ramp
  ) VALUES (
    p_actor_id,
    btrim(p_reason),
    p_emergency_override,
    v_current.version,
    v_new_version,
    v_current.assignment_epoch,
    v_new_epoch,
    v_current.min_fallback_bp,
    p_min_fallback_bp,
    v_current.hubs,
    p_hubs,
    v_current.ramp,
    p_ramp
  );

  RETURN jsonb_build_object(
    'status', 'updated',
    'version', v_new_version,
    'assignmentEpoch', v_new_epoch,
    'minFallbackBp', p_min_fallback_bp
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_hub_down_ttl_active(
  p_down_until timestamptz,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_down_until IS NOT NULL AND p_at IS NOT NULL AND p_down_until > p_at
$$;

CREATE OR REPLACE FUNCTION public.realtime_hub_probe_claim(
  p_hub_id text,
  p_assignment_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_config public.realtime_topology_config%ROWTYPE;
  v_state public.realtime_hub_health_state%ROWTYPE;
  v_hub jsonb;
  v_probe jsonb;
  v_cache_ttl_seconds integer;
  v_now timestamptz := clock_timestamp();
  v_lease_id uuid;
BEGIN
  IF p_hub_id IS NULL OR p_assignment_epoch IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.* INTO v_config
  FROM public.realtime_topology_config AS c
  WHERE c.singleton;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF p_assignment_epoch <> v_config.assignment_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_epoch',
      'assignmentEpoch', v_config.assignment_epoch
    );
  END IF;
  IF NOT (v_config.hubs ? p_hub_id) THEN
    RETURN jsonb_build_object('status', 'invalid_hub');
  END IF;

  v_hub := v_config.hubs -> p_hub_id;
  v_probe := v_hub -> 'probe';
  IF (v_probe ->> 'probe_on_report')::boolean IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('status', 'probe_disabled');
  END IF;
  v_cache_ttl_seconds := (v_probe ->> 'probe_cache_ttl_seconds')::integer;

  UPDATE public.realtime_hub_health_state AS h
  SET health_status = 'unknown',
      down_until = NULL,
      state_version = h.state_version + 1,
      state_changed_at = v_now
  WHERE h.hub_id = p_hub_id
    AND h.health_status = 'down'
    AND NOT public.realtime_hub_down_ttl_active(h.down_until, v_now);

  UPDATE public.realtime_hub_health_state AS h
  SET probe_lease_id = gen_random_uuid(),
      probe_lease_until = v_now + interval '10 seconds'
  WHERE h.hub_id = p_hub_id
    AND (h.probe_lease_until IS NULL OR h.probe_lease_until <= v_now)
    AND (
      h.health_status <> 'down'
      OR NOT public.realtime_hub_down_ttl_active(h.down_until, v_now)
    )
    AND (
      h.checked_at IS NULL
      OR h.checked_at + (v_cache_ttl_seconds * interval '1 second') <= v_now
    )
  RETURNING h.probe_lease_id INTO v_lease_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'probe_started',
      'hubId', p_hub_id,
      'assignmentEpoch', v_config.assignment_epoch,
      'leaseId', v_lease_id,
      'leaseSeconds', 10
    );
  END IF;

  SELECT h.* INTO v_state
  FROM public.realtime_hub_health_state AS h
  WHERE h.hub_id = p_hub_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_hub');
  END IF;

  IF v_state.health_status = 'down'
    AND public.realtime_hub_down_ttl_active(v_state.down_until, v_now)
  THEN
    RETURN jsonb_build_object(
      'status', 'down_cached',
      'hubId', p_hub_id,
      'downUntil', v_state.down_until,
      'stateVersion', v_state.state_version
    );
  END IF;
  IF v_state.checked_at IS NOT NULL
    AND v_state.checked_at + (v_cache_ttl_seconds * interval '1 second') > v_now
  THEN
    RETURN jsonb_build_object(
      'status', CASE WHEN v_state.health_status = 'healthy'
        THEN 'healthy_cached' ELSE 'health_cached' END,
      'hubId', p_hub_id,
      'checkedAt', v_state.checked_at,
      'stateVersion', v_state.state_version
    );
  END IF;
  IF v_state.probe_lease_until IS NOT NULL AND v_state.probe_lease_until > v_now THEN
    RETURN jsonb_build_object(
      'status', 'lease_held',
      'hubId', p_hub_id,
      'leaseUntil', v_state.probe_lease_until
    );
  END IF;

  RETURN jsonb_build_object('status', 'probe_unavailable', 'hubId', p_hub_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_hub_probe_complete(
  p_hub_id text,
  p_assignment_epoch bigint,
  p_lease_id uuid,
  p_probe_succeeded boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_config public.realtime_topology_config%ROWTYPE;
  v_hub jsonb;
  v_down_ttl_seconds integer;
  v_now timestamptz := clock_timestamp();
  v_state public.realtime_hub_health_state%ROWTYPE;
BEGIN
  IF p_hub_id IS NULL
    OR p_assignment_epoch IS NULL
    OR p_lease_id IS NULL
    OR p_probe_succeeded IS NULL
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.* INTO v_config
  FROM public.realtime_topology_config AS c
  WHERE c.singleton;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF p_assignment_epoch <> v_config.assignment_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_epoch',
      'assignmentEpoch', v_config.assignment_epoch
    );
  END IF;
  IF NOT (v_config.hubs ? p_hub_id) THEN
    RETURN jsonb_build_object('status', 'invalid_hub');
  END IF;
  v_hub := v_config.hubs -> p_hub_id;
  v_down_ttl_seconds := (v_hub -> 'probe' ->> 'down_ttl_seconds')::integer;

  UPDATE public.realtime_hub_health_state AS h
  SET health_status = CASE WHEN p_probe_succeeded THEN 'healthy' ELSE 'down' END,
      checked_at = v_now,
      down_until = CASE WHEN p_probe_succeeded THEN NULL
        ELSE v_now + (v_down_ttl_seconds * interval '1 second') END,
      consecutive_failures = CASE WHEN p_probe_succeeded THEN 0
        ELSE h.consecutive_failures + 1 END,
      state_version = h.state_version + CASE
        WHEN h.health_status IS DISTINCT FROM CASE
          WHEN p_probe_succeeded THEN 'healthy' ELSE 'down' END
          OR h.down_until IS DISTINCT FROM CASE WHEN p_probe_succeeded THEN NULL
            ELSE v_now + (v_down_ttl_seconds * interval '1 second') END
        THEN 1 ELSE 0 END,
      state_changed_at = CASE
        WHEN h.health_status IS DISTINCT FROM CASE
          WHEN p_probe_succeeded THEN 'healthy' ELSE 'down' END
          OR h.down_until IS DISTINCT FROM CASE WHEN p_probe_succeeded THEN NULL
            ELSE v_now + (v_down_ttl_seconds * interval '1 second') END
        THEN v_now ELSE h.state_changed_at END,
      probe_lease_id = NULL,
      probe_lease_until = NULL
  WHERE h.hub_id = p_hub_id
    AND h.probe_lease_id = p_lease_id
    AND h.probe_lease_until > v_now
  RETURNING h.* INTO v_state;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'stale_lease');
  END IF;

  RETURN jsonb_build_object(
    'status', 'accepted',
    'hubId', p_hub_id,
    'healthStatus', v_state.health_status,
    'checkedAt', v_state.checked_at,
    'downUntil', v_state.down_until,
    'consecutiveFailures', v_state.consecutive_failures,
    'stateVersion', v_state.state_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_hub_health_read(
  p_hub_id text,
  p_assignment_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_config public.realtime_topology_config%ROWTYPE;
  v_state public.realtime_hub_health_state%ROWTYPE;
  v_effective_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_hub_id IS NULL OR p_assignment_epoch IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.* INTO v_config
  FROM public.realtime_topology_config AS c
  WHERE c.singleton;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF p_assignment_epoch <> v_config.assignment_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_epoch',
      'assignmentEpoch', v_config.assignment_epoch
    );
  END IF;
  IF NOT (v_config.hubs ? p_hub_id) THEN
    RETURN jsonb_build_object('status', 'invalid_hub');
  END IF;

  SELECT h.* INTO v_state
  FROM public.realtime_hub_health_state AS h
  WHERE h.hub_id = p_hub_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid_hub');
  END IF;

  v_effective_status := CASE
    WHEN v_state.health_status = 'down'
      AND NOT public.realtime_hub_down_ttl_active(v_state.down_until, v_now)
    THEN 'unknown'
    ELSE v_state.health_status
  END;

  RETURN jsonb_build_object(
    'status', 'ok',
    'hubId', p_hub_id,
    'assignmentEpoch', v_config.assignment_epoch,
    'healthStatus', v_effective_status,
    'checkedAt', v_state.checked_at,
    'downUntil', v_state.down_until,
    'consecutiveFailures', v_state.consecutive_failures,
    'stateVersion', v_state.state_version,
    'probeLeaseActive', v_state.probe_lease_until IS NOT NULL
      AND v_state.probe_lease_until > v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_topology_hubs_valid(integer, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_topology_budget_values_valid(jsonb, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_topology_timestamp_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_hub_down_ttl_active(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_topology_read()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_topology_update(
  bigint, integer, jsonb, jsonb, uuid, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_hub_probe_claim(text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_hub_probe_complete(text, bigint, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_hub_health_read(text, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.realtime_hub_down_ttl_active(timestamptz, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topology_read()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topology_hubs_valid(integer, jsonb, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topology_budget_values_valid(jsonb, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topology_timestamp_valid(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topology_update(
  bigint, integer, jsonb, jsonb, uuid, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_hub_probe_claim(text, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_hub_probe_complete(text, bigint, uuid, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_hub_health_read(text, bigint)
  TO service_role;

COMMENT ON FUNCTION public.realtime_topology_update(
  bigint, integer, jsonb, jsonb, uuid, text, boolean
) IS
  'Service-role-only optimistic full-K1 topology edit. Validates weights, ramp, enable/drain, probe, budget and capacity fields, increments version and assignment epoch atomically, and appends old/new audit snapshots. The trusted Edge caller must authenticate Syringa before calling.';
COMMENT ON FUNCTION public.realtime_hub_probe_claim(text, bigint) IS
  'Service-role-only report-triggered shared monitor lease claim. Call only after Edge validates the ticket/session, expiry, report and current assignment epoch; one live probe lease per hub is limited to 10 seconds.';
COMMENT ON FUNCTION public.realtime_hub_probe_complete(text, bigint, uuid, boolean) IS
  'Service-role-only idempotent completion for one aggregate probe round. The Edge performs the configured timeout/retry; only the current lease may set health and the 60-second down TTL.';

COMMIT;
