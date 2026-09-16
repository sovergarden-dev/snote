# Bulk disable Secure (ops runbook)

Status: **GitHub-only.** This document does **not** authorize apply to
production, staging, Origin, or a live Supabase project.

RPC: `public.capability_note_bulk_disable_secure(p_limit int, p_include_encrypted bool default false)`  
Migration: `supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql`  
Named apply: separate Syringa go (Go A SQL / Go B ops). **Do not apply from this PR.**

## B1 + Syringa locks

- Selection: all live managed rows (`capability_managed=true`, `deleted_at IS NULL`).
- Encrypted: skip (`is_encrypted=true` counted in `skipped_encrypted`) unless a
  later named go passes `p_include_encrypted := true`.
- Reshape: same as single OFF — `DELETE` managed row (cascade history) then
  `INSERT` unmanaged (`capability_managed=false`, `sync_status='legacy'`).
  **`note_id` rotates; checkpoints/caps/updates for the old id are gone.**
- Latest usable body: newest `note_checkpoints.payload` encoded as `ydoc_state`;
  markdown `content` / tags / `char_count` use empty plaintext defaults.
  Notes with no checkpoint (for example Home mint never synced) become empty
  unmanaged slugs.
- Go C (stale SPA pin `snote:legacy-secure:${slug}` heal) is **out of this PR**.
  After bulk OFF, browsers that still hold a pin can show residual bare RO until
  a later pin-heal change or a local storage clear. Server LNO for converted
  slugs is unmanaged.

## Walls (this PR)

- No notes table GRANT changes.
- No Edge republish, no SPA/Worker/Realtime, no auto-ON.
- Do not invoke U1 convert from this job.
- `SECURITY DEFINER`, `service_role` EXECUTE only; PUBLIC / anon / authenticated
  revoked.

## Pre-apply inventory (read-only; named go)

Count live managed vs encrypted. Confirm the identity trigger still forbids
`UPDATE` managed→false. Backup managed `notes` + `note_checkpoints` before any
apply go. This runbook is not that go.

## Execute (only after written Syringa accept)

Maintenance window. `writes_enabled` must already be true (same gate as other
capability writes). As `service_role`:

```sql
SELECT public.capability_note_bulk_disable_secure(500);
-- jsonb: status, converted, skipped_encrypted, skipped_not_managed, errors[]
```

`p_limit` is 1–10000 eligible plaintext rows per call (encrypted live rows are
reported in `skipped_encrypted` and left in place). Re-run until `converted=0`.
Idempotent: already unmanaged rows are not rewritten.

Save the jsonb report as the go artifact. Spot-check N slugs: DB unmanaged, new
`note_id`, no `note_capabilities` on the new id, LNO not `managed:true`,
plain-upsert allowed. Encrypted control slug stays managed until a later
include-encrypted go.

Do **not** enable Realtime / Worker, and do **not** re-GRANT `public.notes`.
