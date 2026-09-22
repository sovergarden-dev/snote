# Bulk disable Secure (ops runbook)

Status: **Go A+B applied live** (Syringa named go; Pulse **PASS**). Go C pin
heal **shipped** live (#145 LNO-wins on origin `9a80930a`). **Re-bulk OFF ALL 6**
plaintext **PASS** (Syringa named go 2026-09-22; Pulse **PASS**; existing live
RPC, **no re-migrate**). Allowlist `p_slugs` (3-arg) SQL is **applied live**
(Syringa named **Go SQL** 2026-09-22; Pulse **PASS**; git tip `46ddaf01` /
#148). **Go Ops allowlist bulk OFF** 2→0 **PASS** (Syringa named go 2026-09-22;
Pulse **PASS**; existing 3-arg live RPC, **no re-migrate**, **not fleet**).
Live production is the 3-arg RPC; the 2-arg overload is **DROP**ped.
This document is a **docs attestation**. It does **not** re-apply SQL, does
**not** re-run bulk convert / fleet NULL, and does **not** deploy origin /
Pages / Worker / Edge. Worker / Realtime / `writes_enabled` still HOLD. Live
SPA origin is `1b172544` / Pages `5527f154` (#153). Historical pin at #151
was `44b02cb3` / Pages `b44849c4`. Historical pin at Go C /
Go SQL / Go Ops attests was `9a80930a` / Pages `8e64829c` (SQL/ops apply does not move
Pages). Git docs tip after #149 is `836753fe` (docs tip at the Go Ops attest).
Residual **cleared**: Pulse pre `managed_live=2` (`aggadagdade`, `pbhcusvb`) →
allowlist `converted=2` → post `managed_live=0`; encrypted=0. Do **not** claim
a fleet NULL convert. Do **not** claim a SPA ship.

Live RPC (applied): `public.capability_note_bulk_disable_secure(p_limit int, p_include_encrypted bool default false, p_slugs text[] default null)`  
Live migration: `supabase/migrations/20260922000000_capability_note_bulk_disable_secure_p_slugs.sql`  
SHA-256: `f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132`  
Git tip when applied: `46ddaf01` (#148 squash
`46ddaf012bea1d01a6235e2be7e9132555d6cd84`). At that attest, live SPA origin remained
`9a80930a` / Pages `8e64829c` (SQL/ops apply does not ship origin). Git docs
tip after #149 (`836753fe`) may advance; live SPA later moved to `44b02cb3`,
then `1b172544`.

Historical 2-arg (Go A, superseded live): `public.capability_note_bulk_disable_secure(p_limit int, p_include_encrypted bool default false)`  
Historical migration: `supabase/migrations/20260916000000_capability_note_bulk_disable_secure.sql`  
SHA-256: `a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850`  
Git tip when applied: `bd11deed` (#142 lineage; tip also includes #143
`pwa-update-smoke` harden). At that attest, live SPA origin was still
`0cdcdc0f` / Pages `1b9ed3d1` (bulk OFF is SQL/ops, not a SPA ship). Current
live origin is `1b172544` / Pages `5527f154`. Historical #151 pin was
`44b02cb3` / Pages `b44849c4`. Historical Go C pin was
`9a80930a` / Pages `8e64829c`. Git docs tip may advance.

Hard `DROP FUNCTION public.capability_note_bulk_disable_secure(integer, boolean);` then CREATE 3-arg. No 2-arg wrapper. Omitting `p_slugs` keeps `(500)` / `(500, false)` as fleet-wide.

## Live go (2026-09-16 apply; 2026-09-17 Go C origin; 2026-09-22 re-bulk; 2026-09-22 Go SQL; 2026-09-22 Go Ops allowlist)

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
  fleet RO count was unavailable (401). That post-count is **historical**.
  Later Go SQL preflight found residual `managed_live=1` (`aggadagdade`);
  do **not** treat re-bulk 0 as the current fleet. Later Go Ops allowlist
  bulk OFF 2→0 (not fleet) is the current Pulse/Sentinel post-verify.
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
- Go SQL (2026-09-22): Pulse **PASS**. Applied
  `20260922000000_capability_note_bulk_disable_secure_p_slugs.sql` sha256
  `f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132` at tip
  `46ddaf01`. DROP 2-arg → CREATE 3-arg live; `service_role` EXECUTE;
  anon/authenticated revoked. Smoke `ARRAY[]` → `converted=0`
  `scope=allowlist`; miss → `skipped_allowlist_miss=1`. NULL fleet **not**
  executed (preflight `managed_live=1` residual slug `aggadagdade`; body RO
  confirms NULL→fleet). Residual untouched after smoke. **No bulk OFF.**
  Artifact `/workspace/pulse-allowlist-sql-46ddaf01/`.
- Sentinel (Go SQL 2026-09-22): **READY** (SQL contract) —
  `/workspace/sentinel-qa-allowlist-sql-46ddaf01/`. Same hash/grants/smokes;
  residual untouched; walls HOLD. LOWs: (1) `schema_migrations` path missing
  (named-go body apply, not CLI-tracked); (2) SPA tip still `9a80930a`
  expected (SQL apply does not move Pages).
- Go Ops allowlist bulk OFF (2026-09-22): Pulse **PASS**. Existing live 3-arg
  RPC `capability_note_bulk_disable_secure(500,false,ARRAY[aggadagdade,pbhcusvb])`
  — **no re-migrate**, **not fleet NULL**. Pre: `managed_live=2` plaintext
  (`aggadagdade`, `pbhcusvb`); encrypted=0 (count > Go SQL known residual 1;
  allowlist both). Pulse `converted=2`, `scope=allowlist`,
  `allowlist_requested=2`, `allowlist_matched_managed=2`,
  `skipped_encrypted=0`, `errors=[]`; post-verify `managed_live=0`,
  encrypted=0. `note_id` rotation accepted (same as Go B). Artifact
  `/workspace/pulse-bulk-off-allowlist-20260922/`. Claim `managed_live=0`
  only as Pulse post-verify + Sentinel spot; anon fleet RO count unavailable
  (401). Residual **cleared**. At that attest, live SPA still `9a80930a` (this ops go does
  not ship origin). Git docs tip after #149 is `836753fe`.
- Sentinel (Go Ops allowlist 2026-09-22): **READY** (bulk OFF live gate) —
  `/workspace/sentinel-qa-bulk-off-allowlist-20260922/`. LNO unmanaged both
  slugs; plain-upsert `aggadagdade` 200 (not 409); post `managed_live=0`;
  walls HOLD. BLOCKER/HIGH/MEDIUM none. LOWs: (1) SPA bare-route free-edit
  deferred (API-only OK); (2) first plain-upsert operator miss 400 missing
  `charCount`, retry 200. Tip still `9a80930a` expected.

Do not re-run this RPC from this attest PR. Do not re-apply the 3-arg
allowlist migration from this docs PR. Do not call NULL/omit fleet. Residual
already converted via allowlist; do not re-OFF those slugs.

## Allowlist Q1 (applied live — schema + Go Ops allowlist 2 slugs PASS)

Atlas ACCEPT / Aegis design A. Pulse/Sentinel Q1 locked:

- **NULL/omit = fleet-wide** (unchanged Go A/B). Go SQL and Go Ops **did not**
  invoke NULL (`managed_live=1` residual at Go SQL would have converted as
  fleet; Go Ops used a 2-slug allowlist instead).
- `{}` / cardinality 0 = **no-op** (converted=0, `scope=allowlist`, NOT fleet).
  Live smoke: `ARRAY[]` → `converted=0` `scope=allowlist`.
- Non-empty = exact `n.slug = ANY (p_slugs)` among managed+eligible (no lower/trim).
  Live smoke miss: `skipped_allowlist_miss=1`.
- `p_limit` remains a safety cap (1–10000) even under allowlist.
- Oversized allowlist (`cardinality(p_slugs) > 10000`) → `status: invalid`.
- **soft-miss:** allowlist misses are not hard errors (`skipped_allowlist_miss`).
  Encrypted managed slug in the allowlist with `p_include_encrypted=false` counts
  as `skipped_encrypted`, not a miss.
- No `p_strict` in v1.

Additive jsonb (keep existing `status` / `converted` / `skipped_encrypted` /
`skipped_not_managed` / `errors`): `scope` (`fleet`|`allowlist`),
`allowlist_requested`, `allowlist_matched_managed`, `skipped_allowlist_miss`,
`skipped_limit`.

## Named-go checklist

### Go SQL (schema) — live applied 2026-09-22

- [x] Design ACCEPT (Atlas/Syringa)
- [x] Forge: migration `DROP FUNCTION` 2-arg + CREATE 3-arg + tests (#148)
- [x] Sentinel: independent LIVE contract verify **READY**
- [x] Pulse: named-go body apply **PASS** (no origin/Edge/Worker)
- [x] Syringa **named Go SQL** → Pulse apply migration only
- [x] Verify: 3-arg only (2-arg GONE); anon/authenticated EXECUTE false;
      `service_role` true; empty ARRAY no-op; miss `skipped_allowlist_miss=1`

### Go Ops (run) — allowlist 2 slugs **applied live** 2026-09-22

- [x] RO inventory: managed plaintext count + slug list (`managed_live=2`;
      `aggadagdade`, `pbhcusvb`; encrypted=0)
- [x] Write allowlist = exact slug set in go text (or omit/NULL for fleet; `{}` is **no-op**)
- [x] If inventory ⊈ allowlist and go ≠ fleet → STOP or expand (inventory = both;
      known residual had been 1 — expanded allowlist, **not** fleet)
- [x] Syringa **named Go Ops** citing allowlist (or fleet)
- [x] Pulse: `capability_note_bulk_disable_secure(p_limit, false, p_slugs)`
- [x] Drain until `converted=0` (or allowlist exhausted) **and** `errors` empty.
      Named-go ops may STOP if `skipped_allowlist_miss ≠ 0` when the go required
      exact hits. (`converted=2`, `errors=[]`, `skipped_allowlist_miss` unused)
- [x] Post: `managed_live` for scoped slugs = 0; spot LNO unmanaged + plain-upsert 200
- [x] Docs attest (no origin ship)

Residual **cleared** (`managed_live=0`). Do **not** re-run the RPC from this
attest. Do **not** call NULL/omit fleet. Do **not** ship origin.

Walls HOLD unless a later named go says otherwise: no Pages / Worker / Edge /
Realtime / `writes_enabled` flip from this workstream.

## B1 + Syringa locks

- Selection: all live managed rows (`capability_managed=true`, `deleted_at IS NULL`).
  Live 3-arg adds `p_slugs` allowlist on top of that (NULL/omit = fleet).
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
- This attestation does not re-apply SQL (Pulse already applied the 3-arg
  migration on named Go SQL). It does not re-run bulk convert or fleet NULL.
  Residual already cleared by Go Ops allowlist (`managed_live=0`).

## Pre-apply inventory (read-only; named go)

Count live managed vs encrypted. Confirm the identity trigger still forbids
`UPDATE` managed→false. Backup managed `notes` + `note_checkpoints` before any
apply go. Go A+B, the 2026-09-22 re-bulk, Go SQL, and Go Ops allowlist already
ran; do not treat this attest as another apply or another convert.

## Execute (historical Go A/B / re-bulk; already ran — do not re-apply)

Maintenance window. `writes_enabled` must already be true (same gate as other
capability writes). As `service_role`:

```sql
SELECT public.capability_note_bulk_disable_secure(500);
-- jsonb: status, converted, skipped_encrypted, skipped_not_managed, errors[]
```

Live 3-arg (applied; do **not** run from this attest — Pulse already ran
**named Go Ops** allowlist). NULL/omit is fleet-wide; do **not** call it:

```sql
-- fleet-wide plaintext (same as omit) — DO NOT CALL from this attest
SELECT public.capability_note_bulk_disable_secure(500, false, NULL);
-- no-op (live smoke: converted=0, scope=allowlist)
SELECT public.capability_note_bulk_disable_secure(500, false, '{}');
-- allowlist (historical Go Ops: ARRAY['aggadagdade','pbhcusvb'] — do not re-run)
SELECT public.capability_note_bulk_disable_secure(
  500, false, ARRAY['hage','xqmqh53z']
);
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
