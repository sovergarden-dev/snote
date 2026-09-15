BEGIN;

-- Reverse of U1 convert-legacy for W2 Legacy OFF. Do not apply this
-- migration from the W2 PR; apply/publish/origin are a separate named go.
-- Does not GRANT table rights on public.notes.
SELECT pg_advisory_xact_lock(20260915000001);

CREATE OR REPLACE FUNCTION public.capability_note_disable_secure(
  p_owner_token_hash text,
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
  v_note_id uuid;
  v_managed boolean;
  v_deleted timestamptz;
  v_tag text;
  v_owner uuid;
BEGIN
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  IF p_owner_token_hash IS NULL OR p_owner_token_hash !~ '^[a-f0-9]{64}$'
    OR p_slug IS NULL OR p_slug !~ '^[a-zA-Z0-9_-]{1,64}$'
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

  SELECT n.note_id, n.capability_managed, n.deleted_at
  INTO v_note_id, v_managed, v_deleted
  FROM public.notes AS n
  WHERE n.slug = p_slug
  FOR UPDATE;

  IF NOT FOUND OR v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT v_managed THEN
    RETURN jsonb_build_object('status', 'ok', 'noteId', v_note_id, 'recovered', true);
  END IF;

  SELECT owner_capability.note_id
  INTO v_owner
  FROM public.note_capabilities AS owner_capability
  WHERE owner_capability.note_id = v_note_id
    AND owner_capability.scope = 'owner'
    AND owner_capability.token_hash = p_owner_token_hash
    AND owner_capability.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'unauthorized');
  END IF;

  -- Parent delete cascades append-only children (trigger_depth > 1).
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

  RETURN jsonb_build_object('status', 'ok', 'noteId', v_note_id, 'recovered', false);
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_disable_secure(
  text, text, text, text, integer, text[], boolean, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capability_note_disable_secure(
  text, text, text, text, integer, text[], boolean, text, text, integer
) TO service_role;

COMMENT ON FUNCTION public.capability_note_disable_secure(
  text, text, text, text, integer, text[], boolean, text, text, integer
) IS
  'W2 Legacy OFF: owner-only reverse of convert-legacy onto an unmanaged slug. Service-role only. Apply is a separate named go.';

COMMIT;
