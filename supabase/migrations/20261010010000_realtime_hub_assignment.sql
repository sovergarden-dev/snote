BEGIN;

-- Additive K2 room assignment state and the narrowly-scoped first activation
-- exception. This migration is exercised only in isolated local SQL tests;
-- this PR must not apply it to a hosted or production database.
SELECT pg_advisory_xact_lock(20261010010000);

CREATE TABLE public.realtime_room_assignment (
  room_key_hash text PRIMARY KEY
    CHECK (room_key_hash ~ '^[0-9a-f]{64}$'),
  bucket integer NOT NULL CHECK (bucket BETWEEN 0 AND 9999),
  hub_id text NOT NULL CHECK (hub_id IN ('rt1', 'rt2', 'slow')),
  assignment_epoch bigint NOT NULL CHECK (assignment_epoch >= 1),
  topology_epoch bigint NOT NULL CHECK (topology_epoch >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX realtime_room_assignment_last_seen_idx
  ON public.realtime_room_assignment (last_seen_at);

COMMENT ON TABLE public.realtime_room_assignment IS
  'Per-room K2 assignment keyed only by SHA-256 of the opaque room ID; never stores a slug, ticket, IP, or raw room ID.';
COMMENT ON COLUMN public.realtime_room_assignment.assignment_epoch IS
  'Per-room monotonic epoch; unchanged rooms retain this epoch when the global topology epoch changes.';
COMMENT ON COLUMN public.realtime_room_assignment.topology_epoch IS
  'Global topology version used for the most recent accepted routing decision.';
COMMENT ON COLUMN public.realtime_room_assignment.last_seen_at IS
  'Refreshed on successful ticket/report assignment RPCs; inactive rows become GC-eligible after 90 days.';

ALTER TABLE public.realtime_room_assignment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.realtime_room_assignment
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.realtime_room_assignment_gc_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_run_at timestamptz NOT NULL
);
COMMENT ON TABLE public.realtime_room_assignment_gc_state IS
  'Single-row service-only throttle for bounded assignment TTL cleanup; stores no room identifiers.';
INSERT INTO public.realtime_room_assignment_gc_state (singleton, next_run_at)
VALUES (true, '-infinity'::timestamptz);
ALTER TABLE public.realtime_room_assignment_gc_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.realtime_room_assignment_gc_state
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.realtime_room_assignment_cleanup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_removed integer := 0;
BEGIN
  UPDATE public.realtime_room_assignment_gc_state AS g
  SET next_run_at = v_now + interval '10 minutes'
  WHERE g.singleton AND g.next_run_at <= v_now;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH stale AS (
    SELECT a.room_key_hash
    FROM public.realtime_room_assignment AS a
    WHERE a.last_seen_at < v_now - interval '90 days'
    ORDER BY a.last_seen_at
    FOR UPDATE SKIP LOCKED
    LIMIT 100
  )
  DELETE FROM public.realtime_room_assignment AS a
  USING stale
  WHERE a.room_key_hash = stale.room_key_hash;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_room_assignment_cleanup()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.realtime_room_assignment_cleanup() TO service_role;
COMMENT ON FUNCTION public.realtime_room_assignment_cleanup() IS
  'Best-effort bounded GC: removes at most 100 assignments inactive for 90 days, at most once every 10 minutes; invoked only after a successful assignment RPC.';

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
  v_initial_activation boolean := false;
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

  -- Only the first audited transition away from the exact disabled 0/0 seed
  -- is exempt. Any earlier edit, enabled hub, nonzero weight, or prior audit
  -- makes the normal emergency-override rule apply.
  IF v_current.version = 1 AND v_current.assignment_epoch = 1 THEN
    v_initial_activation :=
      v_current.hubs -> 'rt1' ->> 'enabled' = 'false'
      AND (v_current.hubs -> 'rt1' ->> 'weight_bp')::integer = 0
      AND v_current.hubs -> 'rt2' ->> 'enabled' = 'false'
      AND (v_current.hubs -> 'rt2' ->> 'weight_bp')::integer = 0
      AND NOT EXISTS (SELECT 1 FROM public.realtime_topology_audit)
      AND (
        (p_hubs -> 'rt1' ->> 'enabled' = 'true'
          AND (p_hubs -> 'rt1' ->> 'weight_bp')::integer > 0)
        OR
        (p_hubs -> 'rt2' ->> 'enabled' = 'true'
          AND (p_hubs -> 'rt2' ->> 'weight_bp')::integer > 0)
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
    IF abs(v_new_weight - v_old_weight) > 2500
      AND NOT p_emergency_override
      AND NOT v_initial_activation
    THEN
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
    'minFallbackBp', p_min_fallback_bp,
    'initialActivationException', v_initial_activation
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_room_assignment_read(
  p_room_key_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_assignment public.realtime_room_assignment%ROWTYPE;
BEGIN
  IF p_room_key_hash IS NULL OR p_room_key_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT a.* INTO v_assignment
  FROM public.realtime_room_assignment AS a
  WHERE a.room_key_hash = p_room_key_hash;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unassigned');
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'bucket', v_assignment.bucket,
    'hubId', v_assignment.hub_id,
    'assignmentEpoch', v_assignment.assignment_epoch,
    'topologyEpoch', v_assignment.topology_epoch,
    'updatedAt', v_assignment.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.realtime_room_assignment_apply(
  p_room_key_hash text,
  p_bucket integer,
  p_target_hub_id text,
  p_topology_epoch bigint,
  p_expected_assignment_epoch bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_config public.realtime_topology_config%ROWTYPE;
  v_assignment public.realtime_room_assignment%ROWTYPE;
  v_health public.realtime_hub_health_state%ROWTYPE;
  v_inserted boolean;
  v_hub jsonb;
BEGIN
  IF p_room_key_hash IS NULL
    OR p_room_key_hash !~ '^[0-9a-f]{64}$'
    OR p_bucket IS NULL
    OR p_bucket NOT BETWEEN 0 AND 9999
    OR p_target_hub_id IS NULL
    OR p_target_hub_id NOT IN ('rt1', 'rt2', 'slow')
    OR p_topology_epoch IS NULL
    OR p_topology_epoch < 1
    OR (p_expected_assignment_epoch IS NOT NULL AND p_expected_assignment_epoch < 1)
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.* INTO v_config
  FROM public.realtime_topology_config AS c
  WHERE c.singleton
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;
  IF p_topology_epoch <> v_config.assignment_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_topology',
      'assignmentEpoch', v_config.assignment_epoch
    );
  END IF;

  IF p_target_hub_id IN ('rt1', 'rt2') THEN
    v_hub := v_config.hubs -> p_target_hub_id;
    IF COALESCE((v_hub ->> 'enabled')::boolean, false)
      IS NOT TRUE OR COALESCE((v_hub ->> 'drain')::boolean, true)
    THEN
      RETURN jsonb_build_object('status', 'hub_unavailable');
    END IF;
    IF p_target_hub_id = 'rt2'
      AND COALESCE((public.realtime_topology_read() ->> 'hub2NewRoomAdmissionReady')::boolean, false)
        IS NOT TRUE
    THEN
      RETURN jsonb_build_object('status', 'hub_not_ready');
    END IF;
    SELECT h.* INTO v_health
    FROM public.realtime_hub_health_state AS h
    WHERE h.hub_id = p_target_hub_id;
    IF FOUND AND v_health.health_status = 'down'
      AND public.realtime_hub_down_ttl_active(v_health.down_until, clock_timestamp())
    THEN
      RETURN jsonb_build_object('status', 'hub_unavailable');
    END IF;
  END IF;

  LOOP
    SELECT a.* INTO v_assignment
    FROM public.realtime_room_assignment AS a
    WHERE a.room_key_hash = p_room_key_hash
    FOR UPDATE;

    IF FOUND THEN
      IF v_assignment.bucket <> p_bucket THEN
        RETURN jsonb_build_object('status', 'bucket_conflict');
      END IF;
      IF p_expected_assignment_epoch IS NULL
        OR p_expected_assignment_epoch <> v_assignment.assignment_epoch
      THEN
        RETURN jsonb_build_object(
          'status', 'assignment_conflict',
          'hubId', v_assignment.hub_id,
          'assignmentEpoch', v_assignment.assignment_epoch,
          'topologyEpoch', v_assignment.topology_epoch
        );
      END IF;

      IF v_assignment.hub_id = p_target_hub_id THEN
        UPDATE public.realtime_room_assignment AS a
        SET topology_epoch = p_topology_epoch,
            updated_at = CASE WHEN v_assignment.topology_epoch <> p_topology_epoch
              THEN clock_timestamp() ELSE a.updated_at END,
            last_seen_at = clock_timestamp()
        WHERE a.room_key_hash = p_room_key_hash;
        PERFORM public.realtime_room_assignment_cleanup();
        RETURN jsonb_build_object(
          'status', 'unchanged',
          'bucket', v_assignment.bucket,
          'hubId', v_assignment.hub_id,
          'assignmentEpoch', v_assignment.assignment_epoch,
          'topologyEpoch', p_topology_epoch
        );
      END IF;

      UPDATE public.realtime_room_assignment AS a
      SET hub_id = p_target_hub_id,
          assignment_epoch = a.assignment_epoch + 1,
          topology_epoch = p_topology_epoch,
          updated_at = clock_timestamp(),
          last_seen_at = clock_timestamp()
      WHERE a.room_key_hash = p_room_key_hash
      RETURNING a.* INTO v_assignment;
      PERFORM public.realtime_room_assignment_cleanup();
      RETURN jsonb_build_object(
        'status', 'changed',
        'bucket', v_assignment.bucket,
        'hubId', v_assignment.hub_id,
        'assignmentEpoch', v_assignment.assignment_epoch,
        'topologyEpoch', v_assignment.topology_epoch
      );
    END IF;

    IF p_expected_assignment_epoch IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'assignment_conflict');
    END IF;

    INSERT INTO public.realtime_room_assignment (
      room_key_hash,
      bucket,
      hub_id,
      assignment_epoch,
      topology_epoch
    ) VALUES (
      p_room_key_hash,
      p_bucket,
      p_target_hub_id,
      1,
      p_topology_epoch
    )
    ON CONFLICT (room_key_hash) DO NOTHING
    RETURNING * INTO v_assignment;
    v_inserted := FOUND;
    IF v_inserted THEN
      PERFORM public.realtime_room_assignment_cleanup();
      RETURN jsonb_build_object(
        'status', 'assigned',
        'bucket', v_assignment.bucket,
        'hubId', v_assignment.hub_id,
        'assignmentEpoch', v_assignment.assignment_epoch,
        'topologyEpoch', v_assignment.topology_epoch
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_room_assignment_read(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.realtime_room_assignment_apply(text, integer, text, bigint, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.realtime_room_assignment_read(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_room_assignment_apply(text, integer, text, bigint, bigint)
  TO service_role;

COMMENT ON FUNCTION public.realtime_room_assignment_apply(text, integer, text, bigint, bigint) IS
  'Service-only idempotent per-room CAS. Room IDs are represented only by a SHA-256 key; unchanged hub assignments keep their per-room epoch across topology edits.';

COMMIT;
