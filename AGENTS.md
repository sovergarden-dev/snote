# AGENTS.md

## Cursor Cloud specific instructions

Snote is a Vite + React 19 + TypeScript single-page app (realtime Markdown notes).
Standard commands live in `README.md` (Local development / Verification) and
`package.json` scripts; prefer those. Notes below are the non-obvious bits.

### Toolchain
- Package manager is **Bun `1.3.14`** (pinned via `packageManager`); Edge Function
  typechecking needs **Deno `2.9.3`**. Both are preinstalled and on `PATH` for
  interactive shells (`~/.bun/bin`, `~/.deno/bin` via `~/.bashrc`).
- System `node` is older than the repo's `engines` floor (`>=22.22.0`), but Bun
  ships its own Node-compat that satisfies it. Always run scripts through
  `bun run ...` / `bunx ...`, never `npm`/`node` directly.

### Running the app safely
- `bun run dev` serves the SPA on **http://localhost:8080** (port is fixed in
  `vite.config.ts`).
- `.env` contains a *publishable* Supabase anon config for the production
  backend. It is not a test environment. Never create, edit, delete, or share
  notes; run write-capable smoke/E2E tests; or invoke mutable API/Edge operations
  against it from local development or an agent session.
- Use an isolated local or staging Supabase project with synthetic fixtures for
  write-path testing. If one is unavailable, skip the write smoke test; never
  fall back to production.
- Keep production probes unauthenticated or publishable-key-only and read-only;
  never use service-role, admin, session, or capability credentials. Do not
  print or retain note content, slugs, capability tokens, URL fragments, or raw
  IP addresses.
- The committed `raw` Edge function is a `410 no-store` tombstone. Do not probe
  production `raw` with a real slug. Do not `GET /functions/v1/raw` with no extra
  path: the last segment `raw` is a legal slug. Invalid-locator checks such as
  `GET /raw/!` are the only safe credential-free probe for that name.

### Testing / checks
- `bun run test` (Vitest) runs fully offline; the integration test spins up an
  in-process Postgres via `@electric-sql/pglite`.
- `bun run typecheck:edge` runs `deno check` and downloads Supabase type deps
  from `esm.sh` on first run, so it needs network access the first time.
- E2E: do not run `bun run test:e2e` with the tracked `.env`; merely opening a
  new `/<slug>` can persist a note. Run it only after overriding all three
  `VITE_SUPABASE_*` variables to an isolated local/staging backend (or safe
  invalid values for tests that mock the backend). The wrapper
  `scripts/run-playwright.sh` tries `bunx playwright install --with-deps
  chromium`; if that is unavailable set `PLAYWRIGHT_FORCE_SYSTEM_CHROMIUM=1`
  (and optionally `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) to use a system
  Chromium.

### Cloudflare testing boundary
- Miniflare local được dùng cho test adapter DO; mọi kết nối, cấu hình hay deploy Cloudflare thật vẫn cấm.

### Git hooks
- Hooks are opt-in: `bun run hooks:install` sets `core.hooksPath=.githooks`. The
  pre-commit hook only runs the i18n allowlist check for i18n-relevant staged
  files.
