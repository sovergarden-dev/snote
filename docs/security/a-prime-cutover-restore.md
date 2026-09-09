# A′ Cutover restore — SPA routing (superseded as live default by W1)

- Status: **Superseded as live default** by W1 convert-on-write on origin `2ae9a230` / Pages `fb35474a` (named Pages go of #130/#131). Remaining live path: `?legacyRo=1` / Legacy Advanced → Cutover/LNO RO. Prior A′+Duplicate pin was `f84183ba` / Pages `74637d87` (#128 on #126).
- Date: 2026-09-08 (A′ ship); superseded 2026-09-09
- Owners: Aegis (contract) · Pixel (UX) · Atlas (coord) · Syringa (named go)
- Canary: keep `VITE_CAPABILITY_ROUTES_ENABLED` / `capabilityRoutesEnabled` **on**

Choice A (#118) made canary-on plain `/<slug>` mount editable `NotePage`
(`notes` table path). That dispatcher default was **superseded by A′**, then
**A′ was superseded by W1** (#130): plain `/slug` is editable convert-on-write
again, without the Choice A table path.

Live origin `2ae9a230` is W1 convert-on-write: plain `/slug` = editable
`NotePage`; first persist converts legacy via `convert-legacy` then
soft-replaces to `#owner=`. A′ Cutover/LNO RO remains only for `?legacyRo=1`
/ Legacy Advanced. Duplicate securely stays on that Legacy RO path.
U1 SQL `capability_note_convert_legacy` and Edge `convert-legacy` are in
GitHub (#130) but **not applied/published**.
This document does not re-apply SQL 240 and does not flip `writes_enabled` /
`private_realtime_enabled`. SQL 240 already applied; Worker / writes_enabled /
Realtime still HOLD. U1 SQL+Edge walls HOLD.

## Mount table (canary on) — A′ design; live default is W1

W1 live default (origin `2ae9a230`):

| URL | Mount |
|---|---|
| `/<slug>` no fragment | `CutoverNotePage` → editable `NotePage` (convert-on-write; no A′ RO banner) |
| `/<slug>?legacyRo=1` | `LegacyNotePage` RO (same chrome + banner) — A′ path still used |
| `/<slug>#owner=` / `#edit=` | Capability `NotePage` (unchanged editable) |
| `/<slug>?legacyRo=1#owner=` | Legacy RO (Advanced Legacy ON from `#owner=`) |
| SplitView `/a+b` panes | W1 editable via Cutover (`+` pathnames cannot carry a matching `#owner=`/`#edit=` fragment) |
| `/:slug.md` | RawView unchanged (Phase C LNO `open`) |

Historical A′ default (live on `f84183ba` / `b4eba5d2`, not current):

| URL | Mount |
|---|---|
| `/<slug>` no fragment | `CutoverNotePage` → `LegacyNotePage` (LNO RO) |
| SplitView `/a+b` panes | Legacy RO via Cutover |

Flag-off builds keep `NotePage` `legacyOnly` and do not import `CutoverNotePage`.

## Pixel UX

- W1 default has **no** A′ RO banner. Persistent `role="status"` banner
  **below** the topbar remains on Legacy RO chrome (`?legacyRo=1`).
- CTA on Legacy RO goes to **Home mint**, not Duplicate securely, not a fake
  Enable Edit.
- Plain pre-convert Encrypt is **disabled+honest**. `#owner=` Encrypt stays
  **active**. Legacy Advanced remains opt-in.
- Do **not** reopen `allowEncryptionTransitions` on the plain table path.
- Duplicate securely is enabled on Legacy RO only
  (`DUPLICATE_SECURELY_AVAILABLE = true`; Edge `note-session` `import-legacy`).
  Hidden on default W1 plain editable and pure `#owner=` editable `NotePage`.

Pixel visual A′ PASS remains historical evidence on prior live `b4eba5d2`
(plain `/hage` Legacy RO + banner + CTA Home; Encrypt omit; mint `#owner=`
editable; evidence `pixel-qa/a-prime-b4eba5d2/`). Pixel Live UX W1 PASS on
origin `2ae9a230` / Pages `fb35474a` (hard-reload after A′ SW/cache false RO;
plain `/hage` editable modern no RO banner; panel Legacy OFF + Encrypt
disabled+honest + Duplicate hidden; convert busy «Saving securely…» →
soft-replace `#owner=` + Synced; evidence `pixel-qa/w1-2ae9a230/`). Pixel
MEDIUM residual (not BLOCKER): `?legacyRo=1` on `/hage` after convert →
«This legacy note does not exist» + Duplicate absent (expected U1 after row
flip); leftover unconverted smoke still needed; empty legacyRo helper still
A′ «table note» copy (POLISH/MEDIUM). Sentinel still completing
Encrypt/Duplicate/network before final verdict (pending; no Sentinel verdict
recorded).

## Walls

- This attest does not deploy origin / Pages / Worker / Edge
- SQL 240 already applied; this attest does not re-apply
- U1 SQL `capability_note_convert_legacy` + Edge `convert-legacy` not
  applied/published
- No `writes_enabled` / `private_realtime_enabled` flip
- Do not merge the attest PR from the implementing agent
