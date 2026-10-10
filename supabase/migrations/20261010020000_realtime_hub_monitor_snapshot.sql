BEGIN;

-- Read-only, service-role snapshot for the scheduled monitor. This migration
-- adds a function only; rollout owns any future cron.schedule/cron.unschedule.
CREATE OR REPLACE FUNCTION public.realtime_hub_monitor_snapshot(
  p_at timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_config public.realtime_topology_config%ROWTYPE;
  v_ramp public.realtime_hub_ramp_state%ROWTYPE;
  v_health jsonb;
  v_ready boolean;
BEGIN
  IF p_at IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT c.* INTO v_config
  FROM public.realtime_topology_config AS c
  WHERE c.singleton;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM jsonb_each(v_config.hubs) AS configured_hub(key, value)
    WHERE COALESCE((configured_hub.value ->> 'enabled')::boolean, false)
      AND COALESCE((configured_hub.value ->> 'weight_bp')::integer, 0) > 0
  ) INTO v_ready;

  IF NOT v_ready THEN
    RETURN jsonb_build_object('status', 'not_ready', 'ready', false);
  END IF;

  SELECT r.* INTO v_ramp
  FROM public.realtime_hub_ramp_state AS r
  WHERE r.singleton;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unavailable');
  END IF;

  SELECT COALESCE(
    jsonb_object_agg(
      h.hub_id,
      jsonb_build_object(
        'status', 'ok',
        'hubId', h.hub_id,
        'healthStatus', CASE
          WHEN h.health_status = 'down'
            AND NOT public.realtime_hub_down_ttl_active(h.down_until, p_at)
          THEN 'unknown'
          WHEN h.health_status = 'healthy'
            AND (
              h.checked_at IS NULL
              OR h.checked_at + (
                ((v_config.hubs -> h.hub_id -> 'probe' ->> 'probe_cache_ttl_seconds')::integer)
                * interval '1 second'
              ) <= p_at
            )
          THEN 'unknown'
          ELSE h.health_status
        END,
        'checkedAt', h.checked_at,
        'downUntil', h.down_until,
        'consecutiveFailures', h.consecutive_failures,
        'probeLeaseActive', h.probe_lease_until IS NOT NULL
          AND h.probe_lease_until > p_at
      )
    ),
    '{}'::jsonb
  ) INTO v_health
  FROM public.realtime_hub_health_state AS h;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ok' ELSE 'not_ready' END,
    'ready', v_ready,
    'version', v_config.version,
    'assignmentEpoch', v_config.assignment_epoch,
    'hubConfig', v_config.hubs,
    'ramp', v_config.ramp,
    'hub2NewRoomAdmissionReady', COALESCE(
      (public.realtime_topology_read() ->> 'hub2NewRoomAdmissionReady')::boolean,
      false
    ),
    'health', v_health,
    'rampState', jsonb_build_object(
      'status', 'ok',
      'stateVersion', v_ramp.state_version,
      'topologyVersion', v_ramp.topology_version,
      'assignmentEpoch', v_ramp.assignment_epoch,
      'runtime', v_ramp.runtime
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_hub_monitor_snapshot(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.realtime_hub_monitor_snapshot(timestamptz)
  TO service_role;
COMMENT ON FUNCTION public.realtime_hub_monitor_snapshot(timestamptz) IS
  'Read-only service-role snapshot for the scheduled monitor. Computes probe-cache/down-TTL eligibility from existing state; p_at enables deterministic fake-clock tests. It creates no cron jobs.';

COMMIT;
