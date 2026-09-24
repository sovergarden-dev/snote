# SQL 240 ops preflight (docs only — do not apply)

Status: **SQL 240 already applied — do not re-apply.** Docs package does not authorize apply
of `20260724000000_atomic_capability_cutover.sql` again.

This is not SQL 240, not Realtime, not soak-complete.

Owner (ops): Pulse  
Architecture: Aegis ([sql-240-readiness-contract.md](./sql-240-readiness-contract.md))  
Named go required: Syringa (apply) / Atlas (coordinate)

## 0. Live baseline (as of 2026-09-24)

| Surface | Value |
|---|---|
| Origin `version.json` | `deployedSha` `4e23fe22…`, `capabilityRoutesEnabled` true, buildId `1790270578761-qdexmj04` |
| Pages | `snote-g4-origin` deploy `b53b133a` |
| Git tip (apply) | `46ddaf01` (#148 3-arg `p_slugs` allowlist Go SQL **applied live**; historical `bd11deed` #142 2-arg bulk RPC + #143 PWA smoke harden) — live origin now `4e23fe22` (#163); #161 pin `a6756188` is **historical**; #159 pin `08c25172` is **historical**; #157 pin `610662a9` is **historical**; #155 pin `3b4ea9f9` is **historical**; #153 pin `1b172544` is **historical**; #151 pin `44b02cb3` is **historical**; Go C pin `9a80930a` is **historical**; re-bulk OFF ALL 6 Pulse PASS 2026-09-22 is **historical**; Go SQL residual `aggadagdade` still managed is **historical**; **Go Ops allowlist bulk OFF** 2→0 Pulse PASS (residual **cleared**, **not fleet**); this docs attest does not change origin |
| Walls | SQL **240 already applied**; W2 SQL `capability_note_plain_upsert` / `capability_note_disable_secure` **applied** live; U1 SQL `capability_note_convert_legacy` **applied** live; bulk RPC `capability_note_bulk_disable_secure` **applied** live (Go A+B Pulse PASS; Go C **shipped** live; re-bulk OFF ALL 6 Pulse PASS 2026-09-22 **historical**; 3-arg `p_slugs` allowlist **applied live** Go SQL Pulse PASS, git tip `46ddaf01` / #148; Go SQL residual `aggadagdade` still managed, **no bulk OFF** — **historical**; **Go Ops allowlist bulk OFF** 2→0 Pulse PASS, residual **cleared**, **not fleet**); previously published Edge `plain-upsert` / `disable-secure` / `convert-legacy` remain **published** (Pulse `umsg_01m21zhm…` for `convert-legacy`); #151 Edge XOR is **in-repo only / not deployed live**; Worker HOLD (no redeploy), `writes_enabled` HOLD, Realtime HOLD. This docs PR does not re-apply SQL U1 or run bulk OFF or re-publish Edge |
| Live default / apply blocker | W2 live: plain `/slug` → `CutoverNotePage` → editable `NotePage` (free-edit). W1 convert-on-write default superseded. A′ RO default superseded. Duplicate securely enabled on Legacy RO only. Choice A editable table path is **not** the live default. **Do not re-apply** 240 from this docs pin. See [sql-240-readiness-contract.md](./sql-240-readiness-contract.md) §0 and [a-prime-cutover-restore.md](./a-prime-cutover-restore.md). |
| Product still live (not a go) | W2 free-edit + Legacy opt-in / A3 bare RO + Go C LNO-wins + #151 create-bare + #153 Ko-fi FAB + #155 idle dismiss 24h + #157 polish Copy for AI + #159 selection-match cap 4000 + nested-overflow scroll feel + #161 same-note split via tab-scoped note-host + #163 `provider.connect()` idempotent latch (MEDIUM-2 CLOSED); A′ live as Legacy RO (`?legacyRo=1`); Duplicate securely enabled on Legacy RO; Encrypt allowed on unmanaged without `#owner=`; Legacy↔Encrypt XOR in UI; LNO Phase B/C; Home create always bare `seedAndOpen`; canary on; W2 SQL applied live; U1 SQL applied live; previously published Edge plain-upsert / disable-secure / convert-legacy remain published (Pulse `umsg_01m21zhm…` for convert-legacy); #151 Edge XOR not deployed live; Worker / `writes_enabled` / Realtime still HOLD |
| Prior live pin (#161) | `a6756188` / Pages `cf94d1b2` / buildId `1790261840240-kdcu3lki` |
| Prior live pin (#159) | `08c25172` / Pages `1db84523` / buildId `1790170318028-nxe1ecb2` |
| Prior live pin (#157) | `610662a9` / Pages `33667a6a` / buildId `1790148079761-vf6vjb0l` |
| Prior live pin (#155) | `3b4ea9f9` / Pages `62f641c7` / buildId `1790100180966-ukuhpb1q` |
| Prior live pin (#153) | `1b172544` / Pages `5527f154` / buildId `1790083696998-uk4r5sxu` |
| Prior live pin (#151) | `44b02cb3` / Pages `b44849c4` / buildId `1790066192935-qg7oaft7` |
| Prior live pin (Go C) | `9a80930a` / Pages `8e64829c` (`8e64829c-c182-45d1-ba27-5f43af7d20fd`) / buildId `1789612258815-8yx2tdut` |
| Prior live pin (historical A3) | `0cdcdc0f` / Pages `1b9ed3d1` / buildId `1789484737351-s31qn3nf` |

Re-verify live before any named apply:

```bash
curl -sS -H 'Cache-Control: no-cache' "https://note.syrin.online/version.json"
# expect deployedSha prefix matching the go SHA; capabilityRoutesEnabled true
```

## 1. Migration identity (pre-apply)

File: `supabase/migrations/20260724000000_atomic_capability_cutover.sql`

At origin pin `0cdcdc0f`:

- Lines: 245
- SHA-256: `1043a46844e66859ccb8bec16888d6dd78f5f5e5a04df203f220a9b90302cf2f`

Pre-apply:

```bash
# from detached go SHA
sha256sum supabase/migrations/20260724000000_atomic_capability_cutover.sql
# must match recorded identity for that go SHA
```

Confirm not already applied (historical pre-apply probe; SQL 240 is already
applied on live — expect `capability_note_import_legacy` present; do not re-apply)
(service_role / SQL editor — read-only):

```sql
SELECT to_regprocedure('public.capability_note_import_legacy(text,text,text,text,text,text,boolean,text,text,integer)');

SELECT polname FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'notes'
ORDER BY 1;

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'notes'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY 1, 2;
```

Also record:

```sql
SELECT public.capability_runtime_state();
-- JSON writesEnabled / privateRealtimeEnabled. Do not SELECT capability_runtime
-- (no such table). Do not SELECT capability_runtime_settings as service_role
-- (REVOKE ALL). Canonical RPC: docs/security/atomic-capability-cutover.md.

SELECT count(*) AS notes_total,
       count(*) FILTER (WHERE capability_managed) AS capability_managed
FROM public.notes;
-- Do NOT reuse stale 61/0 snapshot from 2026-09-01
```

## 2. Backup / snapshot (Tiny — no PITR)

Facts (see `docs/security-findings.md` §3c, cutover doc):

- Lovable Cloud **Tiny**: **no PITR**
- Recovery = **daily snapshot** only → worst-case ~24h data loss
- Staging `snote-g3c-staging` inactive — do not claim staging proof

**Immediate pre-go (human in Lovable dashboard):**

1. Open project backup / daily snapshot panel.
2. Record: latest snapshot UTC timestamp, status, project id.
3. If latest snapshot is older than ~24h or missing: **STOP** — do not apply 240.
4. Prefer waiting until a fresh daily snapshot lands if cutover is same-day high-churn.

Document in tracking issue:

```
snapshot_verified_at_ict:
snapshot_latest_utc:
snapshot_status:
verifier:
```

This verify is **not** `capability_runtime_set` and **not** SQL 240 apply.

## 3. Irreversibility & kill switch

- Applying 240 **revokes** browser `notes` (and related) grants/policies.
- Rollback **never** restores `notes` GRANT/policies.
- Operational rollback = API read-only via runtime kill switch, e.g.:

```sql
-- ONLY after named go for rollback; example shape — use repo-canonical RPC
SELECT public.capability_runtime_set(false, false);
-- Edge expected to 503 writes; clients fail closed
```

Do **not** attempt to “undo” 240 by re-GRANT anon policies in production without a new ADR + named go.

## 4. Historical apply procedure (SQL 240 already applied — do not re-apply)

SQL 240 is already applied. Do not run this procedure. The steps below are the
original named-go template only.

When Syringa named apply (historical; separate go from this doc):

1. Re-run §0–§2 same day.
2. **STOP** unless A′ is live (plain `/slug` → `CutoverNotePage` → LNO RO) **or** Syringa has written accept-break B **or** W2 free-edit is the live default (plain `/slug` is not the Choice A table path). W2 is live on `4e23fe22` (prior pins `a6756188`, `08c25172`, `610662a9`, `3b4ea9f9`, `1b172544`, `44b02cb3`, `9a80930a`, `0cdcdc0f`); A′ remains the `?legacyRo=1` path. SQL 240 already applied; do not re-apply from this docs pin.
3. Do **not** apply. SQL 240 is already applied. Historical step was: apply migration via approved production SQL path (Lovable Cloud / service_role editor) — **one transaction** as written (`pg_advisory_xact_lock(20260724000000)`).
4. Do **not** couple: Worker redeploy, Pages redeploy, `writes_enabled` flip, `private_realtime_enabled`, Edge unrelated deploys.
5. Immediately run §5 post-verify.
6. Record apply ICT timestamp + operator + migration sha256.

## 5. Post-apply verification commands

```sql
SELECT polname FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'notes';

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'notes'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC');

SELECT to_regprocedure('public.capability_note_import_legacy(text,text,text,text,text,text,boolean,text,text,integer)');
```

Product smoke (after named go, not part of this docs package alone):

- Home mint create → `#owner=` path still works via Edge.
- Plain `/slug` W2: free-edit via Edge `plain-upsert`; no direct table write as anon (expect fail-closed / Edge-only). A′ LNO RO remains on `?legacyRo=1`. After Legacy ON, bare `/slug` is AC A3 RO.
- LNO `exists`/`open` still exact-match read-only.
- Legacy opt-in `?legacyRo=1` still RO.
- Encrypt disabled on free-edit (Legacy OFF); available after Legacy ON; `#owner=` Encrypt active unchanged by 240 UI-wise.

```bash
curl -sS -H 'Cache-Control: no-cache' "https://note.syrin.online/version.json"
# origin SHA unchanged unless a separate Pages go was named
```

## 6. Residual risks (ops view)

| Risk | Note |
|---|---|
| No PITR | Snapshot-only rollback window |
| Irreversible revoke | Kill switch ≠ restore grants |
| Soak not complete | ADR-001: soak started 2026-09-02; still not soak-complete as of Encrypt loop close |
| Duplicate securely | Enabled (PR #128; Edge `note-session` `import-legacy`) — not an ops blocker for docs package |
| quen/lạ | Parked label-only — must not become write ACL |
| CF-Connecting-IP | Open question for public create anti-spoof |
| Worker invocation_logs | Already live; privacy risk; do not couple 240 to Worker ship |

## 7. Acceptance for “readiness package” (this GitHub-only work)

Done when:

1. Aegis checklist/contract references this ops preflight (or merges it).
2. Forge opens docs-only PR — **no** migration apply, **no** origin/Worker/`writes_enabled` change.
3. Sentinel light-reviews docs accuracy vs live pin + migration identity.
4. Syringa has a clear named-go template for **apply** later (separate from merge of docs).

**NOT done / NOT authorized by this package:** applying SQL 240 again (already applied).
