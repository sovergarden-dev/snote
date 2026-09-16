BEGIN;

-- Ops bulk reverse of Secure / capability_managed notes onto unmanaged
-- free-edit slugs. Same delete+insert reshape as capability_note_disable_secure.
-- Do not apply this migration from the GitHub PR; apply is a separate named go.
-- Does not GRANT table rights on public.notes.
SELECT pg_advisory_xact_lock(20260916000000);

CREATE OR REPLACE FUNCTION public.capability_note_bulk_disable_secure(
  p_limit integer,
  p_include_encrypted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_converted integer := 0;
  v_skipped_encrypted integer := 0;
  v_skipped_not_managed integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_candidate record;
  v_note_id uuid;
  v_slug text;
  v_managed boolean;
  v_deleted timestamptz;
  v_encrypted boolean;
  v_enc_salt text;
  v_enc_check text;
  v_enc_iterations integer;
  v_payload bytea;
  v_ydoc text;
BEGIN
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000
    OR p_include_encrypted IS NULL
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_advisory_xact_lock(20260916000000);

  IF NOT p_include_encrypted THEN
    SELECT count(*)::integer
    INTO v_skipped_encrypted
    FROM public.notes AS n
    WHERE n.capability_managed
      AND n.deleted_at IS NULL
      AND n.is_encrypted;
  END IF;

  FOR v_candidate IN
    SELECT n.note_id
    FROM public.notes AS n
    WHERE n.capability_managed
      AND n.deleted_at IS NULL
      AND (p_include_encrypted OR NOT n.is_encrypted)
    ORDER BY n.created_at, n.note_id
    LIMIT p_limit
  LOOP
    BEGIN
      v_note_id := NULL;
      v_slug := NULL;
      v_managed := NULL;
      v_deleted := NULL;
      v_encrypted := NULL;
      v_enc_salt := NULL;
      v_enc_check := NULL;
      v_enc_iterations := NULL;
      v_payload := NULL;
      v_ydoc := NULL;

      SELECT n.note_id, n.slug, n.capability_managed, n.deleted_at,
             n.is_encrypted, n.enc_salt, n.enc_check, n.enc_iterations
      INTO v_note_id, v_slug, v_managed, v_deleted,
           v_encrypted, v_enc_salt, v_enc_check, v_enc_iterations
      FROM public.notes AS n
      WHERE n.note_id = v_candidate.note_id
      FOR UPDATE;

      IF NOT FOUND OR v_deleted IS NOT NULL OR NOT v_managed THEN
        v_skipped_not_managed := v_skipped_not_managed + 1;
      ELSE
        v_payload := NULL;
        v_ydoc := '';
        SELECT checkpoint.payload
        INTO v_payload
        FROM public.note_checkpoints AS checkpoint
        WHERE checkpoint.note_id = v_note_id
        ORDER BY checkpoint.version DESC
        LIMIT 1;

        IF v_payload IS NOT NULL THEN
          v_ydoc := replace(replace(encode(v_payload, 'base64'), E'\n', ''), E'\r', '');
        END IF;

        -- Padded base64 of the 4MiB checkpoint CHECK is 5592408 chars.
        IF length(v_ydoc) > 5592408 THEN
          v_errors := v_errors || jsonb_build_array(
            jsonb_build_object(
              'reason', 'payload_too_large',
              'slug', v_slug,
              'noteId', v_note_id
            )
          );
        ELSE
          DELETE FROM public.notes WHERE note_id = v_note_id;

          INSERT INTO public.notes (
            slug,
            capability_managed,
            sync_status,
            content,
            ydoc_state,
            char_count,
            tags,
            is_encrypted,
            enc_salt,
            enc_check,
            enc_iterations,
            encryption_version
          ) VALUES (
            v_slug,
            false,
            'legacy',
            '',
            v_ydoc,
            0,
            ARRAY[]::text[],
            v_encrypted,
            CASE WHEN v_encrypted THEN v_enc_salt ELSE NULL END,
            CASE WHEN v_encrypted THEN v_enc_check ELSE NULL END,
            CASE WHEN v_encrypted THEN COALESCE(v_enc_iterations, 100000) ELSE 100000 END,
            CASE WHEN v_encrypted THEN 1 ELSE 0 END
          );

          v_converted := v_converted + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_array(
        jsonb_build_object(
          'sqlstate', SQLSTATE,
          'slug', v_slug,
          'noteId', v_note_id
        )
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'ok',
    'converted', v_converted,
    'skipped_encrypted', v_skipped_encrypted,
    'skipped_not_managed', v_skipped_not_managed,
    'errors', v_errors
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_bulk_disable_secure(
  integer, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capability_note_bulk_disable_secure(
  integer, boolean
) TO service_role;

COMMENT ON FUNCTION public.capability_note_bulk_disable_secure(
  integer, boolean
) IS
  'Ops bulk Secure OFF: delete+insert unmanaged slugs. Service-role only. Apply is a separate named go.';

COMMIT;
