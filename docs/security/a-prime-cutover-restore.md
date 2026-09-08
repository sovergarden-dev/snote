# A′ Cutover restore — SPA routing (live on origin)

- Status: **Live on origin** `b4eba5d2` / Pages `07cb774d` (named Pages go of #126)
- Date: 2026-09-08
- Owners: Aegis (contract) · Pixel (UX) · Atlas (coord) · Syringa (named go)
- Canary: keep `VITE_CAPABILITY_ROUTES_ENABLED` / `capabilityRoutesEnabled` **on**

Choice A (#118) made canary-on plain `/<slug>` mount editable `NotePage`
(`notes` table path). That dispatcher default is **superseded by A′**.

Live origin `b4eba5d2` is A′ Cutover restore: plain `/slug` = Cutover/LNO RO.
This document does not apply SQL 240 and does not flip `writes_enabled` /
`private_realtime_enabled`. SQL 240 still HOLD (A′ is prerequisite, not apply).

## Mount table (canary on)

| URL | Mount |
|---|---|
| `/<slug>` no fragment | `CutoverNotePage` → `LegacyNotePage` (LNO RO) |
| `/<slug>?legacyRo=1` | `LegacyNotePage` RO (same chrome + banner) |
| `/<slug>#owner=` / `#edit=` | Capability `NotePage` (unchanged editable) |
| `/<slug>?legacyRo=1#owner=` | Legacy RO (Advanced Legacy ON from `#owner=`) |
| SplitView `/a+b` panes | Legacy RO via Cutover (`+` pathnames cannot carry a matching `#owner=`/`#edit=` fragment; fail-closed LNO) |
| `/:slug.md` | RawView unchanged (Phase C LNO `open`) |

Flag-off builds keep `NotePage` `legacyOnly` and do not import `CutoverNotePage`.

## Pixel UX

- Persistent `role="status"` banner **below** the topbar on Legacy RO chrome.
- CTA goes to **Home mint**, not Duplicate securely, not a fake Enable Edit.
- Plain Legacy RO **omits** the Encrypt row. `#owner=` Encrypt stays **active**.
- Do **not** reopen `allowEncryptionTransitions` on the plain table path.
- On plain RO, turning Legacy off must **not** reopen Choice A editable `NotePage`.
- Duplicate securely stays hidden (`DUPLICATE_SECURELY_AVAILABLE = false`).

Pixel visual A′ PASS on live `b4eba5d2` (plain `/hage` Legacy RO + banner +
CTA Home; Encrypt omit; Duplicate hidden; mint `#owner=` editable; evidence
`pixel-qa/a-prime-b4eba5d2/`).

## Walls

- This attest does not deploy origin / Pages / Worker / Edge
- No SQL 240 apply (A′ is prerequisite, not apply)
- No `writes_enabled` / `private_realtime_enabled` flip
- Do not merge the attest PR from the implementing agent
