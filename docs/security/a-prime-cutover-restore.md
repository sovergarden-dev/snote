# A′ Cutover restore — SPA routing (superseded as live default by W2)

- Status: **Superseded as live default** by W2 free-edit + Legacy opt-in on origin `3b4ea9f9` / Pages `62f641c7` (named Pages go of #135/#137/#138/#139 + Go C #145 + #151 + #153 + #155). Remaining live path: `?legacyRo=1` / Legacy Advanced → Cutover/LNO RO, plus AC A3 bare-after-Legacy-ON RO. Prior #153 pin was `1b172544` / Pages `5527f154`. Prior #151 pin was `44b02cb3` / Pages `b44849c4`. Prior Go C pin was `9a80930a` / Pages `8e64829c`. Prior W2 A3 pin was `0cdcdc0f` / Pages `1b9ed3d1`. Prior W1 pin was `2ae9a230` / Pages `fb35474a` (#130/#131). Prior A′+Duplicate pin was `f84183ba` / Pages `74637d87` (#128 on #126).
- Date: 2026-09-08 (A′ ship); superseded 2026-09-09 (W1); superseded 2026-09-15 (W2 A3); Go C live 2026-09-17; #151 live 2026-09-22; #153 live 2026-09-22; #155 live 2026-09-22
- Owners: Aegis (contract) · Pixel (UX) · Atlas (coord) · Syringa (named go)
- Canary: keep `VITE_CAPABILITY_ROUTES_ENABLED` / `capabilityRoutesEnabled` **on**

Choice A (#118) made canary-on plain `/<slug>` mount editable `NotePage`
(`notes` table path). That dispatcher default was **superseded by A′**, then
**A′ was superseded by W1** (#130), then **W1 convert-on-write as product
default was superseded by W2** (#135): plain `/slug` is free-edit, without
forced convert-on-write and without the Choice A table path.

Live origin `3b4ea9f9` is W2 free-edit + Legacy opt-in + Go C LNO-wins + #151 create-bare + #153 Ko-fi FAB + #155 idle dismiss 24h: plain `/slug` =
editable `NotePage` (anyone with the link; no `#owner=` required to edit).
Home create always uses bare `seedAndOpen` (no default mint / no `#owner=`).
Encrypt is allowed on unmanaged without forcing `#owner=`. Legacy↔Encrypt is
a hard XOR in the SPA UI. Legacy ON (owner only) converts via `convert-legacy` then soft-replaces to
`#owner=`. After Legacy ON, bare `/{slug}` is AC A3 need-owner / Legacy-on RO
banner + Home CTA (localStorage pin and/or LNO `managed:true`). A′
Cutover/LNO RO remains for `?legacyRo=1` / Legacy Advanced. Duplicate
securely stays on that Legacy RO path.
SQL `capability_note_plain_upsert` / `capability_note_disable_secure` are
**applied** live. U1 SQL `capability_note_convert_legacy` is **applied** live.
Edge `plain-upsert` / `disable-secure` / `convert-legacy` remain **published**
(Pulse `umsg_01m21zhm…` for `convert-legacy`). #151 Edge XOR (`invalid_state`
409) is **in-repo only / not deployed live**.
This document does not re-apply SQL 240 and does not flip `writes_enabled` /
`private_realtime_enabled`. SQL 240 already applied; Worker / writes_enabled /
Realtime still HOLD.

## Mount table (canary on) — A′ design; live default is W2

W2 live default (origin `3b4ea9f9`):

| URL | Mount |
|---|---|
| `/<slug>` no fragment (unmanaged) | `CutoverNotePage` → editable `NotePage` (free-edit; no forced convert) |
| `/<slug>` no fragment (after Legacy ON) | AC A3 RO: need-owner / Legacy-on banner + Home CTA (localStorage pin and/or LNO `managed:true`; free-edit not mounted) |
| `/<slug>?legacyRo=1` | `LegacyNotePage` RO (same chrome + banner) — A′ path still used |
| `/<slug>#owner=` / `#edit=` | Capability `NotePage` (unchanged editable) |
| `/<slug>?legacyRo=1#owner=` | Legacy RO (Advanced Legacy ON from `#owner=`) |
| SplitView `/a+b` panes | W2 free-edit via Cutover unless the pane slug is managed (`+` pathnames cannot carry a matching `#owner=`/`#edit=` fragment) |
| `/:slug.md` | RawView unchanged (Phase C LNO `open`) |

Historical W1 default (live on `2ae9a230` / Pages `fb35474a`, not current):

| URL | Mount |
|---|---|
| `/<slug>` no fragment | `CutoverNotePage` → editable `NotePage` (convert-on-write; no A′ RO banner) |
| SplitView `/a+b` panes | W1 editable via Cutover |

Historical A′ default (live on `f84183ba` / `b4eba5d2`, not current):

| URL | Mount |
|---|---|
| `/<slug>` no fragment | `CutoverNotePage` → `LegacyNotePage` (LNO RO) |
| SplitView `/a+b` panes | Legacy RO via Cutover |

Flag-off builds keep `NotePage` `legacyOnly` and do not import `CutoverNotePage`.

## Pixel UX

- W2 unmanaged default has **no** A′ RO banner. After Legacy ON, bare `/slug`
  shows the AC A3 need-owner / Legacy-on banner + Home CTA. Persistent
  `role="status"` banner **below** the topbar remains on Legacy RO chrome
  (`?legacyRo=1`).
- CTA on Legacy RO / AC A3 bare-after-ON goes to **Home mint**, not Duplicate
  securely, not a fake Enable Edit.
- Encrypt is **allowed** on unmanaged free-edit without forcing `#owner=`
  (#151; persist via `plain-upsert` enc fields). Legacy↔Encrypt is a hard XOR
  in the SPA UI (Encrypt ON → Legacy disabled; Legacy ON → Encrypt disabled).
  `#owner=` Encrypt stays **active**. Legacy Advanced remains
  opt-in.
- Unmanaged encryption transitions use `allowEncryptionTransitions` on free-edit;
  managed notes still forbid encryption transitions.
- Duplicate securely is enabled on Legacy RO only
  (`DUPLICATE_SECURELY_AVAILABLE = true`; Edge `note-session` `import-legacy`).
  Hidden on default W2 free-edit and pure `#owner=` editable `NotePage`.

Pixel visual A′ PASS remains historical evidence on prior live `b4eba5d2`
(plain `/hage` Legacy RO + banner + CTA Home; Encrypt omit; mint `#owner=`
editable; evidence `pixel-qa/a-prime-b4eba5d2/`). Pixel Live UX W1 PASS on
origin `2ae9a230` / Pages `fb35474a` remains historical (hard-reload after A′
SW/cache false RO; plain `/hage` editable modern no RO banner; panel Legacy
OFF + Encrypt disabled+honest + Duplicate hidden; convert busy «Saving
securely…» → soft-replace `#owner=` + Synced; evidence
`pixel-qa/w1-2ae9a230/`). Pixel MEDIUM residual on that W1 pin (not BLOCKER):
`?legacyRo=1` on `/hage` after convert → «This legacy note does not exist» +
Duplicate absent (expected U1 after row flip); leftover unconverted smoke
still needed; empty legacyRo helper still A′ «table note» copy
(POLISH/MEDIUM). Historical Sentinel pin: READY WITH KNOWN RISKS on live
`2ae9a230` / Pages `fb35474a` (BLOCKER none; first-persist OK; evidence
`sentinel-qa-w1-live/`). HIGH residual on that W1 pin: plain reopen of a
converted slug does NOT go `#owner=` → note-session `create` → 409
`slug_unavailable` (does not call convert-legacy) → Sync error (bookmark
residual; needs follow-up recovery / «open secure link»). MEDIUM: SW A′
false RO until hard-reload.
Historical Pixel PASS live A3 @ `0cdcdc0f` / Pages `1b9ed3d1` (panel, free-edit,
legacy-on, bare-after-on, bare-tab2, legacy-off; evidence
`pixel-qa/a3-0cdcdc0f/`). Historical Sentinel pin: READY WITH KNOWN RISKS live A3 @
`0cdcdc0f` / Pages `1b9ed3d1` (BLOCKER/HIGH/MEDIUM none; evidence
`sentinel-qa-a3-0cdcdc0f/`). LOW: normal new-version reminder; one owner-link
load needing hard reload; optional cold localStorage-clear not run.
Current live origin `3b4ea9f9` / Pages `62f641c7`: #155 **shipped**.
Prior #153 pin `1b172544` / Pages `5527f154` remains on this line.
Prior #151 pin `44b02cb3` / Pages `b44849c4` remains on this line.
Go C (#145) remains on this line (historical pin `9a80930a` / Pages `8e64829c`).
Historical Pixel READY WITH KNOWN RISKS at Go C (heal `/design` PASS; `/hage`
A3 = still-managed after Secure ON probe, not heal FAIL; evidence
`pixel-qa/go-c-live-9a80930a/`). Historical Sentinel READY WITH KNOWN RISKS
at Go C (evidence `sentinel-qa-go-c-live/`).
Bulk Legacy/Secure OFF (docs attest): RPC `capability_note_bulk_disable_secure`
**applied** live (Go A+B Pulse PASS; git tip `bd11deed` / #142). Historical
origin at that attest was still `0cdcdc0f`. Go C pin heal subsequently
**shipped**. Re-bulk OFF ALL 6 (2026-09-22) Pulse PASS (`converted=6`;
post-verify `managed_live=0` + Sentinel spot) is **historical**. 3-arg
`p_slugs` allowlist **applied live** (Go SQL Pulse PASS; git tip `46ddaf01`
/ #148). Residual `managed_live=1` (`aggadagdade`) still managed — **no bulk
OFF** — is **historical**. **Go Ops allowlist bulk OFF** 2→0 Pulse PASS
(residual **cleared**; origin still `9a80930a` at that attest; **not fleet**). Live origin
is `3b4ea9f9`. Historical Pixel cold-browser PASS WITH KNOWN
RISKS at first bulk OFF (`hage`, `design` bare editable + Synced; evidence
`pixel-qa/bulk-off-verify/` / `/workspace/pixel-qa/bulk-off-verify/`).

## Walls

- This attest does not deploy origin / Pages / Worker
- SQL 240 already applied; this attest does not re-apply
- W2 SQL `capability_note_plain_upsert` / `capability_note_disable_secure`
  applied live; U1 SQL `capability_note_convert_legacy` applied live; Edge
  `plain-upsert` / `disable-secure` / `convert-legacy` published (Pulse
  `umsg_01m21zhm…` for `convert-legacy`); #151 Edge XOR is **in-repo only /
  not deployed live**; this attest does not re-apply/republish
- No `writes_enabled` / `private_realtime_enabled` flip
- Worker / Realtime / `writes_enabled` still HOLD
- Do not merge the attest PR from the implementing agent
