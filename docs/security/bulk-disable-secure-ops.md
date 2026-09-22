# Bulk disable Secure (ops runbook)

Status: **Go A+B applied live** (Syringa named go; Pulse **PASS**). Go C pin
heal **shipped** live (#145 LNO-wins on origin `9a80930a`). **Re-bulk OFF ALL 6**
plaintext **PASS** (Syringa named go 2026-09-22; Pulse **PASS**; existing live
RPC, **no re-migrate**). This document is a **docs attestation**. It does
**not** re-apply SQL, does **not** re-run the bulk RPC, and does **not**
deploy origin / Pages / Worker / Edge. Worker / Realtime / `writes_enabled`
still HOLD. Live SPA origin remains `9a80930a` / Pages `8e64829c` (this
attest does not ship origin).

RPC: `public.capability_note_bulk_disable_secure(p_limit int, p_include_encrypted bool default false)`  
Migration: `supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql`  
SHA-256: `a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850`  
Git tip when applied: `bd11deed` (#142 lineage; tip also includes #143
`pwa-update-smoke` harden). At that attest, live SPA origin was still
`0cdcdc0f` / Pages `1b9ed3d1` (bulk OFF is SQL/ops, not a SPA ship). Current
live origin is `9a80930a` / Pages `8e64829c`. Git docs tip may advance; live
SPA stays `9a80930a`.

## Live go (2026-09-16 apply; 2026-09-17 Go C origin; 2026-09-22 re-bulk)

- Go A: `CREATE OR REPLACE` `capability_note_bulk_disable_secure` **applied** live;
  anon/authenticated EXECUTE false; `service_role` EXECUTE true.
- Go B: `managed_live` 26→0 (2026-09-16); skipped_encrypted=0; errors=[]; plaintext
  converted; `note_id` rotated. Pulse `/workspace/pulse-bulk-off-ab2c4de9/`.
  That post-count is **historical**. The fleet was **not** still 0 managed
  after #144: leftovers followed (Go C live `managed_live=3`, then preflight 6).
- Pulse RO inventory at Go C live: `managed_live=3` (`hage`, `xqmqh53z`,
  `svgoccbe2542573b`); `unmanaged_live=106`; `design` unmanaged. That inventory
  is **historical**.
- Preflight 2026-09-22 (not the earlier scope-3): 6 managed plaintext,
  encrypted=0. Slugs: `hage`, `xqmqh53z`, `svgoccbe2542573b`, `gr3l8g5e`,
  `svgocc0360f59afa`, `x915930e`.
- Re-bulk OFF ALL 6: existing live RPC
  `capability_note_bulk_disable_secure(500,false)` — **no re-migrate**. Pulse
  `converted=6`, drain `converted=0`, `errors=[]`; post-verify
  `managed_live=0`, encrypted=0. `note_id` rotation + history wipe accepted
  (same as Go B). Artifact `/workspace/pulse-rebulk-all6-20260922/`. Claim
  `managed_live=0` only as Pulse post-verify + Sentinel spot evidence; anon
  fleet RO count was unavailable (401).
- Go C: **shipped** live (#145 LNO-wins). Stale `snote:legacy-secure:*` +
  unmanaged LNO → silent free-edit; still-managed → A3 RO; LNO error
  fail-closed; no auto-ON.
- Sentinel (re-bulk 2026-09-22): READY WITH KNOWN RISKS —
  `/workspace/sentinel-qa-rebulk-all6-live/`. LNO unmanaged for `hage` /
  `xqmqh53z` / `gr3l8g5e`; plain-upsert 200 (not 409) with noteIds matching
  Pulse new ids; vacant create unmanaged (no auto-ON); bare SPA `/hage` +
  `/xqmqh53z` editable+synced, no A3/need-owner. BLOCKER/HIGH/MEDIUM none.
  LOWs: (1) anon `managed_live` RO count skipped (401); (2) `hage` content_len
  drift after roundtrip still unmanaged; (3) 1 CSP console error, no edit/sync
  impact. Historical Go C Sentinel: `/workspace/sentinel-qa-go-c-live/`.
  Historical bulk-OFF Sentinel: `/workspace/sentinel-qa-bulk-off-live/`.
- Pixel: historical READY WITH KNOWN RISKS at Go C (heal `/design` PASS;
  `/hage` A3 = still-managed after Secure ON probe, not heal FAIL) —
  `pixel-qa/go-c-live-9a80930a/`. Historical bulk-OFF Pixel:
  `/workspace/pixel-qa/bulk-off-verify/`. Aegis: khớp design.

Do not re-run this RPC from this attest PR.

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
- Go C (stale SPA pin `snote:legacy-secure:${slug}` heal) **shipped** live
  (#145 LNO-wins on origin `9a80930a`). After bulk OFF, browsers that still
  held a pin now follow LNO: unmanaged → silent free-edit; still-managed →
  A3 RO; LNO error fail-closed.

## Walls (this attest)

- No notes table GRANT changes.
- No Edge republish, no SPA/Worker/Realtime, no auto-ON, no origin/Pages ship.
- Do not invoke U1 convert from this job.
- `SECURITY DEFINER`, `service_role` EXECUTE only; PUBLIC / anon / authenticated
  revoked.
- This attestation does not re-apply the RPC (Pulse already invoked the
  existing live function for the 2026-09-22 named go; no re-migrate).

## Pre-apply inventory (read-only; named go)

Count live managed vs encrypted. Confirm the identity trigger still forbids
`UPDATE` managed→false. Backup managed `notes` + `note_checkpoints` before any
apply go. Go A+B and the 2026-09-22 re-bulk already ran; do not treat this
attest as another apply.

## Execute (historical; already ran — do not re-apply)

Maintenance window. `writes_enabled` must already be true (same gate as other
capability writes). As `service_role`:

```sql
SELECT public.capability_note_bulk_disable_secure(500);
-- jsonb: status, converted, skipped_encrypted, skipped_not_managed, errors[]
```

`p_limit` is 1–10000 eligible rows per call (plaintext by default; encrypted
live rows are reported in `skipped_encrypted` and left in place). Re-run
until `converted=0` **and** `errors` is empty. Then leftover live managed
plaintext should be 0, and leftover live managed encrypted should equal
`skipped_encrypted`. `converted=0` with a nonempty `errors[]` is **not**
success: those slugs stay at the head of `ORDER BY created_at, note_id` and
will block later batches until inspected. `skipped_not_managed` counts
lock-time races (already unmanaged / deleted after the candidate scan), not
the fleet of unmanaged rows. Idempotent: already unmanaged rows are not
rewritten.

Each converted row keeps only the newest `note_checkpoints` payload. Later
`note_updates` after that checkpoint’s `through_seq` are cascade-deleted with
the old `note_id` and are **not** folded into the new ydoc. Compact or accept
that tail loss before Go B.

Save the jsonb report as the go artifact (`errors[]` includes `slug` /
`noteId` when a row fails; no bodies). Spot-check N slugs: DB unmanaged, new
`note_id`, no `note_capabilities` on the new id, LNO not `managed:true`,
plain-upsert allowed. Encrypted control slug stays managed until a later
include-encrypted go.

Do **not** enable Realtime / Worker, and do **not** re-GRANT `public.notes`.
