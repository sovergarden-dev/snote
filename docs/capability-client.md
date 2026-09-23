# Capability client and durable sync

This client is the dual-mode bridge between legacy slug notes and capability-managed notes. A slug is only a locator. Authorization is carried in the URL fragment, which browsers do not send to the server:

- owner: `/<slug>#owner=<43-character token>`
- editor: `/<slug>#edit=<43-character token>`
- viewer: `/s#view=<43-character token>`

The SPA parses those fragments and opens `note-session` only when
`VITE_CAPABILITY_ROUTES_ENABLED` is exactly `"true"`. That canary covers
NotePage owner/edit routes and SharePage `/s#view`. Missing, empty, or any
other value keeps both pages `legacyOnly`. The same flag fail-closes
`createCapabilityApi()`: `note-session`, `note-sync`, and `note-manage`
throw `capability API unavailable` without fetching, and default Auth
minting stays off. Ordinary Vite builds follow `.env.example`
(`VITE_CAPABILITY_ROUTES_ENABLED=false`) and attest
`capabilityRoutesEnabled: false`. Live production `build:release` attests
`capabilityRoutesEnabled: true` (findings §3e / §3k / §3l / §3m; live origin `3b4ea9f9`).
Prior origin `1b172544` shipped #153 Ko-fi FAB. Prior origin `44b02cb3` shipped #151 create-bare. Prior origin `9a80930a` shipped Go C LNO-wins (#145). Prior origin `0cdcdc0f` shipped W2 free-edit + Legacy opt-in (#135/#137/#138/#139; prior
#130/#131 W1 convert-on-write as product default is **superseded**): canary-on
plain `/slug` mounts `CutoverNotePage` → editable `NotePage` (free-edit; no
forced convert; no `#owner=` required to edit). Plain persist uses Edge
`plain-upsert`. Legacy ON (owner only) converts the current Y.Doc via
`note-session` `convert-legacy` then soft-replaces to `#owner=` with Pixel
success toast; Encrypt becomes available; `plain-upsert` returns HTTP 409
`capability_managed`. After Legacy ON, bare `/{slug}` is read-only need-owner
/ Legacy-on banner + Home CTA (AC A3; localStorage pin and/or LNO
`managed:true`). Legacy OFF (owner `#owner=` only) calls `disable-secure` and
soft-replaces to bare free-edit; `plain-upsert` returns 200 unmanaged again.
SQL `capability_note_plain_upsert` and `capability_note_disable_secure` are
**applied** live. U1 SQL `capability_note_convert_legacy` remains
**applied** live. Edge `note-session` `plain-upsert`, `disable-secure`, and
`convert-legacy` are **published** (`convert-legacy` Pulse `umsg_01m21zhm…`).
Edge `legacy-note-open` is republished with `managed:true` for managed slugs.
W1 convert-on-write as product default is **superseded**. Encrypt is allowed
on unmanaged free-edit without forcing `#owner=` (#151; persist via
`plain-upsert` enc fields). Legacy↔Encrypt is a hard XOR in the SPA UI.
`#owner=` Encrypt stays active. Pixel Legacy opt-in (#122) and PWA latch (#119) one
hard-reload per Update apply remain. Choice A (#118) editable-plain default
and A′ (#126) RO default are **superseded**. Phase C is
also live: RawView `/:slug.md` loads via LNO `open`, and Home availability uses
LNO `exists` (no `public.notes` SELECT; empty legacy rows are taken). Pixel HIGH UX
H1–H6 is live on this origin. H2 opaque Mode/Export is live. Ko-fi +
New Version FAB is live (#153 equal `bottom-4`/`right-4` inset; update chip
status-only, no MỚI, small heart snooze, larger update heart; #155 idle click
opens `https://ko-fi.com/sovergarden` and writes dedicated localStorage
`kofi-fab-idle-dismiss-until` = now+24h). FAB-primary + Sonner suppress (#113/#116) is live.
Choice A (#118) is superseded. PWA latch (#119) is live. Pixel Legacy opt-in
(#122) is live as `?legacyRo=1` / Legacy Advanced. A′ (#126) RO default is
superseded. Duplicate securely (#128) is enabled on Legacy RO only. Encrypt
#123 `#owner=` Encrypt stays active.

This origin compiles `SlugDispatcher` and SplitView pane embeds to mount
`CutoverNotePage` → editable `NotePage` when that canary is on (lazy;
`SlugDispatcher` keeps the `EditorSkeleton` fallback). A plain `/<slug>` with
no matching `#owner`/`#edit` fragment mounts W2 free-edit `NotePage` unless
the slug is capability-managed (localStorage pin and/or LNO `managed:true` →
AC A3 need-owner / Legacy-on RO banner + Home CTA);
matching owner/edit fragments still render `NotePage`. Optional `?legacyRo=1`
still RO + banner. Duplicate securely is enabled on Legacy RO only (PR #128;
Edge `note-session` `import-legacy`). Flag-off builds keep `NotePage` with
`legacyOnly` and do not import `CutoverNotePage`. Production `legacy-note-open`
is the Phase B read-only exact-match Edge (live; findings §1b), republished
with `managed:true` for managed slugs. This origin
attest does not deploy Edge.

**W2 live (named Pages go of #135/#137/#138/#139):** canary-on
`SlugDispatcher` / SplitView mount `CutoverNotePage` → editable `NotePage`
(free-edit) for unmanaged plain slugs. W1 convert-on-write as product default
is **superseded**. A′ (#126) Cutover/LNO RO default is
**superseded**. `#owner=`/`#edit=` still render `NotePage`. `?legacyRo=1` still
RO. Canary stays on. See [A′ Cutover restore](security/a-prime-cutover-restore.md)
for the remaining Legacy RO path. SQL 240 already applied; W2 SQL
`capability_note_plain_upsert` / `capability_note_disable_secure` applied live;
U1 SQL `capability_note_convert_legacy` applied live; previously published Edge
`plain-upsert` / `disable-secure` / `convert-legacy` remain **published**
(Pulse `umsg_01m21zhm…` for `convert-legacy`). #151 Edge XOR
(`invalid_state` 409) is **in-repo only / not deployed live**. Worker /
`writes_enabled` / Realtime still HOLD.
SQL `capability_note_bulk_disable_secure` is **applied** live (Go A+B Pulse
PASS; git tip `bd11deed` / #142). Live origin is `3b4ea9f9` (#155). Prior origin `1b172544` was the #153 pin. Prior origin `44b02cb3` was the #151 pin. Go C pin
heal **shipped** live (#145 LNO-wins on prior origin `9a80930a`): stale `snote:legacy-secure:*` no longer
latches unmanaged bare RO. Historical bulk OFF `managed_live` 26→0 is not a
claim the fleet stayed 0 (`managed_live=3` at Go C live; later preflight 6).
Re-bulk OFF ALL 6 (2026-09-22) Pulse post-verify `managed_live=0` + Sentinel
spot is **historical**. 3-arg `p_slugs` allowlist is **applied live** (Go SQL
Pulse PASS; git tip `46ddaf01` / #148; 2-arg DROP). Residual
`managed_live=1` (`aggadagdade`) still managed — **no bulk OFF** — is
**historical**. **Go Ops allowlist bulk OFF** 2→0 Pulse PASS (`aggadagdade`,
`pbhcusvb`; converted=2; **not fleet**; residual **cleared**; post
`managed_live=0`). Anon fleet count unavailable (401). This docs attest does
not re-apply SQL, does not re-run bulk convert / fleet NULL, and does not
deploy origin / Pages / Worker / Edge.

When that canary is on, Home create always uses bare `seedAndOpen` /
`/${slug}` (no default mint / no `#owner=`). Availability still uses LNO
`exists` (`available` / `taken`); idle submit re-checks. It does not mint via
`POST note-session` `{action:"create"}` on create or Random. See
[ADR-001](adr/001-home-capability-mint-before-sql-240.md) for the historical
mint-before-240 decision. That Home mint path is **superseded** as default.
This Home create path is live on origin `3b4ea9f9` (canary on; always bare
`seedAndOpen`; findings §3e / §3k / §3l / §3m). Prior Home mint (fail-closed idle;
create → `#owner=`) is **superseded** as default.
It is not SQL 240. Recents and
pins store only the slug, never the owner token. Losing the fragment
without another copy of the owner capability locks the note out. An
LNO `exists: false` miss is only a legacy hint: capability-managed slugs are
invisible to LNO `exists`, and create may still return `slug_unavailable`.
Do not fall back to a legacy upsert from the create button.

An optional encryption secret is a separate `key` fragment field. Capability tokens are exchanged for a short-lived `NoteSession` and are sent to Edge APIs only as an exact `Authorization: Bearer` header. They are never placed in a request path, query, JSON body, recent-note entry, telemetry event, or log.

## Durable update path

Every local Yjs update is encrypted when the note is locked, hashed over the exact transported bytes, and inserted into the IndexedDB outbox before Realtime broadcast or HTTP sync. `note-sync` assigns a sequence and acknowledges the update ID idempotently. The client removes only acknowledged IDs, so navigation, offline use, reopening, duplicated delivery, and reversed delivery cannot discard an edit. An edit-capable peer also persists a validated broadcast under the same hash; a view-only peer applies broadcasts without accumulating an outbox it cannot acknowledge.

After 200 updates beyond the latest checkpoint, an editor encodes the merged Yjs state and submits a checkpoint with `throughSequence`, encryption-version CAS, and checkpoint-version CAS. A concurrent winner causes a session refresh rather than a stale retry loop. Checkpoints do not delete the append-only audit log.

## Local encryption boundary

Locked notes do not mount `y-indexeddb`. Their capability outbox, checkpoints, updates, and disaster snapshots contain ciphertext only. Enabling encryption converts existing recovery snapshots atomically and deletes the old plaintext Yjs database; failure clears recovery history rather than leaving plaintext behind. Explicit unlock converts the recovery history while the key is still available.

The Chrome extension stores only edit capabilities in `chrome.storage.local`. It never accepts or syncs an owner capability. Legacy slug URLs remain available during the dual-mode rollout; capability-managed notes are opened through the session API and never through direct table access.

## Operational constraints

- Keep the capability backend migration and all four Edge APIs deployed before enabling capability note creation.
- Configure private Realtime authorization and the JWT/HMAC secrets described in `docs/capability-backend.md`.
- Run the production aggregate payload audit before deployment. Oversized notes are quarantined read-only rather than truncated.
- A cutover or rollback must preserve the IndexedDB outbox. Rollback defaults to API read-only and must not restore anonymous table writes.
