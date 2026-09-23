# Snote

Offline-first realtime Markdown notes with a separately gated capability model.

Production: [note.syrin.online](https://note.syrin.online/)

**Current status:** Production currently runs W2 free-edit + Legacy opt-in
(#135 W2 + #137 Legacy ON handoff + #138 A3 bare-after-ON RO + #139 lint/types;
#151 create-bare + encrypt≠owner + Legacy/Encrypt mutex UI;
#153 Ko-fi FAB equal `bottom-4`/`right-4` inset + update snooze heart;
#155 idle Ko-fi FAB dismiss 24h (`kofi-fab-idle-dismiss-until`);
#157 polish Copy for AI — no slug header, selection copy, deep clean;
#159 selection-match cap 4000 + nested-overflow scroll feel;
prior #130/#131 W1 convert-on-write as product default is **superseded**)
canary-on `CutoverNotePage` → editable `NotePage` for plain `/<slug>` and
SplitView panes (no forced convert, no `#owner=` required to edit; Phase C
still live; Pixel HIGH UX H1–H6 still on this line; H2 opaque Mode/Export
still on this line; Ko-fi + New Version FAB still on this line (#153 equal
inset + status-only update chip, no MỚI, small heart snooze, larger update
heart; #155 idle click opens `https://ko-fi.com/sovergarden` and writes
localStorage `kofi-fab-idle-dismiss-until` = now+24h; PageIndicator offsets
only while idle or update FAB mounted); Copy cho AI copies cleaned markdown
only (no `# Note:/slug` header; selection-aware from the note editor; deep
clean; Pixel `export.ai` / `export.ai_tooltip`; token soft-warn and locked
disable remain OUT); custom selection-match `maxSelectionLength=4000`
(L>4000 hard off); typewriter-OFF nested-overflow scroll fix (`overflow-hidden`
+ `min-h-0`; ~24px breathing + typewriter 45vh retained; no scroll hijack /
no `transform`+`will-change` on scroller); FAB-primary
+ Sonner suppress (#113/#116) still on this line; Choice A (#118)
editable-plain default remains **superseded** on this line; PWA latch (#119)
one hard-reload per Update apply still on this line; Pixel Legacy opt-in
(#122) still on this line as `?legacyRo=1` / Legacy Advanced; Encrypt is
allowed on unmanaged free-edit without forcing `#owner=` (persist via
`plain-upsert` enc fields); Legacy↔Encrypt is a hard XOR in the SPA UI
(Encrypt ON → Legacy disabled; Legacy ON → Encrypt disabled); `#owner=`
Encrypt stays active on the owner path (#123); A′ (#126) RO default is
**superseded**; Duplicate securely (#128) remains enabled on Legacy RO only
(Edge `note-session` `import-legacy`); W2 + A3 + Go C (#145 LNO-wins) remain
on this line; #151 create-bare remains on this line; #153 FAB UX remains on
this line; #155 remains on this line; #157 remains on this line; #159 live on origin `08c25172`;
Pixel IDLE+UPDATE PASS (no Sonner on home) remains on this line; findings §3e / §3k / §3l / §3m / §3n / §3o): `capabilityRoutesEnabled` true. Plain slug URLs persist via Edge
`plain-upsert` (free-edit for anyone with the link). Home create always uses
bare `seedAndOpen` (no default mint / no `#owner=`). Prior Home mint
(fail-closed on idle; create → `/<slug>#owner=`) is **superseded** as default.
Legacy (Secure) opt-in ON (owner only) converts the current Y.Doc via
`note-session` `convert-legacy`, soft-replaces to `#owner=` with Pixel success
toast «Đã bật Legacy. Giữ link owner để đặt sau.»; server managed so
`plain-upsert` returns HTTP 409 `capability_managed`. After Legacy ON, bare
`/{slug}` (same tab or new tab) is read-only need-owner / Legacy-on banner +
Home CTA (AC A3; localStorage pin and/or LNO `managed:true` so free-edit is
not mounted). Legacy OFF (owner `#owner=` only) calls `disable-secure`,
soft-replaces to bare free-edit with toast «Đã tắt Legacy. Ai có link cũng sửa
được.»; `plain-upsert` returns 200 unmanaged again. SQL
`capability_note_plain_upsert` and `capability_note_disable_secure` are
**applied** live. U1 SQL `capability_note_convert_legacy` remains **applied**
live. Previously published Edge `note-session` `plain-upsert`,
`disable-secure`, and `convert-legacy` remain **published** (`convert-legacy`
Pulse `umsg_01m21zhm…`). Edge XOR (`convert-legacy` / `set-encryption` →
`invalid_state` 409) is **in-repo only / not deployed live**
(`note-session` / `note-manage` **not** redeployed; Sentinel Edge XOR 409
**NOT VERIFIED**). Do **not** claim Edge XOR live PASS. Edge
`legacy-note-open` is republished with `managed:true` for managed slugs.
`#owner`/`#edit` still render `NotePage`. Optional `?legacyRo=1` still RO +
banner (`LegacyNotePage`; Phase B `legacy-note-open` read-only). RawView
`/:slug.md` loads via LNO `open`; Home availability uses LNO `exists`
(empty legacy rows are taken). Duplicate securely is enabled on Legacy RO
only (PR #128; Edge `note-session` `import-legacy`). Pixel toggles are LTR:
OFF thumb left / muted track; ON thumb right / primary (accent) track.
Additive SQL 220 and 270 are
applied on production; `writes_enabled=true` and
`private_realtime_enabled=false` (findings §3d). SQL 240 is already applied;
soak ≥48h started from the first canary (not soak-complete) — see
[security findings](docs/security-findings.md). Historical Pixel PASS live A3 @ origin
`0cdcdc0f` / Pages `1b9ed3d1` (panel, free-edit, legacy-on, bare-after-on,
bare-tab2, legacy-off; evidence `pixel-qa/a3-0cdcdc0f/`). Historical Sentinel:
READY WITH KNOWN RISKS live A3 @ `0cdcdc0f` / Pages `1b9ed3d1`
(BLOCKER/HIGH/MEDIUM none; evidence `sentinel-qa-a3-0cdcdc0f/`). LOW: normal
new-version reminder; one owner-link load needing hard reload; optional cold
localStorage-clear not run. Historical live origin `9a80930a` / Pages `8e64829c`
(`8e64829c-c182-45d1-ba27-5f43af7d20fd`): Go C LNO-wins pin heal (#145)
shipped. Stale pin (`snote:legacy-secure:*`) + unmanaged LNO → silent free-edit; still-managed → A3 RO;
LNO error fail-closed; no auto-ON. Historical Pixel READY WITH KNOWN RISKS at Go C
(heal `/design` PASS; `/hage` A3 = still-managed after Secure ON probe, not
heal FAIL; evidence `pixel-qa/go-c-live-9a80930a/`). Historical Sentinel READY
WITH KNOWN RISKS at Go C (BLOCKER/HIGH none; evidence
`/workspace/sentinel-qa-go-c-live/`). Re-bulk OFF ALL 6 (2026-09-22) Sentinel
READY WITH KNOWN RISKS: LNO unmanaged for `hage`/`xqmqh53z`/`gr3l8g5e`;
plain-upsert 200 (not 409); vacant create unmanaged (no auto-ON); bare SPA
`/hage` + `/xqmqh53z` editable+synced, no A3/need-owner (evidence
`/workspace/sentinel-qa-rebulk-all6-live/`). Go SQL allowlist `p_slugs`
**applied** live (2026-09-22; Pulse **PASS**; git tip `46ddaf01` / #148);
live RPC is 3-arg (2-arg DROP). Go SQL residual `managed_live=1`
(`aggadagdade`) still managed — **no bulk OFF**. Later **Go Ops allowlist
bulk OFF** 2→0 **PASS** (`aggadagdade`, `pbhcusvb`; converted=2; not fleet;
residual **cleared**; post `managed_live=0`; LNO unmanaged; plain-upsert
200). SQL/ops apply did not move Pages (then still `9a80930a`). Git docs tip
after #149 is `836753fe`. Sentinel **READY** (SQL contract; evidence
`/workspace/sentinel-qa-allowlist-sql-46ddaf01/`) then **READY** (bulk OFF
live gate; evidence `/workspace/sentinel-qa-bulk-off-allowlist-20260922/`).
Prior live origin `44b02cb3` / Pages `b44849c4` (#152 attest): Syringa named
#151 Origin SPA ship to Cloudflare Pages `snote-g4-origin` /
note.syrin.online (canary ON). Independent Sentinel `version.json` at that
attest: `deployedSha` `44b02cb3429999050aa850489b18b98a58ef2499`,
`capabilityRoutesEnabled` true, `buildId` `1790066192935-qg7oaft7`,
`builtAt` `2026-09-22T08:36:49.543Z`. Sentinel **READY WITH KNOWN RISKS** at
that attest (tip latch PASS; D1 create bare PASS; D2 encrypt unmanaged PASS;
D3 mutex UI PASS; Pixel LTR toggles PASS; Edge XOR 409 **NOT VERIFIED**).
Pixel READY WITH KNOWN RISKS khớp. Prior live origin `1b172544` / Pages
`5527f154` (#154 attest): Syringa named #153 Origin SPA ship to Cloudflare Pages
`snote-g4-origin` / note.syrin.online (canary ON). Independent Sentinel
`version.json` at that attest: `deployedSha` `1b1725446120ce9dd28bc7fe884c3768e37e435d`,
`capabilityRoutesEnabled` true, `buildId` `1790083696998-uk4r5sxu`,
`builtAt` `2026-09-22T13:28:32.689Z` (Pulse clean-rebuild redeploy; Pages
preview `5527f154`). Earlier same-SHA first deploy was Pages `66a0df1a` /
buildId `1790082984868-xjuz78gh` — that attest pinned the then-current live
buildId. Sentinel + Pixel **READY WITH KNOWN RISKS** at that attest (idle FAB
equal `bottom-4`/`right-4` inset PASS; update cluster PASS: status-only
«Có update mới», no MỚI badge, small heart snooze + strike, larger update
heart; after hard-activate tip). Known risk then: SW waiting can still serve
pre-#153 update cluster UI until tip activates (Pulse digests matched tip;
not a miss-ship). Prior live origin `3b4ea9f9` / Pages `62f641c7` (#156 attest):
Syringa named #155 Origin SPA ship to Cloudflare Pages `snote-g4-origin` /
note.syrin.online (canary ON). Independent Sentinel `version.json` at that
attest: `deployedSha` `3b4ea9f9c1decc39bc5dadf7923e45421b81823d`,
`capabilityRoutesEnabled` true, `buildId` `1790100180966-ukuhpb1q`,
`builtAt` `2026-09-22T18:03:22.407Z` (Pages preview `62f641c7`; full UUID not
supplied — not invented). Git tip of the shipped SPA was #155 `3b4ea9f9`.
Sentinel + Pixel **READY WITH KNOWN RISKS** at that attest (idle click opens
`https://ko-fi.com/sovergarden` + writes dedicated localStorage
`kofi-fab-idle-dismiss-until` = now+24h PASS; reload persistence PASS;
corrupt/missing key shows idle PASS; #153 update cluster still wins dismiss
PASS: «Có update mới» / «Update available», no MỚI, snooze heart + strike,
larger apply heart; after update snooze idle stays hidden while dismiss
window active PASS; PageIndicator offsets only while idle or update FAB
mounted). #153 FAB UX remains on this line. LOW then: live update-detector
sometimes shows the update cluster when tip already matches (does not block
dismiss; do not claim a perfect idle baseline without hard-activate / mock
clear). Known risk then: SW waiting can still serve stale UI until tip activates
(same class as #153; hard-activate unregister SW + clear caches was used in
smoke). Prior live origin `610662a9` / Pages `33667a6a` (#158 attest): Atlas named
#157 Origin SPA ship to Cloudflare Pages `snote-g4-origin` /
note.syrin.online (canary ON). Independent Sentinel `version.json` at that
attest: `deployedSha` `610662a998541c06ee99288b666af52dcee05ad8`,
`capabilityRoutesEnabled` true, `buildId` `1790148079761-vf6vjb0l`,
`builtAt` `2026-09-23T07:21:42.226Z` (Pages preview `33667a6a`; full UUID not
supplied — not invented). Git tip of the shipped SPA was #157 `610662a9`.
Sentinel **READY WITH KNOWN RISKS** at that attest; Pixel **READY** at that
attest. Pulse ship PASS (Pages `snote-g4-origin`; PWA update smoke PASS run
35831181399). PASSED then: tip latch `610662a9`; full Copy cho AI — no
`# Note:/slug`; deep clean (ZW strip, fence auto-close, HTML comment strip);
selection path + selection toast; cleared/whitespace selection → full path;
empty note toast EN+VI; no junk clipboard overwrite; label + tooltip VI+EN.
Token soft-warn and locked disable remain OUT. LOW then: stale client tab
needs «Reload to update» until in-app reload (ops; Pulse PWA smoke already
PASS; not a product AC miss). #155 idle dismiss and #153 FAB UX remain on
this line. Current live origin `08c25172` / Pages `1db84523`: Atlas named
#159 Origin SPA ship to Cloudflare Pages `snote-g4-origin` /
note.syrin.online (canary ON). Independent Sentinel `version.json`:
`deployedSha` `08c25172036610a2cdca3cd6af0cbefefc654d16`,
`capabilityRoutesEnabled` true, `buildId` `1790170318028-nxe1ecb2`,
`builtAt` `2026-09-23T13:32:22.922Z` (Pages preview `1db84523`; full UUID not
supplied — not invented). Git tip of the shipped SPA is #159 `08c25172`.
Pixel **READY** live; Sentinel **READY WITH KNOWN RISKS** live. Pulse ship
PASS (Pages `snote-g4-origin`; PWA update smoke PASS run 35867325334).
PASSED: tip latch `08c25172`; custom selection-match `maxSelectionLength=4000`
(L>4000 hard off); nested-overflow scroll fix for typewriter OFF (Editor
`overflow-hidden` + `min-h-0`; `.cm-scroller` is the only scroller); ~24px
breathing + typewriter 45vh retained; no scroll hijack / no
`transform`+`will-change` on scroller. A1 first-pass flake withdrawn after
SW hard reset (stale-client / async-settle, not a tip defect). LOW: B4
typewriter-ON soft ends unrun; B2 physical feel partially covered by Sentinel
(Pixel closed B2). #157 Copy for AI remains on this line. Edge XOR 409
**NOT VERIFIED** (still PARKED / not deployed). Walls HOLD:
Worker / Realtime / SQL / `writes_enabled`. This docs attest does not deploy
origin / Pages / Worker / Edge and does not apply SQL. Not soak-complete.

**Bulk Legacy/Secure OFF (historical docs attest — not a SPA ship):** Syringa named
Go A then B, executed by Pulse, **PASS**. Git tip when applied: `bd11deed`
(migration `20260916000000_capability_note_bulk_disable_secure.sql` from #142;
tip also includes #143 `pwa-update-smoke` harden). At that attest, live SPA
origin was still `0cdcdc0f` / Pages `1b9ed3d1` (bulk OFF is SQL/ops).
Go A: RPC `capability_note_bulk_disable_secure` **applied**; `service_role`
EXECUTE only; anon/authenticated EXECUTE false. Go B: `managed_live` 26→0
(2026-09-16); skipped_encrypted=0; errors=[]; plaintext converted; `note_id`
rotated. That post-count is **historical**; the fleet was **not** still 0
managed after #144. Pulse RO inventory at Go C live: `managed_live=3` (`hage`,
`xqmqh53z`, `svgoccbe2542573b`); `unmanaged_live=106`; `design` unmanaged.
That inventory is **historical** (leftovers; later preflight 6). Go C pin heal
subsequently **shipped** live (#145 LNO-wins) on origin `9a80930a`.
Pulse evidence `/workspace/pulse-bulk-off-ab2c4de9/`. Historical Sentinel:
READY WITH KNOWN RISKS (API+cold SPA free-edit PASS; evidence
`/workspace/sentinel-qa-bulk-off-live/`). Historical Pixel cold-browser:
PASS WITH KNOWN RISKS (`hage`, `design` bare editable + Synced; evidence
`/workspace/pixel-qa/bulk-off-verify/`). Aegis: khớp design.

**Re-bulk OFF ALL 6 (2026-09-22 docs attest — not a SPA ship):** Syringa named
go; Pulse ran existing live RPC `capability_note_bulk_disable_secure(500,false)`
— **no re-migrate**. Preflight: 6 managed plaintext, encrypted=0 (not the
earlier scope-3). Slugs: `hage`, `xqmqh53z`, `svgoccbe2542573b`, `gr3l8g5e`,
`svgocc0360f59afa`, `x915930e`. Pulse `converted=6`, drain=0, `errors=[]`;
post-verify `managed_live=0`, encrypted=0. `note_id` rotation accepted (same
as Go B). Claim `managed_live=0` only as Pulse post-verify + Sentinel spot;
anon fleet RO count skipped (401). At that attest, live origin remained
`9a80930a` / Pages `8e64829c` / buildId `1789612258815-8yx2tdut` /
`capabilityRoutesEnabled` true. Pulse `/workspace/pulse-rebulk-all6-20260922/`. Sentinel READY WITH
KNOWN RISKS (BLOCKER/HIGH/MEDIUM none; LOWs: anon count 401, `hage`
content_len drift still unmanaged, 1 CSP console error no edit/sync impact;
evidence `/workspace/sentinel-qa-rebulk-all6-live/`). This docs attest
does not deploy origin / Pages / Worker / Edge, does not re-apply SQL, and
does not re-run bulk RPC. Worker / Realtime / `writes_enabled` still HOLD.
That post-verify `managed_live=0` is **historical**. Later Go SQL preflight
found residual `managed_live=1` (`aggadagdade`); Go Ops allowlist then
converted that residual plus `pbhcusvb` (see Go Ops paragraph).

**Go SQL allowlist `p_slugs` (2026-09-22 docs attest — not a SPA ship):**
Syringa named Go SQL; Pulse **PASS** at tip `46ddaf01` (#148). Applied
`20260922000000_capability_note_bulk_disable_secure_p_slugs.sql` sha256
`f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132`. DROP
2-arg → CREATE 3-arg live; `service_role` EXECUTE; anon/authenticated
revoked. Smoke `ARRAY[]` → `converted=0` `scope=allowlist`; miss →
`skipped_allowlist_miss=1`. NULL fleet **not** executed (`managed_live=1`
residual `aggadagdade`; body RO confirms NULL→fleet). Residual unchanged.
**No bulk OFF.** At that attest, live origin remained `9a80930a` / Pages
`8e64829c` / buildId `1789612258815-8yx2tdut` / `capabilityRoutesEnabled`
true (SQL apply does not move Pages). Pulse `/workspace/pulse-allowlist-sql-46ddaf01/`. Sentinel
**READY** (SQL contract; BLOCKER/HIGH/MEDIUM none; LOWs: `schema_migrations`
missing named-go body apply, SPA tip still `9a80930a` expected; evidence
`/workspace/sentinel-qa-allowlist-sql-46ddaf01/`). This docs attest does not
deploy origin / Pages / Worker / Edge, does not re-apply SQL, and does not
run bulk convert. Worker / Realtime / `writes_enabled` still HOLD.
Go SQL residual is **historical**; later Go Ops allowlist bulk OFF is the
next paragraph.

**Go Ops allowlist bulk OFF 2→0 (2026-09-22 docs attest — not a SPA ship):**
Syringa named Go Ops; Pulse **PASS** on existing live 3-arg RPC
`capability_note_bulk_disable_secure(500,false,ARRAY[aggadagdade,pbhcusvb])`
— **no re-migrate**, **not fleet**. Pre: `managed_live=2` plaintext
(`aggadagdade`, `pbhcusvb`); encrypted=0 (count > Go SQL known residual 1;
allowlist both). Pulse `converted=2`, `scope=allowlist`,
`allowlist_requested=2`, `allowlist_matched_managed=2`, `skipped_encrypted=0`,
`errors=[]`; post-verify `managed_live=0`, encrypted=0. LNO both unmanaged;
plain-upsert 200 (not 409). Residual **cleared**. Claim `managed_live=0` only
as Pulse post-verify + Sentinel spot; anon fleet RO count skipped (401).
At that attest, live origin remained `9a80930a` / Pages `8e64829c` / buildId
`1789612258815-8yx2tdut` / `capabilityRoutesEnabled` true (ops apply does
not move Pages). Git docs tip after #149 is `836753fe`. Pulse
`/workspace/pulse-bulk-off-allowlist-20260922/`. Sentinel **READY** (bulk OFF
live gate; BLOCKER/HIGH/MEDIUM none; LOWs: SPA bare free-edit deferred,
first upsert 400 missing `charCount` then 200; evidence
`/workspace/sentinel-qa-bulk-off-allowlist-20260922/`). This docs attest
does not deploy origin / Pages / Worker / Edge, does not re-apply SQL, and
does not re-run bulk RPC / fleet NULL. Worker / Realtime / `writes_enabled`
still HOLD.

**W2 live (named Pages go of #135/#137/#138/#139 + Go C #145 + #151 + #153 + #155 + #157 + #159):** canary-on
plain `/<slug>` is free-edit (no convert-on-write default). Go C LNO-wins pin
heal remains on this line (shipped on prior origin `9a80930a`). #151 create-bare
+ encrypt≠owner + Legacy/Encrypt mutex UI remains on this line (prior origin
`44b02cb3` / Pages `b44849c4`). #153 Ko-fi FAB equal inset + update snooze
remains on this line (prior origin `1b172544` / Pages `5527f154`). #155 idle
Ko-fi FAB dismiss 24h remains on this line (prior origin `3b4ea9f9` / Pages
`62f641c7`). #157 polish Copy for AI remains on this line (prior origin
`610662a9` / Pages `33667a6a`). #159 selection-match cap 4000 + nested-overflow
scroll feel is live on origin `08c25172` / Pages `1db84523`. W1 convert-on-write as product
default is **superseded**. A′ (#126) Cutover/LNO RO default is
**superseded**. `#owner=`/`#edit=` still render `NotePage`. `?legacyRo=1`
still RO + banner. Canary stays on. SQL 240 already applied; W2 SQL
`capability_note_plain_upsert` / `capability_note_disable_secure` applied
live; U1 SQL `capability_note_convert_legacy` applied live; bulk RPC
`capability_note_bulk_disable_secure` 3-arg `p_slugs` allowlist **applied**
live (Go SQL Pulse PASS; git tip `46ddaf01` / #148; Go Ops allowlist
bulk OFF 2→0 Pulse PASS, residual **cleared**; SQL/ops apply did not move
Pages). Previously published Edge `plain-upsert` / `disable-secure` /
`convert-legacy` remain **published** (Pulse `umsg_01m21zhm…` for
`convert-legacy`).
#151 Edge XOR (`invalid_state` 409) is **in-repo only / not deployed live**.
Worker / `writes_enabled` / Realtime still HOLD. See
[A′ Cutover restore](docs/security/a-prime-cutover-restore.md)
for the remaining Legacy RO path.

## Product

- CodeMirror 6 editing with Markdown, Vim and typewriter modes.
- Sanitized preview with KaTeX, Mermaid and code highlighting.
- Responsive editor, preview and split layouts.
- Yjs CRDT updates with an acknowledged IndexedDB outbox.
- Optional client-side encryption with an unlock-before-mount boundary.
- Dormant support for revocable owner, edit and view capabilities.
- PWA offline support and safe service-worker updates.
- Chrome side-panel extension.
- Nine lazy-loaded locales: English, Vietnamese, Chinese, Japanese, Korean,
  French, Spanish, German and Portuguese.

## Security model

SQL 240 is already applied: browser roles no longer have direct `notes` table
access. Dual-mode canary, W2 free-edit for plain `/slug`, Home create always
bare `seedAndOpen` (#151), and Duplicate securely (Legacy RO) are live. Soak
is not complete;
`private_realtime_enabled` remains false. The capability model below is the live table-access architecture.

After cutover, a slug locates a note but never grants access. New notes use
32-byte random capabilities:

- Owner: `/<slug>#owner=<token>`
- Editor: `/<slug>#edit=<token>`
- Viewer: `/s#view=<token>`

The SPA then exchanges a fragment capability for a short-lived `NoteSession`.
Backend clients send capabilities in `Authorization`, never in a query or path.
The database stores keyed hashes, not raw capabilities. The atomic cutover
revokes direct anonymous table access; SQL 240 is already applied.

After cutover, free-edit notes persist through Edge `plain-upsert` (not
direct table writes). They stay unmanaged until Legacy ON converts them in
place (same slug via `convert-legacy`) or Duplicate securely copies them onto
a new slug from Legacy RO. They never acquire an owner implicitly. The
planned rollback keeps APIs read-only; it never restores public table
policies.

Do not log note content, slugs, capabilities, share tokens or raw IP addresses.
See [security findings](docs/security-findings.md), the
[capability API](docs/capability-backend.md), and the
[atomic cutover runbook](docs/security/atomic-capability-cutover.md).
Home mint before SQL 240 is [ADR-001](docs/adr/001-home-capability-mint-before-sql-240.md).
Release evidence is collected in the
[stacked rollout tracker](docs/security/stacked-rollout-tracker.md).

## Stack

- React 19, React Router 8, TypeScript, Vite and Tailwind CSS
- CodeMirror 6 and Yjs
- Supabase Postgres, Realtime and Edge Functions
- Cloudflare Worker for generic crawler-safe responses
- Vitest and Playwright

## Local development

Requirements: Bun `1.3.14` with Node-compat `22.22.0` or later and, for Edge
typechecking, Deno `2.9.3`.

```sh
git clone https://github.com/sovergarden-dev/snote.git
cd snote
bun install --frozen-lockfile
bun run dev
```

The development server is available at `http://localhost:8080`.
`.env.example` documents the publishable Supabase configuration.

## Verification

```sh
bun run lint
bunx tsc --noEmit -p tsconfig.app.json
bunx tsc --noEmit -p tsconfig.node.json
bunx tsc --noEmit -p tsconfig.tools.json
bun run typecheck:edge
bun run test:coverage
bun run build:check
bun run i18n:check
bun run i18n:audit
bun run i18n:allowlist
bun run cutover:verify
```

Run Playwright locally with:

```sh
bun run test:e2e
```

Global retries are zero. PR CI runs the critical Chromium smoke. Pushes to
`main`, nightly runs and manual runs execute the full Chromium, Firefox and
WebKit matrix. Each failing E2E job uploads one evidence bundle containing the
HTML report and test results.

The repository intentionally keeps only three workflows:

- `ci.yml`: quality, PR smoke and full browser matrix
- `extension-e2e.yml`: extension package audit and unpacked-extension E2E
- `pwa-update-smoke-post-deploy.yml`: production update smoke

## Extension

```sh
bun run scripts/build-extension-zip.ts
bun run scripts/verify-extension-zip.ts
bash scripts/audit-extension.sh
bunx playwright test --config=e2e-extension/playwright.config.ts --retries=0
```

`public/syrin-note-sidepanel.zip` is deterministic. Its manifest records the
source file set, hashes and package version so CI rejects stale store bundles.

## Project layout

```text
src/                 React application, CRDT client and tests
supabase/            migrations and Edge Functions
cloudflare-worker/   crawler-safe response worker
chrome-extension/    Chrome side-panel package
e2e/                 app Playwright suite
e2e-extension/       extension Playwright suite
scripts/             small build, audit and contract utilities
lovable-skills/      import-ready Lovable workspace skills
docs/                security, API and rollout runbooks
```

Generated `reports/`, `artifacts/`, Playwright outputs and Python bytecode are
ignored and must not be committed.

## Lovable workspace skill

Import `lovable-skills/snote-release/SKILL.md` from GitHub in
**Workspace Settings → Skills → Add → Import from GitHub**. It provides a
Snote-specific release go/no-go checklist without vendoring generic agent
skills into this repository.

## License

No decision has been made yet: this repository currently contains no
LICENSE file and no third-party NOTICES file, and choosing a license is an
owner decision. Until one is recorded, do not redistribute the application
or its bundled dependencies.
