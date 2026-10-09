BEGIN;

-- Realtime Edge/data phase: additive note versions and atomic CAS. This file is
-- only applied by isolated integration tests until Syringa runs the release
-- procedure; it does not replace the existing upsert RPC.
SELECT pg_advisory_xact_lock(20261009000000);

ALTER TABLE public.notes
  ADD COLUMN revision bigint NOT NULL DEFAULT 1
    CONSTRAINT notes_revision_positive CHECK (revision >= 1),
  ADD COLUMN generation bigint NOT NULL DEFAULT 1
    CONSTRAINT notes_generation_positive CHECK (generation >= 1),
  ADD COLUMN permission_epoch bigint NOT NULL DEFAULT 0
    CONSTRAINT notes_permission_epoch_nonnegative CHECK (permission_epoch >= 0);

COMMENT ON COLUMN public.notes.revision IS
  'Monotonic durable snapshot revision; never reset when generation changes.';
COMMENT ON COLUMN public.notes.generation IS
  'Document/encryption generation. Replaced documents never merge across generations.';
COMMENT ON COLUMN public.notes.permission_epoch IS
  'Monotonic epoch for capability permission changes; checked atomically by CAS.';

CREATE OR REPLACE FUNCTION public.realtime_note_version_before_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.ydoc_state IS DISTINCT FROM NEW.ydoc_state
    OR OLD.content IS DISTINCT FROM NEW.content
    OR OLD.char_count IS DISTINCT FROM NEW.char_count
    OR OLD.tags IS DISTINCT FROM NEW.tags
    OR OLD.is_encrypted IS DISTINCT FROM NEW.is_encrypted
    OR OLD.enc_salt IS DISTINCT FROM NEW.enc_salt
    OR OLD.enc_check IS DISTINCT FROM NEW.enc_check
    OR OLD.enc_iterations IS DISTINCT FROM NEW.enc_iterations
  THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;

  IF OLD.is_encrypted IS DISTINCT FROM NEW.is_encrypted
    OR OLD.capability_managed IS DISTINCT FROM NEW.capability_managed
  THEN
    NEW.generation := OLD.generation + 1;
  ELSE
    NEW.generation := OLD.generation;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_note_version_before_update()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER realtime_note_version_before_update
  BEFORE UPDATE ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.realtime_note_version_before_update();

CREATE OR REPLACE FUNCTION public.realtime_note_permission_epoch_bump()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_note_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_note_id := NEW.note_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_note_id := OLD.note_id;
  ELSE
    v_note_id := NEW.note_id;
  END IF;

  UPDATE public.notes
  SET permission_epoch = permission_epoch + 1
  WHERE note_id = v_note_id;

  IF TG_OP = 'UPDATE' AND NEW.note_id IS DISTINCT FROM OLD.note_id THEN
    UPDATE public.notes
    SET permission_epoch = permission_epoch + 1
    WHERE note_id = OLD.note_id;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.realtime_note_permission_epoch_bump()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER realtime_note_permission_epoch_insert_delete
  AFTER INSERT OR DELETE ON public.note_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.realtime_note_permission_epoch_bump();

CREATE TRIGGER realtime_note_permission_epoch_authorization_update
  AFTER UPDATE OF scope, token_hash, generation, revoked_at ON public.note_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.realtime_note_permission_epoch_bump();

CREATE OR REPLACE FUNCTION public.capability_note_cas_save(
  p_slug text,
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
  p_iterations integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_note_id uuid;
  v_revision bigint;
  v_generation bigint;
  v_permission_epoch bigint;
  v_managed boolean;
  v_deleted timestamptz;
  v_sync_status text;
  v_is_encrypted boolean;
  v_salt text;
  v_check text;
  v_iterations integer;
  v_tag text;
  v_created boolean := false;
BEGIN
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  IF p_slug IS NULL OR p_slug !~ '^[a-zA-Z0-9_-]{1,64}$'
    OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR p_generation IS NULL OR p_generation < 1
    OR p_permission_epoch IS NULL OR p_permission_epoch < 0
    OR p_ydoc_state IS NULL OR length(p_ydoc_state) > 5592406
    OR p_content IS NULL OR length(p_content) > 1048576
    OR p_char_count IS NULL OR p_char_count < 0 OR p_char_count > 1048576
    OR p_tags IS NULL OR cardinality(p_tags) > 20
    OR p_is_encrypted IS NULL
    OR (
      p_is_encrypted AND (
        p_salt IS NULL OR length(p_salt) NOT BETWEEN 16 AND 512
        OR p_check IS NULL OR length(p_check) NOT BETWEEN 16 AND 2048
        OR p_iterations IS NULL
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
    IF v_tag IS NULL OR v_tag !~ '^[a-z0-9_À-ɏḀ-ỿ-]{1,32}$' THEN
      RETURN jsonb_build_object('status', 'invalid');
    END IF;
  END LOOP;

  SELECT n.note_id, n.revision, n.generation, n.permission_epoch,
         n.capability_managed, n.deleted_at, n.sync_status,
         n.is_encrypted, n.enc_salt, n.enc_check, n.enc_iterations
  INTO v_note_id, v_revision, v_generation, v_permission_epoch,
       v_managed, v_deleted, v_sync_status,
       v_is_encrypted, v_salt, v_check, v_iterations
  FROM public.notes AS n
  WHERE n.slug = p_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_expected_revision <> 0 OR p_generation <> 1 OR p_permission_epoch <> 0
      OR p_is_encrypted
    THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;

    INSERT INTO public.notes (
      slug, capability_managed, sync_status, content, ydoc_state,
      char_count, tags, is_encrypted, enc_salt, enc_check,
      enc_iterations, encryption_version
    ) VALUES (
      p_slug, false, 'legacy', p_content, p_ydoc_state,
      p_char_count, p_tags, false, NULL, NULL, 100000, 0
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING note_id, revision, generation, permission_epoch
    INTO v_note_id, v_revision, v_generation, v_permission_epoch;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'status', 'ok',
        'noteId', v_note_id,
        'created', true,
        'revision', v_revision,
        'generation', v_generation,
        'permissionEpoch', v_permission_epoch
      );
    END IF;

    SELECT n.note_id, n.revision, n.generation, n.permission_epoch,
           n.capability_managed, n.deleted_at, n.sync_status,
           n.is_encrypted, n.enc_salt, n.enc_check, n.enc_iterations
    INTO v_note_id, v_revision, v_generation, v_permission_epoch,
         v_managed, v_deleted, v_sync_status,
         v_is_encrypted, v_salt, v_check, v_iterations
    FROM public.notes AS n
    WHERE n.slug = p_slug
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  IF v_deleted IS NOT NULL OR v_sync_status = 'deleted' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v_managed THEN
    RETURN jsonb_build_object('status', 'capability_managed');
  END IF;
  IF v_generation <> p_generation THEN
    RETURN jsonb_build_object(
      'status', 'generation_conflict',
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF v_permission_epoch <> p_permission_epoch THEN
    RETURN jsonb_build_object(
      'status', 'stale_permission_epoch',
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF v_revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'status', 'version_conflict',
      'revision', v_revision,
      'generation', v_generation,
      'permissionEpoch', v_permission_epoch
    );
  END IF;
  IF v_is_encrypted IS DISTINCT FROM p_is_encrypted
    OR (
      p_is_encrypted AND (
        v_salt IS DISTINCT FROM p_salt
        OR v_check IS DISTINCT FROM p_check
        OR v_iterations IS DISTINCT FROM p_iterations
      )
    )
  THEN
    RETURN jsonb_build_object('status', 'invalid_state');
  END IF;

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
    updated_at = statement_timestamp()
  WHERE note_id = v_note_id
  RETURNING revision, generation, permission_epoch
  INTO v_revision, v_generation, v_permission_epoch;

  RETURN jsonb_build_object(
    'status', 'ok',
    'noteId', v_note_id,
    'created', v_created,
    'revision', v_revision,
    'generation', v_generation,
    'permissionEpoch', v_permission_epoch
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_cas_save(
  text, bigint, bigint, bigint, text, text, integer, text[], boolean, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capability_note_cas_save(
  text, bigint, bigint, bigint, text, text, integer, text[], boolean, text, text, integer
) TO service_role;

COMMENT ON FUNCTION public.capability_note_cas_save(
  text, bigint, bigint, bigint, text, text, integer, text[], boolean, text, text, integer
) IS
  'Service-role-only atomic note snapshot CAS. Checks generation, permission epoch and revision under row lock; does not replace legacy RPCs.';

COMMIT;
