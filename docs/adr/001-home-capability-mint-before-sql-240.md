# ADR-001: Home mints capabilities before SQL 240

- Status: Accepted. Home mint fail-closed idle live on origin `7d00fd52` (not a SQL 240 go)
- Date: 2026-09-04
- Deciders: Aegis (architecture); Atlas (go); Syringa (named production steps)
- Evidence cut: `sovergarden-dev/snote` `main` `7d00fd52` (PR #103). Live origin `7d00fd52`, Worker `931430c0` / `5f94ab6c` (Cloudflare Version ID `5f94ab6c-fde5-4416-a3aa-74daaa2e6094`; see findings §1c). SQL 220+270 applied; 240 not applied. `writes_enabled=true`, `private_realtime_enabled=false`. Soak started 2026-09-02 ~12:01 ICT from `c5914c8e`; not complete as of 2026-09-07 ~04:11 ICT.

## Context

Production dual-mode canary has `capabilityRoutesEnabled=true`. Home mint is live on origin `7d00fd52`: Home create fail-closes on idle (re-check; no legacy `seedAndOpen`), then on `available` calls `POST note-session` `{action:"create"}` and navigates `/<slug>#owner=<token>`. Canary-on SPA mounts `CutoverNotePage`: plain `/<slug>` lazy-loads `LegacyNotePage` (Phase B LNO read-only). `anon` RLS on `public.notes` (`NOT capability_managed`) still exists because SQL 240 is not applied. `capability_note_import_legacy` (SQL 240) is absent.

SQL 240 is irreversible: rollback never restores `notes` GRANT/policies. Kill switch is `capability_runtime_set(false, false)` → Edge 503. Tiny plan has no PITR (daily snapshot, ~24h worst-case loss). Staging `snote-g3c-staging` is inactive.

A 2026-09-01 snapshot had 61 notes / 0 `capability_managed`. Dual-mode soak started without Home mint; mint is now live on canary so later soak can include capability create/sync/outbox. Not soak-complete. Not SQL 240.

## Decision

When the mint path is built (GitHub first; production only on a named go):

1. Home persists an owner-candidate capability, then `POST note-session` `{action:"create", slug}`, then navigates `/<slug>#owner=<token>`.
2. Do **not** apply SQL 240 until that path exists, soak has capability-write evidence, and Syringa names 240.
3. Trust/identity (“quen/lạ”) stays a local label and must not become a write gate.

This ADR does **not** authorize origin, Worker, Edge, SQL 240, `private_realtime_enabled`, or Home mint in production.
A later named Pages deploy of #95 made Home mint live on canary origin `e05c73ea`; #98 made fail-closed idle mint live on `addeeb29`; #101+#103 made `CutoverNotePage` + Phase B LNO live on `7d00fd52`; this ADR still does not authorize SQL 240.

## Alternatives

| Option | What | Why not (now) |
|---|---|---|
| A. SQL 240 first | Revoke anon `notes` access while Home still upserts the table | Closes the only live create/write path unless Cutover+LNO are already live. Import-legacy RPC is what 240 adds. Tiny has no PITR. |
| B. Stay dual-mode indefinitely | Canary SPA + legacy table forever | Slug remains a write credential. Additive 220/270 never become the authz model. |
| C. Staging + PITR, then 240, mint later | Prove cutover on a clone first | Staging is inactive. Still leaves production Home unable to create after 240. Mint remains a prerequisite for a usable post-cutover product, whether done before or on a clone. |
| D. Private Realtime before mint | Flip `private_realtime_enabled` + auth canary | `NotePage` currently **rejects** `syncTransport !== "polling"`. New client contract, Turnstile/anonymous JWT. Orthogonal to “can anyone create a capability note from Home”. |
| **E. Mint before 240 (this)** | Home create → fragment owner → polling sync | Gives soak a real capability write path without the irreversible revoke. Second-device and share remain capability-scoped, not accounts. |

## Tradeoffs

- Product: creating a note stops being “type a slug”. Owner token lives in the URL fragment (not sent to origin). Losing the fragment without a stored owner capability is lockout — rotation of owner is intentionally not exposed.
- Security: mint does not close legacy slug writes. Until 240, both paths coexist. Encryption pin on the table stays attacker-writable on the legacy path.
- Ops: Tiny still has no PITR. Mint is reversible (don’t have to apply 240). 240 is not.
- Soak: without mint, 48h dual-mode does not prove `note-session`/`note-sync`/outbox. With mint, soak can use synthetic or real capability notes; still need CF-Connecting-IP anti-spoof before opening public create (currently unattested; staging inactive).
- Privacy: Worker `invocation_logs` are **live** on `syrin-prerender` (`931430c0` / `5f94ab6c`). They can log raw URLs including `#`-less locators. Do not couple mint ship to a further Worker deploy; this privacy risk is already live.

## Consequences

- Forge implements Home create against existing `note-session` contract (`createCapabilityApi().createNote`). No new Edge function.
- Failures stay existing codes: `slug_unavailable` 409, admission 429/503, missing HMAC 503.
- `legacyOnly` dual-mode remains until 240. Home existence check today is `select slug, char_count from notes` — after mint, capability-managed rows are invisible to that query; Home must not treat “not in notes” as “slug free” once create can 409 from the RPC.
- SQL 240, private Realtime, and quen/lạ overlay stay separately named. Worker log deploy is already live (§1c).

## Open questions (do not guess)

1. CF-Connecting-IP anti-spoof on the public create path.
2. Whether `share-view` is SHA-pinned; `LEGACY_SHARE_CUTOFF` set.
3. Current `capability_managed` count (do not reuse 61/0).
4. Pre-240 snapshot recency on Tiny.
