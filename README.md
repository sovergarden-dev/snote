# Snote

Offline-first realtime Markdown notes with a separately gated capability model.

Production: [note.syrin.online](https://note.syrin.online/)

**Current status:** Production currently runs W1 convert-on-write (#130 U1 SPA
lineage on #131 tip) canary-on `CutoverNotePage` → editable `NotePage` for
plain `/<slug>` and SplitView panes (no A′ RO banner; Phase C still live;
Pixel HIGH UX H1–H6 still on this line; H2 opaque Mode/Export still on this
line; Ko-fi + New Version FAB still on this line; FAB-primary + Sonner
suppress (#113/#116) still on this line; Choice A (#118) editable-plain
default remains **superseded** on this line; PWA latch (#119) one hard-reload
per Update apply still on this line; Pixel Legacy opt-in (#122) still on this
line as `?legacyRo=1` / Legacy Advanced; Encrypt + Legacy Advanced remain
opt-in on the owner path; Encrypt disabled+honest (#123) on plain pre-convert,
`#owner=` Encrypt stays active; A′ (#126) RO default is **superseded**;
Duplicate securely (#128) remains enabled on Legacy RO only (Edge
`note-session` `import-legacy`); W1 + U1 SPA live on origin `2ae9a230`; Pixel
IDLE+UPDATE PASS (no Sonner on home) remains on this line; findings §3e):
`capabilityRoutesEnabled` true. Plain slug URLs and SplitView panes mount
`CutoverNotePage` → editable `NotePage`; first persist converts existing
legacy via `note-session` `convert-legacy` then soft-replaces to `#owner=`
with `convert_success` toast (empty notes mint via live `create`). U1 SQL
`capability_note_convert_legacy` and Edge `convert-legacy` are in GitHub
(#130) but **not applied/published** — convert-on-write first persist on
existing legacy assumes that Edge action. `#owner`/`#edit` still render
`NotePage`. Optional `?legacyRo=1` still RO + banner (`LegacyNotePage`; Phase B `legacy-note-open`
read-only). RawView `/:slug.md` loads via LNO `open`; Home availability uses
LNO `exists` (empty legacy rows are taken). Duplicate securely is enabled on
Legacy RO only (PR #128; Edge `note-session` `import-legacy`). Home mints capabilities when canary is on (fail-closed on idle). Additive SQL 220 and 270
are applied on production; `writes_enabled=true` and
`private_realtime_enabled=false` (findings §3d). SQL 240 is already applied;
soak ≥48h started from the first canary (not soak-complete) — see
[security findings](docs/security-findings.md). Pixel/Sentinel live verify for
this SHA may still be in flight; this attest does not record a Pixel or
Sentinel verdict.

**W1 live (named Pages go of #130/#131):** canary-on plain `/<slug>` and
SplitView panes are editable `NotePage` (convert-on-write). A′ (#126)
Cutover/LNO RO default is **superseded**. `#owner=`/`#edit=` still render
`NotePage`. `?legacyRo=1` still RO + banner. Canary stays on. SQL 240 already
applied; Worker / `writes_enabled` / Realtime still HOLD. U1 SQL+Edge
convert-legacy GitHub-ready / walls HOLD. See
[A′ Cutover restore](docs/security/a-prime-cutover-restore.md) for the remaining
Legacy RO path.

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
access. Dual-mode canary, W1 convert-on-write for plain `/slug`, Home mint, and
Duplicate securely (Legacy RO) are live. Soak is not complete;
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

After cutover, legacy notes stay exact-match until W1 first persist converts
them in place (same slug) or Duplicate securely copies them onto a new slug
from Legacy RO. They never acquire an owner implicitly. The planned rollback
keeps APIs read-only; it never restores public table policies.

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
