BEGIN;

-- Additive Edge ticket/CAS contract for ordinary legacy /slug notes.
-- This migration is exercised only by isolated integration tests in this PR.
SELECT pg_advisory_xact_lock(20261009000001);

ALTER TABLE public.notes
  ADD COLUMN realtime_state_vector bytea;

COMMENT ON COLUMN public.notes.realtime_state_vector IS
  'Canonical Yjs state vector committed atomically with the latest realtime snapshot.';

CREATE OR REPLACE FUNCTION public.realtime_note_version_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state_vector_active text;
  v_state_vector_hex text;
BEGIN
  v_state_vector_active := current_setting('snote.realtime_state_vector_active', true);
  IF v_state_vector_active = 'on' THEN
    v_state_vector_hex := current_setting('snote.realtime_state_vector_hex', true);
    IF v_state_vector_hex IS NULL OR v_state_vector_hex !~ '^([0-9a-f]{2})*$' THEN
      RAISE EXCEPTION 'invalid realtime state vector setting';
    END IF;
    NEW.realtime_state_vector := decode(v_state_vector_hex, 'hex');
  END IF;

  IF OLD.ydoc_state IS DISTINCT FROM NEW.ydoc_state
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.char_count IS DISTINCT FROM NEW.char_count
    OR OLD.tags IS DISTINCT FROM NEW.tags
    OR OLD.is_encrypted IS DISTINCT FROM NEW.is_encrypted
    OR OLD.enc_salt IS DISTINCT FROM NEW.enc_salt
    OR OLD.enc_check IS DISTINCT FROM NEW.enc_check
    OR OLD.enc_iterations IS DISTINCT FROM NEW.enc_iterations
    OR OLD.encryption_version IS DISTINCT FROM NEW.encryption_version
    OR OLD.realtime_state_vector IS DISTINCT FROM NEW.realtime_state_vector
  THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;

  IF current_setting('snote.realtime_force_generation_bump', true) = 'on'
    OR OLD.is_encrypted IS DISTINCT FROM NEW.is_encrypted
    OR OLD.capability_managed IS DISTINCT FROM NEW.capability_managed
    OR OLD.enc_salt IS DISTINCT FROM NEW.enc_salt
    OR OLD.enc_check IS DISTINCT FROM NEW.enc_check
    OR OLD.enc_iterations IS DISTINCT FROM NEW.enc_iterations
    OR OLD.encryption_version IS DISTINCT FROM NEW.encryption_version
  THEN
    NEW.generation := OLD.generation + 1;
  ELSE
    NEW.generation := OLD.generation;
  END IF;

  RETURN NEW;
END;
$$;

-- One authoritative eligibility check is shared by the legacy plain-upsert,
-- realtime ticket issuance, and the locked CAS wrapper.
CREATE OR REPLACE FUNCTION public.capability_note_plain_row_access(
  p_slug text,
  p_for_update boolean,
  p_require_legacy boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_note record;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-zA-Z0-9_-]{1,64}$' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;
  IF p_for_update IS NULL OR p_require_legacy IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  IF p_for_update THEN
    SELECT n.note_id, n.revision, n.generation, n.permission_epoch,
           n.capability_managed, n.deleted_at, n.sync_status,
           n.is_encrypted, n.ydoc_state, n.content, n.char_count, n.tags,
           n.enc_salt, n.enc_check, n.enc_iterations
    INTO v_note
    FROM public.notes AS n
    WHERE n.slug = p_slug
    FOR UPDATE;
  ELSE
    SELECT n.note_id, n.revision, n.generation, n.permission_epoch,
           n.capability_managed, n.deleted_at, n.sync_status,
           n.is_encrypted, n.ydoc_state, n.content, n.char_count, n.tags,
           n.enc_salt, n.enc_check, n.enc_iterations
    INTO v_note
    FROM public.notes AS n
    WHERE n.slug = p_slug
    FOR SHARE;
  END IF;

  IF NOT FOUND OR v_note.deleted_at IS NOT NULL OR v_note.sync_status = 'deleted' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_note.capability_managed THEN
    RETURN jsonb_build_object('status', 'capability_managed');
  END IF;
  IF p_require_legacy AND v_note.sync_status <> 'legacy' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'noteId', v_note.note_id,
    'revision', v_note.revision,
    'generation', v_note.generation,
    'permissionEpoch', v_note.permission_epoch,
    'syncStatus', v_note.sync_status,
    'isEncrypted', v_note.is_encrypted,
    'ydocState', v_note.ydoc_state,
    'content', v_note.content,
    'charCount', v_note.char_count,
    'tags', v_note.tags,
    'salt', v_note.enc_salt,
    'check', v_note.enc_check,
    'iterations', v_note.enc_iterations
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_plain_row_access(text, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- Keep the existing RPC signature and write behavior while delegating row
-- eligibility/locking to the shared helper above.
CREATE OR REPLACE FUNCTION public.capability_note_plain_upsert(
  p_slug text,
  p_ydoc_state text,
  p_content text,
  p_char_count integer,
  p_tags text[],
  p_is_encrypted boolean,
  p_salt text,
  p_check text,
  p_iterations integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_access jsonb;
  v_status text;
  v_note_id uuid;
  v_tag text;
BEGIN
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  IF p_slug IS NULL OR p_slug !~ '^[a-zA-Z0-9_-]{1,64}$'
    OR p_ydoc_state IS NULL OR length(p_ydoc_state) > 5592406
    OR p_content IS NULL OR length(p_content) > 1048576
    OR p_char_count IS NULL OR p_char_count < 0 OR p_char_count > 1048576
    OR p_tags IS NULL OR cardinality(p_tags) > 20
    OR p_is_encrypted IS NULL
    OR (
      p_is_encrypted AND (
        p_salt IS NULL OR length(p_salt) NOT BETWEEN 16 AND 512
        OR p_check IS NULL OR length(p_check) NOT BETWEEN 16 AND 2048
        OR p_iterations NOT BETWEEN 100000 AND 2000000
        OR p_content <> ''
        OR p_char_count <> 0
        OR cardinality(p_tags) <> 0
      )
    )
    OR (
      NOT p_is_encrypted
      AND (p_salt IS NOT NULL OR p_check IS NOT NULL OR p_iterations IS NOT NULL)
    )
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  FOREACH v_tag IN ARRAY p_tags LOOP
    IF v_tag IS NULL OR v_tag !~ '^[a-z0-9_-]{1,32}$' THEN
      RETURN jsonb_build_object('status', 'invalid');
    END IF;
  END LOOP;

  v_access := public.capability_note_plain_row_access(p_slug, true, false);
  v_status := v_access->>'status';
  IF v_status = 'capability_managed' THEN
    RETURN jsonb_build_object('status', 'capability_managed');
  END IF;
  IF v_status NOT IN ('ok', 'not_found') THEN
    RETURN jsonb_build_object('status', v_status);
  END IF;

  IF v_status = 'ok' THEN
    v_note_id := (v_access->>'noteId')::uuid;
    UPDATE public.notes
    SET
      ydoc_state = p_ydoc_state,
      content = p_content,
      char_count = p_char_count,
      tags = p_tags,
      is_encrypted = p_is_encrypted,
      enc_salt = CASE WHEN p_is_encrypted THEN p_salt ELSE NULL END,
      enc_check = CASE WHEN p_is_encrypted THEN p_check ELSE NULL END,
      enc_iterations = CASE WHEN p_is_encrypted THEN p_iterations ELSE 100000 END,
      encryption_version = CASE WHEN p_is_encrypted THEN 1 ELSE 0 END,
      sync_status = 'legacy',
      realtime_state_vector = NULL,
      updated_at = statement_timestamp()
    WHERE note_id = v_note_id;

    RETURN jsonb_build_object('status', 'ok', 'noteId', v_note_id, 'created', false);
  END IF;

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
    p_slug,
    false,
    'legacy',
    p_content,
    p_ydoc_state,
    p_char_count,
    p_tags,
    p_is_encrypted,
    CASE WHEN p_is_encrypted THEN p_salt ELSE NULL END,
    CASE WHEN p_is_encrypted THEN p_check ELSE NULL END,
    CASE WHEN p_is_encrypted THEN p_iterations ELSE 100000 END,
    CASE WHEN p_is_encrypted THEN 1 ELSE 0 END
  )
  RETURNING note_id INTO v_note_id;

  RETURN jsonb_build_object('status', 'ok', 'noteId', v_note_id, 'created', true);
EXCEPTION WHEN unique_violation THEN
  v_access := public.capability_note_plain_row_access(p_slug, true, false);
  v_status := v_access->>'status';
  IF v_status = 'capability_managed' THEN
    RETURN jsonb_build_object('status', 'capability_managed');
  END IF;
  IF v_status <> 'ok' THEN
    RETURN jsonb_build_object('status', COALESCE(v_status, 'not_found'));
  END IF;
  v_note_id := (v_access->>'noteId')::uuid;
  UPDATE public.notes
  SET
    ydoc_state = p_ydoc_state,
    content = p_content,
    char_count = p_char_count,
    tags = p_tags,
    is_encrypted = p_is_encrypted,
    enc_salt = CASE WHEN p_is_encrypted THEN p_salt ELSE NULL END,
    enc_check = CASE WHEN p_is_encrypted THEN p_check ELSE NULL END,
    enc_iterations = CASE WHEN p_is_encrypted THEN p_iterations ELSE 100000 END,
    encryption_version = CASE WHEN p_is_encrypted THEN 1 ELSE 0 END,
    sync_status = 'legacy',
    realtime_state_vector = NULL,
    updated_at = statement_timestamp()
  WHERE note_id = v_note_id;
  RETURN jsonb_build_object('status', 'ok', 'noteId', v_note_id, 'created', false);
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_plain_upsert(
  text, text, text, integer, text[], boolean, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capability_note_plain_upsert(
  text, text, text, integer, text[], boolean, text, text, integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.capability_note_realtime_ticket_context(
  p_slug text,
  p_auth_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_access jsonb;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized');
  END IF;
  PERFORM 1 FROM auth.users AS u
  WHERE u.id = p_auth_user_id AND u.is_anonymous IS TRUE
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unauthorized');
  END IF;
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  v_access := public.capability_note_plain_row_access(p_slug, false, true);
  IF v_access->>'status' <> 'ok' THEN
    RETURN jsonb_build_object('status', v_access->>'status');
  END IF;
  RETURN v_access - 'content' - 'charCount' - 'tags' - 'salt' - 'check' - 'iterations';
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_realtime_ticket_context(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capability_note_realtime_ticket_context(text, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.capability_note_realtime_save(
  p_slug text,
  p_auth_user_id uuid,
  p_expected_revision bigint,
  p_generation bigint,
  p_permission_epoch bigint,
  p_ydoc_state text,
  p_content text,
  p_char_count integer,
  p_tags text[],
  p_is_encrypted boolean,
  p_salt text,
  p_check text,
  p_iterations integer,
  p_expected_mac bytea,
  p_presented_mac bytea,
  p_state_vector bytea,
  p_state_vector_matches boolean,
  p_replace_generation boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_access jsonb;
  v_status text;
  v_revision bigint;
  v_generation bigint;
  v_permission_epoch bigint;
  v_note_id uuid;
  v_cas_result jsonb;
  v_state_vector_hex text;
  v_old_active text;
  v_old_hex text;
  v_old_force_generation text;
BEGIN
  -- Ordering is contractual: authenticated user -> current edit permission ->
  -- permission epoch -> MAC -> generation/revision CAS -> state-vector check.
  IF p_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized');
  END IF;
  PERFORM 1 FROM auth.users AS u
  WHERE u.id = p_auth_user_id AND u.is_anonymous IS TRUE
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unauthorized');
  END IF;
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  v_access := public.capability_note_plain_row_access(p_slug, true, true);
  v_status := v_access->>'status';
  IF v_status <> 'ok' THEN
    RETURN jsonb_build_object('status', COALESCE(v_status, 'not_found'));
  END IF;
  v_note_id := (v_access->>'noteId')::uuid;
  v_revision := (v_access->>'revision')::bigint;
  v_generation := (v_access->>'generation')::bigint;
  v_permission_epoch := (v_access->>'permissionEpoch')::bigint;

  IF p_permission_epoch IS DISTINCT FROM v_permission_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_permission_epoch',
      'noteId', v_note_id,
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF p_expected_mac IS NULL OR octet_length(p_expected_mac) <> 32
    OR p_presented_mac IS NULL OR octet_length(p_presented_mac) <> 32
    OR p_expected_mac IS DISTINCT FROM p_presented_mac
  THEN
    RETURN jsonb_build_object('status', 'invalid_mac');
  END IF;
  -- The row remains locked by capability_note_plain_row_access. Give a stale
  -- client the CAS conflict before comparing its vector with a newer snapshot.
  IF p_generation IS DISTINCT FROM v_generation THEN
    RETURN jsonb_build_object(
      'status', 'generation_conflict',
      'noteId', v_note_id,
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF p_expected_revision IS DISTINCT FROM v_revision THEN
    RETURN jsonb_build_object(
      'status', 'version_conflict',
      'noteId', v_note_id,
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF p_state_vector IS NULL OR p_state_vector_matches IS DISTINCT FROM true
    OR p_replace_generation IS NULL
  THEN
    RETURN jsonb_build_object('status', 'invalid_state_vector');
  END IF;

  v_state_vector_hex := encode(p_state_vector, 'hex');
  v_old_active := current_setting('snote.realtime_state_vector_active', true);
  v_old_hex := current_setting('snote.realtime_state_vector_hex', true);
  v_old_force_generation := current_setting('snote.realtime_force_generation_bump', true);
  PERFORM set_config('snote.realtime_state_vector_active', 'on', true);
  PERFORM set_config('snote.realtime_state_vector_hex', v_state_vector_hex, true);
  PERFORM set_config(
    'snote.realtime_force_generation_bump',
    CASE WHEN p_replace_generation THEN 'on' ELSE 'off' END,
    true
  );

  v_cas_result := public.capability_note_cas_save(
    p_slug,
    p_expected_revision,
    p_generation,
    p_permission_epoch,
    p_ydoc_state,
    p_content,
    p_char_count,
    p_tags,
    p_is_encrypted,
    p_salt,
    p_check,
    p_iterations
  );

  PERFORM set_config('snote.realtime_state_vector_active', COALESCE(v_old_active, ''), true);
  PERFORM set_config('snote.realtime_state_vector_hex', COALESCE(v_old_hex, ''), true);
  PERFORM set_config(
    'snote.realtime_force_generation_bump',
    COALESCE(v_old_force_generation, ''),
    true
  );

  IF v_cas_result->>'status' <> 'ok' THEN
    RETURN v_cas_result;
  END IF;
  SELECT encode(n.realtime_state_vector, 'hex')
  INTO v_state_vector_hex
  FROM public.notes AS n
  WHERE n.note_id = v_note_id;
  RETURN v_cas_result || jsonb_build_object(
    'stateVectorHex', v_state_vector_hex
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_realtime_save(
  text, uuid, bigint, bigint, bigint, text, text, integer, text[], boolean,
  text, text, integer, bytea, bytea, bytea, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capability_note_realtime_save(
  text, uuid, bigint, bigint, bigint, text, text, integer, text[], boolean,
  text, text, integer, bytea, bytea, bytea, boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.capability_note_realtime_save(
  text, uuid, bigint, bigint, bigint, text, text, integer, text[], boolean,
  text, text, integer, bytea, bytea, bytea, boolean, boolean
) IS
  'Service-role-only authenticated legacy-slug CAS wrapper. Under a row lock checks current legacy edit eligibility, permission epoch, MAC, generation/revision conflict, then state vector before delegating snapshot CAS; state vector is committed by the same update trigger.';

COMMIT;
