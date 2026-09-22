# SQL 240 readiness contract (architecture + ops fold-in)

- Status: **Docs package only** — does **not** authorize apply (SQL 240 already applied; do not re-apply)
- Date: 2026-09-15
- Repo: `sovergarden-dev/snote`
- Live pin (product): origin `9a80930a` / Pages `8e64829c` / canary true; historical smoke `34986611791` remains the `0cdcdc0f` / `1b9ed3d1` pin
- Git tip (apply): `46ddaf01` (#148 3-arg `p_slugs` allowlist Go SQL **applied live**; historical `bd11deed` #142 2-arg bulk RPC + #143 PWA smoke harden) — live origin still `9a80930a` (#145 Go C); re-bulk OFF ALL 6 Pulse PASS 2026-09-22 is **historical**; residual `aggadagdade` still managed; this docs attest does not change origin
- Owners: Aegis (gates) · Pulse (ops) · Forge (docs PR) · Atlas (coord) · Syringa (named apply)
- Walls: SQL 240 already applied; W2 SQL `capability_note_plain_upsert` / `capability_note_disable_secure` applied live; U1 SQL `capability_note_convert_legacy` applied live; bulk RPC `capability_note_bulk_disable_secure` **applied** live (Go A+B Pulse PASS; Go C **shipped** live; re-bulk OFF ALL 6 Pulse PASS 2026-09-22 **historical**; 3-arg `p_slugs` allowlist **applied live** Go SQL Pulse PASS, git tip `46ddaf01` / #148; residual `aggadagdade` still managed, **no bulk OFF**); Edge `plain-upsert` / `disable-secure` / `convert-legacy` published (Pulse `umsg_01m21zhm…` for `convert-legacy`); Worker HOLD (no redeploy), `writes_enabled` HOLD, Realtime HOLD; this docs PR does not re-apply SQL U1 or run bulk OFF and does not re-publish Edge / couple Pages

This is not SQL 240, not Realtime, not soak-complete.

Ops detail: [sql-240-ops-preflight.md](./sql-240-ops-preflight.md) (Pulse). This file is the architecture gate list.

---

## 0. Hard architecture gate (before any apply)

**W2 is live** on origin `9a80930a`: plain `/slug` = `CutoverNotePage` → editable `NotePage` (free-edit).
W1 convert-on-write as product default is **superseded**. A′ Cutover/LNO RO default is **superseded**; A′ remains the `?legacyRo=1` / Legacy Advanced path.
Choice A editable-plain is **not** the live default. SQL 240 already applied.
Duplicate securely is enabled on Legacy RO only (PR #128; Edge `note-session` `import-legacy`).
SQL `capability_note_plain_upsert` / `capability_note_disable_secure` are **applied** live. U1 SQL `capability_note_convert_legacy` is **applied** live. Edge `note-session` `plain-upsert`, `disable-secure`, and `convert-legacy` are **published** (Pulse `umsg_01m21zhm…` for `convert-legacy`).
Worker / `writes_enabled` / Realtime still HOLD. This docs pin does not re-apply SQL 240 or U1 and does not re-publish Edge.

SQL 240 `REVOKE`s browser grants on `public.notes`. Choice A depended on those
grants. Applying 240 while Choice A was live would have instantly broken plain
edit (provider upsert / enc-meta select). That live-default blocker was cleared
by A′ and remains cleared under W2 (plain persist is Edge `plain-upsert`, not
table upsert); remaining gates below still HOLD apply.

### Required product posture at apply time (pick one)

| Option | Meaning | Required before apply |
|---|---|---|
| **A′ (preferred at apply; superseded as live default)** | Re-flip plain `/slug` → `CutoverNotePage` → Legacy RO (LNO) as default; capability `#owner=`/`#edit=` unchanged | SPA ship + smoke: plain RO via LNO; Home mint `#owner=` PASS; Duplicate securely **PASS** or honest-unavailable with no trapped users; Encrypt omit on plain RO; `#owner=` Encrypt active |
| **B (accept break)** | Syringa explicitly accepts plain table edit dies at apply | Written named acceptance; kill-switch plan ready |

Choice A routing contract (`SNOTE-EDITABLE-PLAIN-SLUG-ROUTING-CONTRACT.md`, Aegis artifact name — not a path in this repo) is **superseded** by A′ then W1 then live W2 (findings §3e / #126 / #130 / #135). A′ was a **prerequisite** for 240, not SQL 240 apply (or same calendar day only if Atlas sequences SPA → soak smoke → 240).

W2 free-edit is live on origin `9a80930a` ([a-prime-cutover-restore.md](./a-prime-cutover-restore.md) records A′ as superseded default / remaining Legacy RO path; W1 convert-on-write is superseded as product default; prior A3 pin `0cdcdc0f`). Choice A (#118) editable-plain default is **superseded**. Duplicate securely (#128) is enabled on Legacy RO only. This does not authorize re-apply.

---

## 1. Migration identity (verified @ `0cdcdc0f`)

| Field | Value |
|---|---|
| File | `supabase/migrations/20260724000000_atomic_capability_cutover.sql` |
| Lines | 245 |
| SHA-256 | `1043a46844e66859ccb8bec16888d6dd78f5f5e5a04df203f220a9b90302cf2f` |

Re-hash on the **named go SHA** immediately before apply. Mismatch → STOP.

---

## 2. Pre-apply checklist (architecture ∩ ops)

Copy Pulse §0–§2; architecture adds:

- [ ] Live `version.json` SHA = go SHA; `capabilityRoutesEnabled` true
- [ ] Migration sha256 matches §1 for that SHA
- [x] 240 already applied (do **not** re-apply). Historical pre-apply probe was: policies/grants + `capability_note_import_legacy` absent
- [ ] Fresh `notes_total` / `capability_managed` recorded (**do not** reuse stale 61/0)
- [ ] Tiny daily snapshot verified (<~24h); else STOP (no PITR)
- [ ] **§0 hard gate:** W1 live (or A′ live) **or** Syringa written accept-break (B)
- [ ] Home mint → `#owner=` smoke PASS on live
- [ ] LNO `exists`/`open` smoke PASS (legacy exact-match)
- [ ] RawView `/:slug.md` smoke PASS (Phase C)
- [ ] Encrypt plain = disabled+honest; `#owner=` Encrypt active
- [ ] Kill switch path known: `capability_runtime_set` → Edge 503 (`writes_disabled`); **not** env `CAPABILITY_WRITE_DISABLED`
- [ ] Apply **not** coupled to Worker / Pages / `writes_enabled` / Realtime / unrelated Edge

---

## 3. Irreversibility

- Revoke is **one-way** for grants/policies.
- Rollback ≠ re-GRANT anon. Rollback = runtime read-only / fail-closed.
- Re-GRANT requires **new ADR** + Syringa named go.

---

## 4. Post-apply verify (must)

Ops SQL (Pulse §5) plus product:

1. No anon/authenticated usable grants on `notes` (and related per migration)
2. `capability_note_import_legacy` present
3. Home mint / `#owner=` still works (Edge)
4. Plain `/slug` **does not** silently table-write (W2 free-edit via Edge `plain-upsert`, or LNO RO per remaining A′ `?legacyRo=1`)
5. LNO + `?legacyRo=1` RO still work
6. Encrypt UI posture unchanged by migration
7. `version.json` unchanged unless separate Pages go was named

---

## 5. Explicit non-blockers for docs package

- Duplicate securely is enabled on Legacy RO only (PR #128; Edge `note-session` `import-legacy`) — does **not** authorize re-apply
- U1 SQL `capability_note_convert_legacy` **applied** live; Edge `convert-legacy` **published** (Pulse `umsg_01m21zhm…`) — this pin does **not** re-apply/republish
- Soak “≥48h from 2026-09-02” narrative — record as residual; Atlas/Syringa decide if soak is still a soft gate
- quen/lạ parked (label only — never write ACL)
- Worker `invocation_logs` privacy — do not couple to 240

---

## 6. Forge docs-only PR scope

Include (English artifacts OK):

1. This readiness contract (or condensed form under `docs/`)
2. Link/embed Pulse ops preflight commands + snapshot STOP rule
3. Migration identity table
4. Named-go template: **apply** separate from **docs merge** and from **A′ SPA ship**
5. Walls phrase: no apply / no Worker / no writes_enabled / no Realtime from this PR

Out of scope for that PR: applying 240, origin ship, Worker, Realtime.

---

## 7. Acceptance — “readiness package ready”

| # | Criterion |
|---|---|
| 1 | Aegis contract + Pulse ops folded (this doc + OPS-PREFLIGHT) |
| 2 | Forge docs-only PR green; Sentinel light-review |
| 3 | Syringa has clear separate named-go for **apply 240** (A′ prerequisite was live; W2 is now the live default) |
| 4 | **NOT** authorized: applying SQL 240 |

## Verdict (architecture)

**READY WITH KNOWN RISKS** to open the **docs package**.

**W2 is live** (plain `/slug` = free-edit; W1 convert-on-write superseded as default; A′ remains `?legacyRo=1`; Duplicate securely enabled on Legacy RO). SQL 240 already applied. W2 SQL `capability_note_plain_upsert` / `capability_note_disable_secure` **applied** live; U1 SQL `capability_note_convert_legacy` **applied** live; Edge `plain-upsert` / `disable-secure` / `convert-legacy` **published** (Pulse `umsg_01m21zhm…` for `convert-legacy`). Worker / `writes_enabled` / Realtime still **HOLD**. Not soak-complete.
