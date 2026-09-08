# SQL 240 readiness contract (architecture + ops fold-in)

- Status: **Docs package only** — does **not** authorize apply
- Date: 2026-09-08
- Repo: `sovergarden-dev/snote`
- Live pin (product): origin `1e76e2b7` / Pages `49c127f4` / canary true / smoke `34190597619`
- Main tip may lag (docs `d31857d5` #124) — apply go SHA must be named explicitly
- Owners: Aegis (gates) · Pulse (ops) · Forge (docs PR) · Atlas (coord) · Syringa (named apply)
- Walls until named apply: no SQL 240, no Worker, no `writes_enabled` flip, no Realtime, no Edge/Pages couple

This is not SQL 240, not Realtime, not soak-complete.

Ops detail: [sql-240-ops-preflight.md](./sql-240-ops-preflight.md) (Pulse). This file is the architecture gate list.

---

## 0. Hard architecture gate (before any apply)

**Do not apply SQL 240 while Choice A editable plain `/slug` (table sync) is the live default.**

SQL 240 `REVOKE`s browser grants on `public.notes`. Choice A depends on those grants. Applying 240 with Choice A live = instant break of plain edit (provider upsert / enc-meta select).

### Required product posture at apply time (pick one)

| Option | Meaning | Required before apply |
|---|---|---|
| **A′ (preferred)** | Re-flip plain `/slug` → `CutoverNotePage` → Legacy RO (LNO) as default; capability `#owner=`/`#edit=` unchanged | SPA ship + smoke: plain RO via LNO; Home mint `#owner=` PASS; Duplicate securely **PASS** or honest-unavailable with no trapped users; Encrypt disabled+honest OK on any remaining plain path |
| **B (accept break)** | Syringa explicitly accepts plain table edit dies at apply | Written named acceptance; kill-switch plan ready |

Choice A routing contract (`SNOTE-EDITABLE-PLAIN-SLUG-ROUTING-CONTRACT.md`, Aegis artifact name — not a path in this repo; live Choice A is findings §3e / #118) remains valid **until** A′ ships. A′ is a **separate** named origin go **before** 240 apply (or same calendar day only if Atlas sequences SPA → soak smoke → 240).

---

## 1. Migration identity (verified @ `1e76e2b7`)

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
- [ ] 240 **not** already applied (Pulse SQL probes: policies/grants + `capability_note_import_legacy` absent)
- [ ] Fresh `notes_total` / `capability_managed` recorded (**do not** reuse stale 61/0)
- [ ] Tiny daily snapshot verified (<~24h); else STOP (no PITR)
- [ ] **§0 hard gate:** A′ live **or** Syringa written accept-break (B)
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
4. Plain `/slug` **does not** silently table-write (fail-closed or LNO RO per A′)
5. LNO + `?legacyRo=1` RO still work
6. Encrypt UI posture unchanged by migration
7. `version.json` unchanged unless separate Pages go was named

---

## 5. Explicit non-blockers for docs package

- Duplicate securely still honest-unavailable (product residual) — **blocks A′ preferred path** until fixed or accepted; does **not** block writing this docs package
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
| 3 | Syringa has clear separate named-go for **A′ (if needed)** then **apply 240** |
| 4 | **NOT** authorized: applying SQL 240 |

## Verdict (architecture)

**READY WITH KNOWN RISKS** to open the **docs package**.

**NOT READY** to apply while Choice A editable table path is live default — flip to A′ (or accept-break B) first.
