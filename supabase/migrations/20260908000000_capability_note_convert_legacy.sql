BEGIN;

-- Convert an existing unmanaged legacy row in place. Do not apply this
-- migration from the U1 PR; apply/publish/origin are a separate named go.
SELECT pg_advisory_xact_lock(20260908000000);

CREATE OR REPLACE FUNCTION public.capability_note_convert_legacy(
  p_slug text,
  p_owner_token_hash text,
  p_edit_token_hash text,
  p_view_token_hash text,
  p_checkpoint_id text,
  p_payload_text text,
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
  v_standard text;
  v_payload bytea;
  v_encryption_version bigint := CASE WHEN p_is_encrypted THEN 1 ELSE 0 END;
  v_recovered boolean := false;
  v_result jsonb;
BEGIN
  IF NOT public.capability_writes_acquire() THEN
    RETURN jsonb_build_object('status', 'writes_disabled');
  END IF;

  IF p_slug IS NULL OR p_slug !~ '^[a-zA-Z0-9_-]{1,64}$'
    OR p_owner_token_hash IS NULL OR p_owner_token_hash !~ '^[a-f0-9]{64}$'
    OR p_edit_token_hash IS NULL OR p_edit_token_hash !~ '^[a-f0-9]{64}$'
    OR p_view_token_hash IS NULL OR p_view_token_hash !~ '^[a-f0-9]{64}$'
    OR p_owner_token_hash IN (p_edit_token_hash, p_view_token_hash)
    OR p_edit_token_hash = p_view_token_hash
    OR p_checkpoint_id IS NULL OR p_checkpoint_id !~ '^[a-f0-9]{64}$'
    OR p_payload_text IS NULL OR p_payload_text !~ '^[A-Za-z0-9_-]+$'
    OR p_is_encrypted IS NULL
    OR (
      p_is_encrypted AND (
        p_salt IS NULL OR length(p_salt) NOT BETWEEN 16 AND 512
        OR p_check IS NULL OR length(p_check) NOT BETWEEN 16 AND 2048
        OR p_iterations NOT BETWEEN 100000 AND 2000000
      )
    )
    OR (
      NOT p_is_encrypted
      AND (p_salt IS NOT NULL OR p_check IS NOT NULL OR p_iterations IS NOT NULL)
    )
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    v_standard := translate(p_payload_text, '-_', '+/');
    v_payload := decode(
      v_standard || repeat('=', (4 - length(v_standard) % 4) % 4),
      'base64'
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'invalid');
  END;
  IF octet_length(v_payload) NOT BETWEEN 1 AND 1048576
    OR translate(
      rtrim(replace(replace(encode(v_payload, 'base64'), E'\n', ''), E'\r', ''), '='),
      '+/',
      '-_'
    ) <> p_payload_text
    OR encode(extensions.digest(v_payload, 'sha256'), 'hex') <> p_checkpoint_id
  THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT n.note_id
  INTO v_note_id
  FROM public.notes AS n
  WHERE n.slug = p_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF (
    SELECT n.capability_managed = false
      AND n.sync_status = 'legacy'
      AND n.deleted_at IS NULL
    FROM public.notes AS n
    WHERE n.note_id = v_note_id
  ) THEN
    UPDATE public.notes
    SET
      capability_managed = true,
      sync_status = 'active',
      content = '',
      ydoc_state = '',
      is_encrypted = p_is_encrypted,
      enc_salt = CASE WHEN p_is_encrypted THEN p_salt ELSE NULL END,
      enc_check = CASE WHEN p_is_encrypted THEN p_check ELSE NULL END,
      enc_iterations = CASE WHEN p_is_encrypted THEN p_iterations ELSE 100000 END,
      encryption_version = v_encryption_version
    WHERE note_id = v_note_id;

    INSERT INTO public.note_capabilities(note_id, scope, token_hash)
    VALUES
      (v_note_id, 'owner', p_owner_token_hash),
      (v_note_id, 'edit', p_edit_token_hash),
      (v_note_id, 'view', p_view_token_hash);

    INSERT INTO public.note_checkpoints(
      note_id,
      version,
      through_seq,
      checkpoint_id,
      payload,
      encryption_version
    ) VALUES (
      v_note_id,
      1,
      0,
      p_checkpoint_id,
      v_payload,
      v_encryption_version
    );
  ELSE
    SELECT n.note_id INTO v_note_id
    FROM public.notes AS n
    JOIN public.note_capabilities AS owner_capability
      ON owner_capability.note_id = n.note_id
      AND owner_capability.scope = 'owner'
      AND owner_capability.token_hash = p_owner_token_hash
      AND owner_capability.revoked_at IS NULL
    JOIN public.note_checkpoints AS initial_checkpoint
      ON initial_checkpoint.note_id = n.note_id
      AND initial_checkpoint.version = 1
      AND initial_checkpoint.through_seq = 0
      AND initial_checkpoint.checkpoint_id = p_checkpoint_id
      AND initial_checkpoint.payload = v_payload
    WHERE n.note_id = v_note_id
      AND n.capability_managed
      AND n.deleted_at IS NULL
      AND n.sync_status <> 'deleted';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'slug_unavailable');
    END IF;
    v_recovered := true;
  END IF;

  SELECT public.capability_session_open(p_owner_token_hash, 0, 200)
  INTO v_result;
  IF v_result ->> 'status' <> 'ok' THEN
    RAISE EXCEPTION 'legacy capability convert unavailable';
  END IF;
  RETURN v_result || jsonb_build_object(
    'noteId', v_note_id,
    'recovered', v_recovered
  );
END;
$$;

REVOKE ALL ON FUNCTION public.capability_note_convert_legacy(
  text, text, text, text, text, text, boolean, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capability_note_convert_legacy(
  text, text, text, text, text, text, boolean, text, text, integer
) TO service_role;

COMMENT ON FUNCTION public.capability_note_convert_legacy(
  text, text, text, text, text, text, boolean, text, text, integer
) IS
  'In-place convert of an unmanaged legacy notes row. Service-role only. Apply is a separate named go.';

COMMIT;
