# Security findings — repository and rollout status

Production SQL 240 is already applied (`20260724000000_atomic_capability_cutover.sql`;
`capability_note_import_legacy` present). Additive SQL `20260722000000_capability_backend.sql` is
applied on production: columns, legacy-only RLS, capability tables, and
`writes_enabled=true`, `private_realtime_enabled=false` (see §3d).
Additive SQL `20260727000000_capability_sync_conflict_codes.sql` is also
applied: `capability_updates_append` returns `append_encryption_conflict` and
`capability_checkpoint_append` returns `checkpoint_encryption_conflict` /
`checkpoint_version_conflict`; `capability_note_manage` still uses generic
`version_conflict`.
Atomic SQL `20260724000000_atomic_capability_cutover.sql` is applied.
This attest does not re-apply 240. Worker / `writes_enabled` / Realtime still HOLD.
Capability SPA canary is on
(`VITE_CAPABILITY_ROUTES_ENABLED` is true; live `version.json`
`capabilityRoutesEnabled` is true; see §3e). W2 free-edit + Legacy opt-in is
live: canary-on plain `/<slug>` and SplitView panes mount `CutoverNotePage` →
editable `NotePage` (free-edit; no forced convert; no `#owner=` required to
edit); `#owner`/`#edit` still render `NotePage`. Legacy ON (owner only)
converts the current Y.Doc via `note-session` `convert-legacy` then
soft-replaces to `#owner=` with Pixel success toast; Encrypt becomes
available; `plain-upsert` returns HTTP 409 `capability_managed`. After
Legacy ON, bare `/{slug}` is read-only need-owner / Legacy-on banner + Home
CTA (AC A3; localStorage pin and/or LNO `managed:true`). Legacy OFF (owner
`#owner=` only) calls `disable-secure` and soft-replaces to bare free-edit;
`plain-upsert` returns 200 unmanaged again. SQL
`capability_note_plain_upsert` and `capability_note_disable_secure` are
**applied** live. U1 SQL `capability_note_convert_legacy` remains
**applied** live. Edge `note-session` `plain-upsert`, `disable-secure`, and
`convert-legacy` are **published** (`convert-legacy` Pulse `umsg_01m21zhm…`).
Edge `legacy-note-open` is republished with `managed:true` for managed slugs.
SQL `capability_note_bulk_disable_secure` is **applied** live (Syringa Go A
then B; Pulse **PASS**; git tip `bd11deed` / #142; #143 is git-only PWA smoke
harden). Live SPA origin remains `0cdcdc0f`. Go C pin heal **HOLD**. See §3f.
W1 convert-on-write as product default is **superseded**.
Optional `?legacyRo=1` still RO + banner. Phase C is live: RawView `/:slug.md` loads via LNO `open`;
Home availability uses LNO `exists` (empty legacy rows are taken). Duplicate securely is enabled on Legacy RO only (PR #128; Edge `note-session` `import-legacy`). Pixel HIGH UX H1–H6 is live. H2 opaque Mode/Export is live. Ko-fi + New Version FAB is live. FAB-primary + Sonner suppress (#113/#116) is live. Choice A (#118) editable-plain default is **superseded**. PWA latch (#119) one hard-reload per Update apply is live. Pixel Legacy opt-in (#122) is live as Legacy Advanced. Encrypt is disabled on free-edit (Legacy OFF) and becomes available after Legacy ON on the owner path; `#owner=` Encrypt stays active. A′ (#126) RO default is **superseded**. Duplicate securely (#128) remains on Legacy RO. Home mints capabilities when canary is on
(create → `/<slug>#owner=`; fail-closed idle; live origin `0cdcdc0f`).
Home mint before SQL 240 is accepted as
[ADR-001](adr/001-home-capability-mint-before-sql-240.md); live mint is
not authorization to flip `private_realtime_enabled`.
The [SQL 240 readiness contract](security/sql-240-readiness-contract.md) and
[ops preflight](security/sql-240-ops-preflight.md) are a docs package only;
they do **not** authorize re-apply. This is not SQL 240, not Realtime, not soak-complete.
W2 live (named Pages go of #135/#137/#138/#139): canary-on plain `/<slug>` is
free-edit. W1 convert-on-write as product default is **superseded**. A′ (#126)
Cutover/LNO RO default is **superseded**. Choice A (#118) editable-plain
default is **superseded**. See
[A′ Cutover restore](security/a-prime-cutover-restore.md) for the remaining
Legacy RO path. SQL 240 already applied; W2 SQL
`capability_note_plain_upsert` / `capability_note_disable_secure` applied
live; U1 SQL `capability_note_convert_legacy` applied live; Edge
`plain-upsert` / `disable-secure` / `convert-legacy` published (Pulse
`umsg_01m21zhm…` for `convert-legacy`). Worker / `writes_enabled` / Realtime
still HOLD. This does not deploy and does not re-apply SQL 240.
`VITE_CAPABILITY_AUTH_ENABLED` and `VITE_ADMIN_PANEL_ENABLED` stayed
false. Local tests prove capability code contracts only; soak and
post-cutover probes remain mandatory gates. Soak ≥48h started from the
first §3e origin canary. Do not treat 220, 270, `writes_enabled`, or this
origin canary as authorization to flip
`private_realtime_enabled`.

In the target post-cutover architecture, slugs are locators rather than
authorization credentials. New notes use owner/edit/view capabilities, while
legacy notes are exact-match read-only and may only be copied into a new
capability-managed note.

## 1. Legacy metadata and crawler previews — production verified

`note-meta` is deployed as a generic `410 no-store` tombstone. It does not parse
a token, initialize a database client, or return content or a locator. The
deployed `note-meta` endpoint is production-verified. Credential-free probes on
2026-08-30 covered no-query, synthetic slug, synthetic token, and combined-query
variants; each returned `{"found":false}`, `410`, `Cache-Control: no-store`, and
`CDN-Cache-Control: no-store` without echoing a locator, token, or content. The
Cloudflare Worker returns generic, non-indexable, `no-store` HTML for crawler
requests to legacy note and share paths before consulting metadata or Cache
API.

Worker crawler containment is live and verified in production. The ordered
runbook in `docs/security/immediate-containment-rollout.md` remains authoritative
for any future Worker, cache-purge, or tombstone change. Rollback must retain
generic containment. Live Worker identity is §1c; it is not the SPA origin SHA.

## 1a. Legacy `raw` dump — production verified

The committed `raw` Edge function is a generic `410 no-store` tombstone matching
`note-meta`. It does not parse a locator, initialize a database client, or
return note bytes. Keep the name deployed as this handler; deleting it would
404, which is weaker if something still calls the path. The deployed `raw`
endpoint is production-verified. Credential-free probes on 2026-09-01 covered
`GET /functions/v1/raw/!`; that invalid extra path returned `{"found":false}`,
`410`, `content-type: application/json`, `Cache-Control: no-store`, and
`CDN-Cache-Control: no-store` without echoing a locator or content. `POST` to
the same path returned `405` with the same JSON `no-store` body. `OPTIONS`
returned `200`. This is not the old `400` `text/plain` dump handler. The
tombstone was deployed ~2026-09-01 19:47 ICT via Lovable Cloud Edge function
`raw` only. GitHub source tombstone was PR #32; at that raw deploy the SPA
origin was `fe18302f` with canary off. Current origin is §3e.

Do not `GET /functions/v1/raw` with no extra path; the last segment `raw` is a
legal locator. Do not probe production `raw` with a real locator. Probe only
`GET /raw/!` (or another invalid extra path).

The live SPA editor path does not need this endpoint (Phase C live:
`RawView` `/:slug.md` loads via LNO `open`, not `public.notes`). ExportMenu no longer copies `/functions/v1/raw/...`;
the remaining export action copies the canonical public RawView URL
`https://note.syrin.online/{slug}.md` (`/:slug.md`). `share-revoke` remains live
and is out of scope for this containment.

## 1b. Legacy `legacy-note-open` — Phase B production live

Git `legacy-note-open` is the Phase B exact-match **SELECT-only** Edge Function
for `POST { action: "exists" | "open", slug }`. It is not a 410 tombstone and not
a dump: service-role `SELECT` with
`notes.slug = $slug AND capability_managed = false AND sync_status = 'legacy'
AND deleted_at IS NULL`; never INSERT/UPDATE/DELETE; never return capability
ciphertext; invalid action/slug is `400 { "error": "invalid request" }` without
echoing the slug. Live `open` on a capability-managed slug returns
`{ exists: false, managed: true }` (republished; this attest does not redeploy
Edge). Keep the function name; the client is hard-wired in
`src/lib/legacy/cutover.ts`. `verify_jwt = false` is unchanged. HMAC
CF-Connecting-IP admission is omitted because this path is SELECT-only and has
no admission window; consume RPCs would write; no Turnstile.

Production Edge is this Phase B reader (Atlas A+B; independently probed
2026-09-06 ~21:21 UTC / 2026-09-07 ~04:21 ICT and re-probed 2026-09-07
~00:38 UTC / ~07:38 ICT, publishable-key-only, no locator): `OPTIONS /functions/v1/legacy-note-open` returned `200` body `ok`
(`Cache-Control` / `CDN-Cache-Control` `no-store`); `GET` returned `405`
`{"error":"method not allowed"}` with the same `no-store` JSON headers;
`POST {}` returned `400` `{"error":"invalid request"}` (not `410`
`{"found":false}`). Do not POST a locator to production. This docs PR does
not deploy Edge.

Historical production-verified 410 (replaced by the Phase B Edge go):
credential-free probes on 2026-09-02 ~04:20 ICT against production functions host
`onfzjmfjldsbthchssfr` covered unauthenticated calls with no locator in the body:
`OPTIONS /functions/v1/legacy-note-open` returned `200` body `ok` (`Allow-Methods`
POST, OPTIONS); `GET` returned `405` `{"found":false}`, `content-type:
application/json`, `Cache-Control: no-store`, and `CDN-Cache-Control: no-store`;
`POST {}` returned `410` with the same JSON `no-store` body. This is not gateway
`NOT_FOUND` / 404. The tombstone was deployed
2026-09-02 via Lovable Cloud Edge function `legacy-note-open` only. Git source
of that live 410 tombstone includes PR #56 (`eab48218`); the Edge function comment
no longer claims gateway 404. Hosted function was re-pinned 2026-09-02 ~06:20 ICT from
that git; HTTP contract unchanged from the earlier 2026-09-02 ~04:20
production-verified 410. Default production SPA no longer contains quoted
`legacy-note-open` (PR #41; at that 410 pin live origin was `fe18302f`,
canary off; current origin is §3e). `share-revoke`
remains live (POST `{}` still 400, not 410) and is out of scope for this
containment.

## 1c. Production Worker identity — live 2026-09-03

Production Worker `syrin-prerender` was redeployed 2026-09-03 ~20:42 UTC /
2026-09-04 ~03:42 ICT from git `main`
`931430c016772d333f79aa31841e31aca2b327a4` (merge of PR #89).

- Git SHA: `931430c016772d333f79aa31841e31aca2b327a4` (short `931430c0`)
- Cloudflare Version ID: `5f94ab6c-fde5-4416-a3aa-74daaa2e6094`
- Replaces previous Cloudflare Version ID `b4d1a94e…`
- Live Worker: observability enabled, logs enabled, `invocation_logs` true;
  traces still false. Committed `wrangler.toml` matches this live log state.
  `workers_dev` false; preview URLs false; `ORIGIN_HOST` `snote-g4-origin.pages.dev`
- Live origin-fetch behavior: runtime and immutable assets forward only a
  conservative `__WB_REVISION__` query; locator, token, home, public, note,
  and share queries remain stripped
- Staging `syrin-prerender-staging` was not deployed (still G3C staging
  versions from 2026-08-24)

This is not the live SPA origin. Origin is `0cdcdc0f` (see §3e).
At this Worker deploy, origin was not redeployed (then `27da93eb`);
origin later bumped to `e05c73ea`, then `addeeb29`, then `7d00fd52`, then `77d791af`, then `9df65d53`, then `9bf5e92b`, then `b6824541`, then `a8f7eeb8`, then `5c33ac24`, then `9dc0240e`, then `15ec8285`, then `0073d53b`, then `1e76e2b7`, then `b4eba5d2`, then `f84183ba`, then `2ae9a230`, then `0cdcdc0f`. Do not claim origin is `931430c0`. Git `main`
includes this Worker SHA and may be ahead of live origin for later docs-only PRs; that
does not change Worker identity or treat later main commits as live origin.

Canary is on (`capabilityRoutesEnabled` true; see §3e). SQL 240 is already
applied. `writes_enabled=true`, `private_realtime_enabled=false` (see §3d).
Soak ≥48h started from the first §3e origin canary.

Containment probes on `note.syrin.online` (2026-09-03): crawler UA on a
synthetic note path and `/s/synthetic-probe-token` returned generic private
HTML with `Cache-Control` / `cdn-cache-control` `no-store` and
`X-Robots-Tag` noindex…; bodies did not echo locator or token.

## 2. Admin authentication and cleanup — implemented, deploy unverified

Only `admin-session` accepts an admin passphrase. It reserves a serialized SQL
admission lease and consumes failed attempts atomically. The client receives a
short opaque session bound to a keyed digest of the gateway-verified client
address. Ambiguous forwarding headers, database errors, and retention-RPC
errors fail closed with `503`.

Login retains a bounded legacy compatibility contract: any non-empty value up
to 1,024 JavaScript code units may be checked against an existing hash.
Newly rotated passphrases alone enforce the 12–72 UTF-8-byte bcrypt policy.

`admin-list`, `admin-delete`, and `admin-rotate` accept only that session.
Rotation atomically updates the credential epoch and revokes outstanding
sessions. The old destructive `cleanup` endpoint is a generic `410 no-store`
tombstone. `admin_security_prune()` is service-role-only; production must also
schedule and monitor its daily retention run.

The migration must precede the Edge functions. No production limiter or
session guarantee is claimed until concurrent-failure and database-failure
probes pass against the deployed environment.

## 3. Share capabilities and compatibility URLs — implemented, deploy unverified

New view capabilities travel in `/s#view=<token>`, then only in an exact
`Authorization: Bearer` header. `share-view` does not return the note slug,
marks responses `no-store`, and returns generic errors without logging raw
request data. Rotating a view capability revokes the previous generation.
`share-rename` is a `410 no-store` tombstone.

Legacy `/s/:token` is a 30-day compatibility shell. Before React starts it
moves the token into the fragment, removes it from the visible path, and uses
`no-store`/`no-referrer`; after the configured deadline it fails closed. The
Worker never forwards the raw path token. Origin fetch for runtime and
immutable assets may forward only a conservative `__WB_REVISION__` query
(PR #52 behavior, still live); locator, token, home, public, note, and share
queries are still stripped. Invocation logs are live on the current Worker
(§1c); traces and cache keys still require deployment-time review and
redaction.

## 3a. Additive capability backend SQL 220 — production verified

Verified 2026-09-01 ~23:31 ICT against production Lovable Cloud project
`8f71f52d-c666-442f-bfb8-5f0a4e0ac1d5` / Supabase `onfzjmfjldsbthchssfr`.
Current production (header / §3e / §4): SQL 240 is already applied. The
grants, Legacy policies, and `capability_note_import_legacy` is absent claims
in this §3a are the 2026-09-01/02 SQL 220 check, not current live.
There is no `supabase_migrations.schema_migrations` relation on this database;
do not claim a recorded migration version. Do not re-run
`20260722000000_capability_backend.sql`: the singleton INSERT is not
idempotent.

`public.notes` already has the SQL 220 columns: `note_id` (uuid, default
`gen_random_uuid()`), `capability_managed` boolean NOT NULL default false,
`sync_status` `note_sync_status` NOT NULL default `'legacy'`, plus
`encryption_version`, `payload_limit_bytes`, `storage_limit_bytes`,
`update_limit_count`, `checkpoint_limit_count`, and `deleted_at`.

Notes RLS policies are only these three: `Legacy notes remain readable`
USING (`NOT capability_managed`); `Legacy notes remain creatable` WITH CHECK
(`NOT capability_managed AND sync_status = 'legacy'`); `Legacy notes remain
writable` USING (`NOT capability_managed`) WITH CHECK
(`NOT capability_managed AND sync_status = 'legacy'`). The old
`Anyone can * notes` policies are gone.

Aggregate counts only: 61 notes, 0 `capability_managed`, 0 with
`sync_status` other than `legacy`. The `anon` role still sees all 61 (RLS
allows legacy rows).

`anon` and `authenticated` still have SELECT, INSERT, UPDATE on
`public.notes` (also REFERENCES, TRIGGER, TRUNCATE) **at that 2026-09-01 check**.
SQL 240 would REVOKE these and drop every notes policy; that had not happened
yet at that check. Current live: SQL 240 already applied (header / §4).

Tables present: `note_capabilities`, `note_updates`, `note_checkpoints`,
`note_realtime_memberships`, `capability_admission_windows`,
`capability_runtime_settings`. At that 2026-09-01 check, kill switch row:
`capability_runtime_settings` `singleton=true`, `writes_enabled=false`,
`private_realtime_enabled=false`. Current production row is §3d
(`writes_enabled=true`, Realtime still false). At that 2026-09-01 check, function
`capability_note_import_legacy` is absent (SQL 240 not applied). Function
`capability_checkpoint_append` exists (SQL 230 objects are present). Live
SPA still does not mount `CutoverNotePage`. This §3a attestation is 220 vs
240 vs canary; it is not a 230 soak claim. SQL 270 conflict-code verification
is §3b. Current origin canary is §3e.

At that 2026-09-01/02 SQL 220 check, live SPA
`https://note.syrin.online/version.json` (same fields on
`https://snote-g4-origin.pages.dev/version.json`):
`deployedSha` `fe18302fb650b98eaee414e34e61db5cf06acc61`,
`capabilityRoutesEnabled` false, `builtAt` `2026-09-01T19:55:38.557Z`,
`buildId` `1788292524728-ej6uxgse`.
Canary off at that check. Origin then included PR #47 PWA recovery (`clientsClaim` off),
PR #48 shortened Update toast (no `update.fallback_cleanup` / cookie
paragraph), and PR #50 enc-meta error + Retry gate. Do not claim origin
is `9fcc58bc`. Live Worker identity is §1c.

## 3b. Additive capability sync conflict codes SQL 270 — production verified

Verified 2026-09-01 ~23:59 ICT / 2026-09-02 ~00:03 ICT against production
Supabase `onfzjmfjldsbthchssfr` (same project as §3a). Confirmed via
`pg_get_functiondef`, not via `schema_migrations` — that relation still does
not exist. Do not re-run `20260722000000_capability_backend.sql` or
`20260727000000_capability_sync_conflict_codes.sql`. Function REPLACE is
less dangerous than 220's singleton INSERT, but this record is attestation
only.

`capability_updates_append` returns `append_encryption_conflict` (not generic
`version_conflict`) on encryption mismatch. `capability_checkpoint_append`
returns `checkpoint_encryption_conflict` and `checkpoint_version_conflict`.
`capability_note_manage` still uses generic `version_conflict`; that is
expected — 270 does not rewrite manage.

At that 2026-09-01 check the row was `writes_enabled=false`,
`private_realtime_enabled=false`. Current production row is §3d
(`writes_enabled=true`, Realtime still false). SQL 240 still not applied:
`capability_note_import_legacy` is absent; anon still has notes grants; the
three Legacy policies remain.

At that 270 check SPA canary was still off: live
`https://note.syrin.online/version.json`
`capabilityRoutesEnabled` false, `deployedSha`
`fe18302fb650b98eaee414e34e61db5cf06acc61`, `builtAt`
`2026-09-01T19:55:38.557Z`, `buildId` `1788292524728-ej6uxgse`.
Origin then included PR #47 PWA recovery (`clientsClaim` off), PR #48
shortened Update toast (no `update.fallback_cleanup` / cookie
paragraph), and PR #50 enc-meta error + Retry gate. Do not claim origin
is `9fcc58bc`. Current origin canary is §3e. Live Worker identity is §1c.

Production `note-session`, `note-sync`, and `note-manage` were SHA-pin
redeployed 2026-09-02 ~05:22 ICT from git via Lovable Cloud (0.8 credits),
those three names only. Independent credential-free probes after that
deploy against production functions host `onfzjmfjldsbthchssfr`
(unauthenticated, empty POST body, no locator) for each of those three
names still match git mapper `capabilityCorsHeaders` (includes
`x-snote-auth`, `x-legacy-share`, `Retry-After`): OPTIONS 200 `ok`; GET
405 `{"error":"method not allowed"}` with `cache-control: no-store` and
`cdn-cache-control: no-store`; POST `{}` 401 `{"error":"unauthorized"}`
(no `code` field) with both no-store headers. Still 401 not 503
`unavailable` (HMAC and service-role env present). Still not 410.
`share-revoke` POST `{}` still 400 `invalid token`. `legacy-note-open`
POST still 410. At that Edge SHA-pin, origin was still `fe18302f` /
`capabilityRoutesEnabled` false. Worker still §1c (`9fcc58bc` /
`b4d1a94e`). Canary off at that pin. SQL 240 not applied. Current kill
switch: §3d (`writes_enabled=true`, Realtime still false). Current origin
canary is §3e.

Staging `dmfrydhubosecaatjjwf` was not redeployed this time. Earlier
staging HTTP matched git mapper `capabilityCorsHeaders` (includes
`x-snote-auth`, `x-legacy-share`, `Retry-After`; OPTIONS 200 `ok`; GET
405 `{"error":"method not allowed"}` and POST `{}` 401
`{"error":"unauthorized"}` with no `code`; both cache headers
`no-store`). That is a historical HTTP match, not a 2026-09-02 staging
SHA-pin.

Git function bodies last `0e1ea254` (2026-08-25, PR #19). Mapper
`_shared/capability-edge.ts` last `b0417482` (2026-07-27, 270 codes).
`verify_jwt = false` remains required. Production was redeployed from
git `0e1ea254`; hosted source bytes still cannot be listed (management
list API 403). Do not invent a hosted blob SHA. Live Worker identity is
§1c and is distinct from this SPA origin SHA.

This is not a soak claim. This 270 attestation is not authorization to
apply 240 or flip `private_realtime_enabled`. The later `writes_enabled`
go is §3d. The later origin canary is §3e. Neither is soak-complete.

## 3c. Production daily backups — verified, no PITR

Verified 2026-09-02 ~10:26 ICT from the Lovable Cloud UI for project
`8f71f52d-c666-442f-bfb8-5f0a4e0ac1d5` / Supabase `onfzjmfjldsbthchssfr`.
Nothing was restored. At that 10:26 ICT read the row was
`writes_enabled=false`, `private_realtime_enabled=false`
(`capability_runtime_settings.updated_at` `2026-08-26 04:32:27 UTC`).
Same-day later go is §3d.

The authoritative backup panel is Lovable Cloud → More → Cloud → Database →
Backups. The supabase.com dashboard for this ref 404s from our session; do
not treat that 404 as "no backups."

There is no PITR / point-in-time UI on this project (Tiny instance, disk
0.47/2 GB). The cutover runbook's "PITR checkpoint" is not available here.
Recoverable backups are 14 daily automated snapshots, taken ~19:33–19:35 UTC
each day (~02:33 ICT the next calendar day). Latest listed:
`2026-09-01 19:33:22 UTC` (`2026-09-02 02:33 ICT`). Oldest listed:
`2026-08-19 19:34:43 UTC`. Each row is restore-only; there is no download and
no manual create-backup button. Nothing on that panel was clicked.

Worst-case loss on restore-to-snapshot is up to ~24h of writes. The live
write path is still legacy `NotePage`.

This backup-panel check is not a soak claim. This is not authorization to call
`capability_runtime_set`, flip `writes_enabled` or `private_realtime_enabled`,
origin-deploy, flip the canary, or apply SQL 240 — that 10:26 ICT verify was
not the go; the named later `writes_enabled` go is §3d; later origin canary is
§3e; neither is soak-complete or SQL 240.

## 3d. Production writes_enabled go — verified, Realtime still false

Verified 2026-09-02 against production Lovable Cloud project
`8f71f52d-c666-442f-bfb8-5f0a4e0ac1d5` / Supabase `onfzjmfjldsbthchssfr`.
Canonical origin remains `https://note.syrin.online/` (do not advertise `snote.lovable.app`).

Daily snapshot re-check 2026-09-02 ~11:23 ICT (Lovable Cloud → More → Cloud →
Database → Backups), production not staging: latest snapshot still
`2026-09-01 19:33:22 UTC` (`2026-09-02 02:33:22 ICT`). 14 daily automated
snapshots (oldest visible `2026-08-19 19:34:43 UTC`). No PITR / point-in-time
UI. Restore not clicked.

Named go: `SELECT public.capability_runtime_set(true, false);`
via Lovable Cloud `query_database`. Confirmed row:
`capability_runtime_settings` `singleton=true`, `writes_enabled=true`,
`private_realtime_enabled=false`, `updated_at`
`2026-09-02 04:24:07.235188+00` (11:24 ICT).

SQL 240 still not applied: `capability_note_import_legacy` is absent. At that
go, live SPA was still GET `https://note.syrin.online/version.json`
`deployedSha` `fe18302fb650b98eaee414e34e61db5cf06acc61`,
`capabilityRoutesEnabled` false, `builtAt` `2026-09-01T19:55:38.557Z`.
POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`
no-store. Live write path is still legacy `NotePage`;
this flip does not mount `CutoverNotePage` and is not a canary.

This is not canary, not SQL 240, not origin/Worker deploy, not
`private_realtime_enabled`, and not soak.
Later origin canary is §3e.

## 3e. Production origin canary go — capabilityRoutesEnabled true

Verified 2026-09-02 ~12:01 ICT. Cloudflare Pages project `snote-g4-origin`
via `wrangler pages deploy` of a strict `build:release`. Build flags:
`VITE_CAPABILITY_ROUTES_ENABLED=true` only. `VITE_CAPABILITY_AUTH_ENABLED` and `VITE_ADMIN_PANEL_ENABLED` stayed false.

Canonical origin remains `https://note.syrin.online/` (do not advertise `snote.lovable.app`).

First canary origin (not current live) `version.json` at that go
(browser UA; `no-store`) on both
`https://note.syrin.online/version.json` and
`https://snote-g4-origin.pages.dev/version.json`:
`deployedSha` `c5914c8e8f953d5e8ed877d8c892b6e0941095e7`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T05:00:59.705Z`,
`buildId` `1788325246305-qzfta8za`.

Pages production deployment id `6277a076-c0d3-4464-b5b5-5b0432011029`
replaced previous production `fe18302f` / `32ccfc35`.

Same-canary origin SHA bump 2026-09-02 ~16:03 ICT (not current live): Pages
`snote-g4-origin` redeployed find/replace UI (#64+#65). `version.json` at
that bump (browser UA; `no-store`) on both canonical and Pages hosts:
`deployedSha` `386421e87f7eac2864f1a40655a2b0255b4332d6`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T09:02:48.606Z`,
`buildId` `1788339753769-8ld1rqzh`.
Pages production deployment id `09472051-c61c-4fcb-ace4-1561da6d4cc2`
replaced previous live origin `c5914c8e` / Pages `6277a076`.

Same-canary origin SHA bump 2026-09-02 ~17:52 ICT (not current live): Pages
`snote-g4-origin` redeployed find overlay top-right + markdown table preview
(#67). `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `4baa89665ee1d75dcafb238d62fbed9b18f8a7c7`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T10:52:01.159Z`,
`buildId` `1788346307439-oyd5q3or`.
Pages production deployment id `a138549e-0c61-4e0c-83f2-366c341309a9`
replaced previous live origin `386421e8` / Pages `09472051`.

Same-canary origin SHA bump 2026-09-02 ~19:22 ICT (not current live): Pages
`snote-g4-origin` redeployed paste HTML copy-box no longer escapes `_` as
`\_` (#69). `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `7335fadce1dc96ee5548deb2e7e75b2bbff57c40`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T12:22:26.889Z`,
`buildId` `1788351733291-8f4qsmpx`.
Pages production deployment id `86b91475-2b60-4c30-81e8-50b6a004a734`
replaced previous live origin `4baa8966` / Pages `a138549e`.

Same-canary origin SHA bump 2026-09-02 ~20:41 ICT (not current live): Pages
`snote-g4-origin` redeployed find overlay `position:fixed` and horizontally centered
(~50vw, clamped); Note dropdown removed (#71). `version.json` at that bump
(browser UA; `no-store`) on both canonical and Pages hosts:
`deployedSha` `8d9ce025d05c65664afaba78b9b145bf137edb83`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T13:40:14.339Z`,
`buildId` `1788356400749-1b51r8sg`.
Pages production deployment id `e3033d20-c0db-4a9d-95e4-e96abb459572`
replaced previous live origin `7335fadc` / Pages `86b91475`.

Same-canary origin SHA bump 2026-09-02 ~22:41 ICT (not current live): Pages
`snote-g4-origin` redeployed Phase 1 knowledge UX — `[[slug]]` and Obsidian-order
`[[slug|display]]`, client-only backlinks in outline, dotted dead links
(#73). `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `e39caacd6b37518d61498262ba38506de64f5545`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T15:41:04.072Z`,
`buildId` `1788363650837-yre560cm`.
Pages production deployment id `005b2f9d`
replaced previous live origin `8d9ce025` / Pages `e3033d20`.

Same-canary origin SHA bump 2026-09-02 ~23:49 ICT (not current live): Pages
`snote-g4-origin` redeployed Phase 2 knowledge UX — Cmd-K corpus search and `#tag` filter,
plus `fast-uri` ^3.1.6 override (#75). `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `4c7918619eb6d9b56523444fa1eb8d154e0eba01`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T16:49:02.306Z`,
`buildId` `1788367729384-c7thqlof`.
Pages production deployment id `878a55d0`
replaced previous live origin `e39caacd` / Pages `005b2f9d`.

Same-canary origin SHA bump 2026-09-03 ~02:31 ICT (not current live): Pages
`snote-g4-origin` redeployed Phase 3 knowledge UX — GFM callouts, slash mermaid/math, transclude
(#77). `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `92aa4e0db313f2abec12cc233175e5f86dd4b24a`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T19:31:08.064Z`,
`buildId` `1788377454668-bm60zdsr`.
Pages production deployment id `6b434d48`
replaced previous live origin `4c791861` / Pages `878a55d0`.

Same-canary origin SHA bump 2026-09-03 ~04:24 ICT (not current live): Pages
`snote-g4-origin` redeployed Phase 4 knowledge UX — Home tag filter, virtual collections, templates.
Lazy `HomeLibraryPanel` / `HomeTemplatePicker` (#79). `version.json` at that bump
(browser UA; `no-store`) on both canonical and Pages hosts:
`deployedSha` `1f21777e7d562b4ae5f71bc7d72d7df44dd50557`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T21:23:43.585Z`,
`buildId` `1788384208561-3dfszwdt`.
Pages production deployment id `a88095b0`
replaced previous live origin `92aa4e0d` / Pages `6b434d48`.

Same-canary origin SHA bump 2026-09-03 ~05:07 ICT (not current live): Pages
`snote-g4-origin` redeployed firefox Home install dialog swallowed by lazy
`HomeTemplatePicker` (#81). Open on mousedown, sized desktop picker slot, keep
DialogTrigger for Escape focus. `version.json` at that bump (browser UA;
`no-store`) on both canonical and Pages hosts:
`deployedSha` `d15aee5d243630abc7f143225b2ca9cdb44dd7b2`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T22:06:29.822Z`,
`buildId` `1788386776564-qtmwh3o1`.
Pages production deployment id `2870a660`
replaced previous live origin `1f21777e` / Pages `a88095b0`.

Same-canary origin SHA bump 2026-09-03 ~06:34 ICT (not current live): Pages
`snote-g4-origin` redeployed Phase 5 knowledge UX — history burst diffs and
selective hunk restore (#83). Local IndexedDB snapshots only. `version.json`
at that bump (browser UA; `no-store`) on both canonical and Pages hosts:
`deployedSha` `4c84659244f01153bab6c6f4655fe8725df419b4`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-02T23:34:16.494Z`,
`buildId` `1788392043070-ed273a61`.
Pages production deployment id `7e140ebf`
replaced previous live origin `d15aee5d` / Pages `2870a660`.

Same-canary origin SHA bump 2026-09-03 ~10:30 ICT (not current live): Pages
`snote-g4-origin` redeployed clip pasted URL / slash `/clip` to local
Readability+Turndown markdown in the user's browser (#85). Fetch uses
`credentials:omit`; fail-closed to the raw URL on CORS, private IP, or timeout.
No TinyFish/Worker proxy. `version.json` at that bump (browser UA; `no-store`)
on both canonical and Pages hosts:
`deployedSha` `4ef734ee97a93d1922eefde01a6453c828f9aed3`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-03T03:30:28.721Z`,
`buildId` `1788406215104-lywhln09`.
Pages production deployment id `a59b0964-8ca6-4a89-a155-e0346eebd347`
replaced previous live origin `4c846592` / Pages `7e140ebf`.

Same-canary origin SHA bump 2026-09-03 ~15:43 ICT (not current live): Pages
`snote-g4-origin` redeployed unwrap inline-code http(s) URLs on HTML paste (#87).
Slack/Discord/Telegram `<code>` URLs become autolinks after Turndown. Shift-paste
still raw. No TinyFish/Worker proxy. `version.json` at that bump (browser UA;
`no-store`) on both canonical and Pages hosts:
`deployedSha` `27da93eb2db7fa670f721ce2ecbb79971f489bb2`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-03T08:42:12.078Z`,
`buildId` `1788424919271-lf485uzb`.
Pages production deployment id `4f5e5afc-c80b-46b8-b053-71e8339040d2`
replaced previous live origin `4ef734ee` / Pages `a59b0964-8ca6-4a89-a155-e0346eebd347`.

Same-canary origin SHA bump 2026-09-04 ~14:39 ICT (not current live): Pages
`snote-g4-origin` manually redeployed Home capability mint (#95). Cloudflare
Pages Git Provider is No, so origin stayed at `27da93eb` after that merge
until that production deploy. Home create (canary on) persists an owner
candidate, `POST note-session` `{action:"create"}`, then navigates
`/<slug>#owner=<token>`. Plain slug remained the legacy write path at
that bump.
`version.json` at that bump (browser UA; `no-store`) on both canonical and
Pages hosts:
`deployedSha` `e05c73ead67a3751d07a4042ba68fe86fcb271a8`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-04T07:39:26.164Z`,
`buildId` `1788507551045-leqeymq1`.
Pages production deployment id `028e8199-02c8-4583-8890-bbd2f09dc8f0`
replaced previous live origin `27da93eb` / Pages `4f5e5afc-c80b-46b8-b053-71e8339040d2`.
PWA smoke after that ship: SUCCESS (GitHub Actions run `33849773178`).

Same-canary origin SHA bump 2026-09-04 ~17:34 ICT (not current live): Pages
`snote-g4-origin` redeployed fail-closed Home mint (#98). Home create (canary
on) never fail-opens idle slug status to legacy `seedAndOpen`; idle submit
re-checks `notes.select`, then on `available` persists an owner candidate,
`POST note-session` `{action:"create"}`, and navigates `/<slug>#owner=<token>`.
Live smoke confirmed that path lands on `/<slug>#owner=` (token in the
fragment; not logged here). Plain slug remained the legacy write path at
that bump. `version.json` at that bump (browser UA; `no-store`) on both
canonical and Pages hosts:
`deployedSha` `addeeb29cd9a6dac73c406f251ff5305db12f8f7`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-04T10:34:53.874Z`,
`buildId` `1788518080553-dg3glr2m`.
Pages production deployment id `25c47833-fd81-42b1-ba6b-39e7e8f5a5e3`
replaced previous live origin `e05c73ea` / Pages `028e8199-02c8-4583-8890-bbd2f09dc8f0`.
PWA smoke after that ship: SUCCESS (GitHub Actions run `33863872787`).
At that bump, credential-free LNO POST {} returned 410 `{"found":false}`.

Same-canary origin SHA bump 2026-09-07 ~04:11 ICT (not current live): Pages `snote-g4-origin`
redeployed Phase A `CutoverNotePage` wire (#101) with git `7d00fd52` (#103
Phase B LNO source). Canary-on SPA mounts `CutoverNotePage`: plain `/<slug>`
lazy-loads `LegacyNotePage`; matching `#owner`/`#edit` still render
`NotePage`; flag-off builds keep `NotePage` with `legacyOnly={!canary}`.
Phase B Edge `legacy-note-open` was already live (Atlas A+B); see §1b.
`version.json` at that bump (browser UA; `no-store`) on both canonical and Pages
hosts, plus short Pages preview `https://ed0e177e.snote-g4-origin.pages.dev`:
`deployedSha` `7d00fd52f9c01fdb954ad9e2f034c784d9311bed`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-06T21:11:03.163Z`,
`buildId` `1788729048596-q0bbwjr7`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses).
Pages production deployment id `ed0e177e-b127-48b2-bac1-8e2460c82b28`
replaced previous live origin `addeeb29` / Pages `25c47833-fd81-42b1-ba6b-39e7e8f5a5e3`.
At that bump, credential-free LNO POST {} returned 400 `{"error":"invalid request"}`.

Same-canary origin SHA bump 2026-09-07 ~07:28 ICT (not current live): Pages `snote-g4-origin`
redeployed Phase C RawView+Home off `public.notes` via LNO (#105) with git
`77d791af`. Canary-on SPA still mounts `CutoverNotePage` (Phase A): plain
`/<slug>` lazy-loads `LegacyNotePage`; matching `#owner`/`#edit` still render
`NotePage`; flag-off builds keep `NotePage` with `legacyOnly={!canary}`.
Phase C: RawView `/:slug.md` loads via LNO `open`; Home availability uses
LNO `exists` (no `char_count`; `exists: true` includes empty legacy rows and
is treated as taken). Home mint fail-closed idle remains live. Phase B Edge
`legacy-note-open` remains live (see §1b). This origin attest does not deploy
Edge.
`version.json` at that bump (browser UA; `no-store`) on both canonical and Pages
hosts, plus short Pages preview `https://1fbf89fe.snote-g4-origin.pages.dev`:
`deployedSha` `77d791af89696877f1f794a94270395902285c56`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T00:28:21.829Z`,
`buildId` `1788740888124-oepsltsc`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses).
Pages production deployment id `1fbf89fe` (short preview
`https://1fbf89fe.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `7d00fd52` / Pages
`ed0e177e-b127-48b2-bac1-8e2460c82b28`.
PWA smoke after that ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34070206821`). Pulse smoke PASS: Home mint, Cutover→LNO, RawView `.md`.

Same-canary origin SHA bump 2026-09-07 ~09:51 ICT (not current live): Pages `snote-g4-origin`
redeployed Pixel HIGH UX H1–H6 (#107) with git `9df65d53`. Canary-on SPA still
mounts `CutoverNotePage` (Phase A): plain `/<slug>` lazy-loads
`LegacyNotePage`; matching `#owner`/`#edit` still render `NotePage`; flag-off
builds keep `NotePage` with `legacyOnly={!canary}`. Phase C remains live on
this origin: RawView `/:slug.md` loads via LNO `open`; Home availability uses
LNO `exists` (no `char_count`; `exists: true` includes empty legacy rows and
is treated as taken). Home mint fail-closed idle remains live. Phase B Edge
`legacy-note-open` remains live (see §1b). This origin attest does not deploy
Edge.
`version.json` at that bump (browser UA; `no-store`) on both canonical and Pages
hosts, plus short Pages preview `https://f0c40427.snote-g4-origin.pages.dev`:
`deployedSha` `9df65d53b5ca38fbd48db4c9fe0fb57a950192f8`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T02:51:40.515Z`,
`buildId` `1788749485576-3fz1mz5u`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"22100da168056c000f1d0def32cb0a00"`.
Pages production deployment id `f0c40427` (short preview
`https://f0c40427.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `77d791af` / Pages `1fbf89fe`.
PWA smoke after that ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34077809435`, `headSha` `9df65d53…`).
That short preview still served historical `9df65d53` when re-checked
2026-09-07 ~04:25 UTC; it is not current live.

Same-canary origin SHA bump 2026-09-07 ~11:17 ICT (not current live): Pages `snote-g4-origin`
redeployed H2 opaque Mode/Export menus (#109) with git `9bf5e92b`. Canary-on
SPA still mounts `CutoverNotePage` (Phase A): plain `/<slug>` lazy-loads
`LegacyNotePage`; matching `#owner`/`#edit` still render `NotePage`; flag-off
builds keep `NotePage` with `legacyOnly={!canary}`. Phase C remains live on
this origin: RawView `/:slug.md` loads via LNO `open`; Home availability uses
LNO `exists` (no `char_count`; `exists: true` includes empty legacy rows and
is treated as taken). Home mint fail-closed idle remains live. Pixel HIGH UX
H1–H6 remains on this line. Phase B Edge `legacy-note-open` remains live
(see §1b). This origin attest does not deploy Edge.
`version.json` at that bump (browser UA; `no-store`) on both canonical
`https://note.syrin.online/version.json` and Pages
`https://snote-g4-origin.pages.dev/version.json`:
`deployedSha` `9bf5e92bf07cd82ff1775bc3d4a369b330de6a42`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T04:17:46.197Z`,
`buildId` `1788754651490-9xjsutgq`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on that response). Both hosts returned the same body and etag
`"ac63e32bbaf2471d09129469427409db"`.
Pages production deployment id was not independently observed from Atlas pins
or response headers (git-SHA and `main` Pages aliases 404); that bump pinned
the verified production alias `snote-g4-origin.pages.dev` plus canonical
`note.syrin.online`, not an invented UUID. Replaced previous live origin
`9df65d53` / Pages `f0c40427`.
PWA smoke after that ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34082660457`; `EXPECTED_DEPLOYED_SHA` `9bf5e92b…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed). GitHub
`headSha` for that dispatch was `b6824541` (#110 already on `main`); that was
checkout ref only at the H2 origin bump.

Same-canary origin SHA bump 2026-09-07 ~11:36 ICT (not current live): Pages `snote-g4-origin`
redeployed Ko-fi + New Version FAB (#110) with git `b6824541`. Canary-on SPA
still mounts `CutoverNotePage` (Phase A): plain `/<slug>` lazy-loads
`LegacyNotePage`; matching `#owner`/`#edit` still render `NotePage`; flag-off
builds keep `NotePage` with `legacyOnly={!canary}`. Phase C remains live on
this origin: RawView `/:slug.md` loads via LNO `open`; Home availability uses
LNO `exists` (no `char_count`; `exists: true` includes empty legacy rows and
is treated as taken). Home mint fail-closed idle remains live. Pixel HIGH UX
H1–H6 remains on this line. H2 opaque Mode/Export remains on this line.
Phase B Edge `legacy-note-open` remains live (see §1b). This origin attest
does not deploy Edge.
`version.json` at that bump (browser UA; `no-store`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://10bf76eb.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `b68245410d64aac8ac44c4f9a831e859a343cf00`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T04:36:02.465Z`,
`buildId` `1788755747017-oyr7urg1`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"88c32aa9e1feb672d1f059db9d6a33ca"`.
Pages production deployment id `10bf76eb` (short preview
`https://10bf76eb.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `9bf5e92b`. This attest pins the
independently verified short id, not an invented UUID.
PWA smoke after that ship is not PASS. `workflow_dispatch` run `34083747425`
(`EXPECTED_DEPLOYED_SHA` `b6824541…`, canary true) verified live release
identity then was cancelled. Replacement `workflow_dispatch` run
`34083766569` verified live release `b6824541…` `capabilityRoutesEnabled=true`
then Playwright 2 failed (strict mode: `getByText('New version available')`
resolved to 2 elements). That bump does not claim PWA smoke PASS.

Same-canary origin SHA bump 2026-09-07 ~12:28 ICT (not current live): Pages
`snote-g4-origin` redeployed PWA toast suppress when Ko-fi FAB handles update
(#113) with git `a8f7eeb8`. Canary-on SPA still mounts `CutoverNotePage`
(Phase A): plain `/<slug>` lazy-loads `LegacyNotePage`; matching `#owner`/`#edit`
still render `NotePage`; flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Phase C remains live on this origin: RawView
`/:slug.md` loads via LNO `open`; Home availability uses LNO `exists` (no
`char_count`; `exists: true` includes empty legacy rows and is treated as
taken). Home mint fail-closed idle remains live. Pixel HIGH UX H1–H6 remains
on this line. H2 opaque Mode/Export remains on this line. Ko-fi + New Version
FAB remains on this line. Phase B Edge `legacy-note-open` remains live (see
§1b). This origin attest does not deploy Edge.
`version.json` at that bump (browser UA; `no-store`; historical short preview
independently re-checked 2026-09-07 ~06:35 UTC / ~13:35 ICT) on
`https://bfb19758.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `a8f7eeb830b8440b899a6ccf0f8018f1a4fe8805`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T05:27:50.152Z`,
`buildId` `1788758854729-717yxima`.
That host returned `Cache-Control: no-cache, no-store, must-revalidate` (no
`CDN-Cache-Control` on that response) and etag `"434d4e14c59cc74bbd4c3dac0e73af8c"`.
Pages production deployment id `bfb19758` (short preview
`https://bfb19758.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `b6824541`. This attest pins the
independently verified short id, not an invented UUID.
That bump's origin attest did not claim PWA smoke PASS. That short preview
still served historical `a8f7eeb8` when re-checked 2026-09-07 ~06:35 UTC; it
is not current live.

Same-canary origin SHA bump 2026-09-07 ~13:31 ICT (not current live): Pages
`snote-g4-origin` redeployed FAB-primary + full PWA Sonner suppress while
Ko-fi FAB is mounted (#116; #113 remains on this line) with git `5c33ac24`.
Canary-on SPA still mounted `CutoverNotePage` (Phase A): plain `/<slug>`
lazy-loads `LegacyNotePage`; matching `#owner`/`#edit` still render
`NotePage`; flag-off builds keep `NotePage` with `legacyOnly={!canary}`.
Phase C remains live on this origin: RawView `/:slug.md` loads via LNO
`open`; Home availability uses LNO `exists` (no `char_count`; `exists: true`
includes empty legacy rows and is treated as taken). Home mint fail-closed
idle remains live. Pixel HIGH UX H1–H6 remains on this line. H2 opaque
Mode/Export remains on this line. Ko-fi + New Version FAB remains on this
line. #113 PWA toast suppress when Ko-fi FAB handles update remains on this
line. Phase B Edge `legacy-note-open` remains live (see §1b). This origin
attest does not deploy Edge.
`version.json` at that bump (browser UA; `no-store`; historical short
preview independently re-checked 2026-09-07 ~10:53 UTC / ~17:53 ICT) on
`https://6e6cdcc3.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `5c33ac241d6f6b4548ea290c299e15e4be799921`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T06:31:21.575Z`,
`buildId` `1788762666457-xzjqm3pq`.
That host returned `Cache-Control: no-cache, no-store, must-revalidate` (no
`CDN-Cache-Control` on that response) and etag `"d5edc17cf89dc508ed7a134bb2dfe78e"`.
Pages production deployment id `6e6cdcc3` (short preview
`https://6e6cdcc3.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `a8f7eeb8` / Pages `bfb19758` (last
merged origin attest was `b6824541` / `10bf76eb`). This attest pins the
independently verified short id, not an invented UUID.
PWA smoke after that ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34091257777`; `EXPECTED_DEPLOYED_SHA` `5c33ac24…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed). GitHub
`headSha` for that dispatch was `5c33ac241d6f6b4548ea290c299e15e4be799921`.
Identity verify logged `Verified live release 5c33ac241d6f6b4548ea290c299e15e4be799921 capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `5c33ac24` / Pages `6e6cdcc3`; PWA smoke `34091257777` PASS.
Pixel IDLE+UPDATE PASS (no Sonner on home). That short preview still served
historical `5c33ac24` when re-checked 2026-09-07 ~10:53 UTC; it is not
current live.

Same-canary origin SHA bump 2026-09-07 ~17:42 ICT (not current live): Pages
`snote-g4-origin` redeployed Choice A (#118) editable plain `/slug` under
canary-on with git `9dc0240e`. Canary stays on (`capabilityRoutesEnabled`
true; Home mint stays on). Choice A: plain `/<slug>` and SplitView panes
mount editable `NotePage` (not `CutoverNotePage` → `LegacyNotePage` default);
matching `#owner`/`#edit` still render `NotePage`; RawView `/:slug.md` is
unchanged (Phase C LNO `open`). Optional `?legacyRo=1` opt-in lazy-loads
`CutoverNotePage` → `LegacyNotePage` (Phase B LNO read-only). Duplicate
securely is hidden with honest unavailable copy (`legacy.duplicate_unavailable`;
SQL 240 import-legacy is absent). Flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Phase C remains live on this origin: RawView
`/:slug.md` loads via LNO `open`; Home availability uses LNO `exists` (no
`char_count`; `exists: true` includes empty legacy rows and is treated as
taken). Home mint fail-closed idle remains live. Pixel HIGH UX H1–H6 remains
on this line. H2 opaque Mode/Export remains on this line. Ko-fi + New Version
FAB remains on this line. FAB-primary + Sonner suppress (#113/#116) remains
on this line. Phase B Edge `legacy-note-open` remains live (see §1b). This
origin attest does not deploy Edge.
`version.json` at that bump (browser UA; `no-store`; historical short
preview independently re-checked 2026-09-07 ~12:00 UTC / ~19:00 ICT) on
`https://304342e0.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `9dc0240e7d714d548711623f94a50c42dac64475`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T10:42:45.177Z`,
`buildId` `1788777750020-948pzpfj`.
That host returned `Cache-Control: no-cache, no-store, must-revalidate` (no
`CDN-Cache-Control` on that response) and etag `"bb56bbbc6570ef11504c4d493893f218"`.
Pages production deployment id `304342e0` (short preview
`https://304342e0.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `5c33ac24` / Pages `6e6cdcc3` (last
merged origin attest was `5c33ac24` / `6e6cdcc3` in #117). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse/Pixel/Sentinel pin at that bump: live `note.syrin.online`, SHA
`9dc0240e`, Pages `304342e0`, buildId `1788777750020-948pzpfj`, canary on.
Pixel visual PASS: `/hage` editable + Duplicate hidden. Sentinel product
READY WITH KNOWN RISKS.
PWA smoke after that ship is not PASS. `workflow_dispatch` run `34112928744`
(`EXPECTED_DEPLOYED_SHA` `9dc0240e…`, `EXPECTED_CAPABILITY_ROUTES_ENABLED`
true) identity verify PASS: `Verified live release 9dc0240e7d714d548711623f94a50c42dac64475 capabilityRoutesEnabled=true`.
Playwright 1 passed, 1 failed: `e2e/pwa-update-multi-click.spec.ts`
`hardReloadCount` 2≠1 (known flake tracked separately).
That bump does not claim full PWA smoke PASS.
That short preview still served historical `9dc0240e` when re-checked
2026-09-07 ~12:00 UTC / ~19:00 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-07 ~18:56 ICT (not current live): Pages `snote-g4-origin`
redeployed PWA latch (#119) one hard-reload per Update apply, with prior
Choice A (#118) still on this line, git `15ec8285` (merge of docs attest
#120 on top of #119). Canary stays on (`capabilityRoutesEnabled` true;
Home mint stays on). Choice A remains live: plain `/<slug>` and SplitView
panes mount editable `NotePage` (not `CutoverNotePage` → `LegacyNotePage`
default); matching `#owner`/`#edit` still render `NotePage`; RawView
`/:slug.md` is unchanged (Phase C LNO `open`). Optional `?legacyRo=1`
opt-in lazy-loads `CutoverNotePage` → `LegacyNotePage` (Phase B LNO
read-only). Duplicate securely is hidden with honest unavailable copy
(`legacy.duplicate_unavailable`; SQL 240 import-legacy is absent).
Flag-off builds keep `NotePage` with `legacyOnly={!canary}`. PWA latch
(#119): one hard-reload per Update apply (consume one hard-reload per
target per updater generation; a later different `version.json` buildId
can still apply). Phase C remains live on this origin: RawView
`/:slug.md` loads via LNO `open`; Home availability uses LNO `exists` (no
`char_count`; `exists: true` includes empty legacy rows and is treated as
taken). Home mint fail-closed idle remains live. Pixel HIGH UX H1–H6 remains
on this line. H2 opaque Mode/Export remains on this line. Ko-fi + New Version
FAB remains on this line. FAB-primary + Sonner suppress (#113/#116) remains
on this line. Choice A (#118) remains on this line. Phase B Edge
`legacy-note-open` remains live (see §1b). This origin attest does not
deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-07 ~12:00 UTC / ~19:00 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://5367a813.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-07T11:56:22.424Z`,
`buildId` `1788782168827-zcsaepnh`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"0300ab59e05a2be8c14a3f6bdadb6a75"`.
Pages production deployment id `5367a813` (short preview
`https://5367a813.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `9dc0240e` / Pages `304342e0` (last
merged origin attest was `9dc0240e` / `304342e0` in #120). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse pin matches this independent fetch: live `note.syrin.online`,
SHA `15ec8285`, Pages `5367a813`, buildId `1788782168827-zcsaepnh`, canary
on. Pixel visual latch PASS on `15ec8285`: `/hage` editable; FAB Update = 1 reload; evidence `latch-15ec8285/`. Duplicate hidden remains on this Choice A
line.
PWA smoke after that ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34119265815`; `EXPECTED_DEPLOYED_SHA` `15ec8285…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7`.
Identity verify logged `Verified live release 15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7 capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `15ec8285` / Pages `5367a813`; PWA smoke
`34119265815` PASS. PWA latch #119 live (one hard-reload per Update apply).
Choice A still live.
Sentinel pin: live `15ec8285` / Pages `5367a813` khớp; smoke `34119265815`
PASS (2/2); multi-click residual cleared; 240 HOLD.
That short preview still served historical `15ec8285` when re-checked
2026-09-08 ~05:33 UTC / ~12:33 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-08 ~10:24 ICT (not current live): Pages
`snote-g4-origin` redeployed Pixel Legacy opt-in in the Note security panel
(#122; Choice A follow-up) with git `0073d53b`. Canary stays on
(`capabilityRoutesEnabled` true; Home mint stays on). Choice A remains live:
plain `/<slug>` and SplitView panes mount editable `NotePage` (not
`CutoverNotePage` → `LegacyNotePage` default); matching `#owner`/`#edit`
still render `NotePage`; RawView `/:slug.md` is unchanged (Phase C LNO
`open`). Optional `?legacyRo=1` opt-in remains, and #122 adds in-panel
Legacy format under Advanced without making Legacy RO the default.
Duplicate securely is hidden with honest unavailable copy. Flag-off builds
keep `NotePage` with `legacyOnly={!canary}`. PWA latch (#119) remains on this
line. Phase C remains live on this origin. Pixel HIGH UX H1–H6 remains on
this line. H2 opaque Mode/Export remains on this line. Ko-fi + New Version
FAB remains on this line. FAB-primary + Sonner suppress (#113/#116) remains
on this line. Choice A (#118) remains on this line. Phase B Edge
`legacy-note-open` remains live (see §1b). This origin attest does not
deploy Edge.
`version.json` at that bump (browser UA; `no-store`; historical short
preview independently re-checked 2026-09-08 ~05:33 UTC / ~12:33 ICT) on
`https://fbef2d53.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `0073d53bb2524882eda0c36528f0c25a94346a65`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-08T03:24:01.879Z`,
`buildId` `1788837826262-e3tdqmc3`.
That host returned `Cache-Control: no-cache, no-store, must-revalidate` (no
`CDN-Cache-Control` on that response) and etag `"50f5c8e5194530d1dc946602f65e54c9"`.
Pages production deployment id `fbef2d53` (short preview
`https://fbef2d53.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaced previous live origin `15ec8285` / Pages `5367a813` (last
merged origin attest was `15ec8285` / `5367a813` in #121). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse prior live pin at that bump: `0073d53b` / Pages `fbef2d53`
(Legacy panel #122). That short preview still served historical `0073d53b`
when re-checked 2026-09-08 ~05:33 UTC / ~12:33 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-08 ~12:23 ICT (not current live): Pages `snote-g4-origin`
redeployed Encrypt primary disabled+honest on Choice A plain `/slug` (#123),
with prior Pixel Legacy opt-in (#122) still on this line, git `1e76e2b7`.
Canary stays on (`capabilityRoutesEnabled` true; Home mint stays on).
Choice A remains live: plain `/<slug>` and SplitView panes mount editable
`NotePage` (not `CutoverNotePage` → `LegacyNotePage` default); matching
`#owner`/`#edit` still render `NotePage`; RawView `/:slug.md` is unchanged
(Phase C LNO `open`). Optional `?legacyRo=1` opt-in and in-panel Legacy
(#122) remain. Duplicate securely is hidden with honest unavailable copy
(`legacy.duplicate_unavailable`; SQL 240 import-legacy is absent).
Flag-off builds keep `NotePage` with `legacyOnly={!canary}`. Encrypt (#123):
on Choice A plain `/slug` (no `#owner`/`#edit`), Encrypt is shown primary and
disabled with honest `security.encrypt_helper_unavailable` copy;
`allowEncryptionTransitions` / `legacyContainment` are not flipped (gate not opened).
On `#owner=` Encrypt stays interactive. PWA latch (#119): one hard-reload
per Update apply (consume one hard-reload per target per updater generation;
a later different `version.json` buildId can still apply). Phase C remains
live on this origin: RawView `/:slug.md` loads via LNO `open`; Home
availability uses LNO `exists` (no `char_count`; `exists: true` includes
empty legacy rows and is treated as taken). Home mint fail-closed idle
remains live. Pixel HIGH UX H1–H6 remains on this line. H2 opaque
Mode/Export remains on this line. Ko-fi + New Version FAB remains on this
line. FAB-primary + Sonner suppress (#113/#116) remains on this line.
Choice A (#118) remains on this line. #119 remains on this line. #122 remains
on this line. Phase B Edge `legacy-note-open` remains live (see §1b). This
origin attest does not deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-08 ~05:33 UTC / ~12:33 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://49c127f4.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-08T05:23:21.266Z`,
`buildId` `1788844987021-wi4mma7n`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"cf9426243c2a5341809ef73aedd75a12"`.
Pages production deployment id `49c127f4` (short preview
`https://49c127f4.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaces previous live origin `0073d53b` / Pages `fbef2d53` (last
merged origin attest was `15ec8285` / `5367a813` in #121). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse pin matches this independent fetch: live `note.syrin.online`,
SHA `1e76e2b7`, Pages `49c127f4`, buildId `1788844987021-wi4mma7n`, canary
on. Pixel visual Encrypt disabled+honest on plain `/hage` PASS (evidence `encrypt-disabled-1e76e2b7/`). Duplicate hidden remains on this Choice A
line.
PWA smoke after this ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34190597619`; `EXPECTED_DEPLOYED_SHA` `1e76e2b7…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d`.
Identity verify logged `Verified live release 1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `1e76e2b7` / Pages `49c127f4`; PWA smoke
`34190597619` PASS. Encrypt disabled+honest #123 live. Pixel Legacy opt-in
#122 still live. PWA latch #119 still live. Choice A still live.
Sentinel pin: READY WITH KNOWN RISKS on live `1e76e2b7` / Pages `49c127f4`
(Encrypt primary disabled + honest copy; gate not opened).
That short preview still served historical `1e76e2b7` when re-checked
2026-09-08 ~09:58 UTC / ~16:58 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-08 ~16:34 ICT (not current live): Pages `snote-g4-origin`
redeployed A′ Cutover restore (#126) so canary-on plain `/slug` and SplitView
panes mount `CutoverNotePage` → `LegacyNotePage` (LNO RO), git `b4eba5d2`.
Canary stays on (`capabilityRoutesEnabled` true; Home mint stays on).
A′ live: plain `/<slug>` and SplitView panes are Cutover/LNO RO (Choice A
#118 editable-plain default is **superseded**); matching `#owner`/`#edit`
still render `NotePage`; RawView `/:slug.md` is unchanged (Phase C LNO
`open`). Optional `?legacyRo=1` still RO + banner. Duplicate securely is
hidden with honest unavailable copy (`legacy.duplicate_unavailable`; SQL 240
import-legacy is absent). Flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Encrypt omit on plain Legacy RO; `#owner=` Encrypt
stays active (encryption gate not opened on the plain table path). PWA latch
(#119): one hard-reload per Update apply (consume one hard-reload per target
per updater generation; a later different `version.json` buildId can still
apply). Phase C remains live on this origin: RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists` (no `char_count`;
`exists: true` includes empty legacy rows and is treated as taken). Home mint
fail-closed idle remains live. Pixel HIGH UX H1–H6 remains on this line. H2
opaque Mode/Export remains on this line. Ko-fi + New Version FAB remains on
this line. FAB-primary + Sonner suppress (#113/#116) remains on this line.
#118 remains on this line as superseded routing. #119 remains on this line.
#122 remains on this line. #123 remains on this line as `#owner=` Encrypt.
Phase B Edge `legacy-note-open` remains live (see §1b). This origin attest
does not deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-08 ~09:58 UTC / ~16:58 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://07cb774d.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `b4eba5d29cb8057c534c13588140bbe5ffa4f19e`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-08T09:34:08.672Z`,
`buildId` `1788860033092-xa1nnac8`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"e4513a962f72c21b2208e6272466fa65"`.
Pages production deployment id `07cb774d` (short preview
`https://07cb774d.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaces previous live origin `1e76e2b7` / Pages `49c127f4` (last
merged origin attest was `1e76e2b7` / `49c127f4` in #124). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse/Pixel/Sentinel pin matches this independent fetch: live
`note.syrin.online`, SHA `b4eba5d2`, Pages `07cb774d`, buildId
`1788860033092-xa1nnac8`, canary on. Pixel visual A′ PASS (plain `/hage`
Legacy RO + banner + CTA Home; Encrypt omit; Duplicate hidden; mint
`#owner=` editable; evidence `pixel-qa/a-prime-b4eba5d2/`). Duplicate hidden
remains on this A′ line.
PWA smoke after this ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34211082005`; `EXPECTED_DEPLOYED_SHA` `b4eba5d2…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `b4eba5d29cb8057c534c13588140bbe5ffa4f19e`.
Identity verify logged `Verified live release b4eba5d29cb8057c534c13588140bbe5ffa4f19e capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `b4eba5d2` / Pages `07cb774d`; PWA smoke
`34211082005` PASS. A′ Cutover restore #126 live. Encrypt omit on plain RO.
Pixel Legacy opt-in #122 still live. PWA latch #119 still live. Choice A
editable-plain is superseded.
Sentinel pin: READY WITH KNOWN RISKS on live `b4eba5d2` / Pages `07cb774d`
(LOW non-blocking: transient dynamic-import on first `?legacyRo=1`, update
reminder, SplitView not smoked).
Walls HOLD: SQL 240 / Worker / Realtime / `writes_enabled`.

Kill switch unchanged: `writes_enabled=true`,
`private_realtime_enabled=false`, `updated_at`
`2026-09-02 04:24:07.235188+00` (see §3d). SQL 240 still not applied
(`capability_note_import_legacy` is absent).
POST `/functions/v1/legacy-note-open` `{}` 400 `{"error":"invalid request"}`.
POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`.
At the 27da93eb origin bump, Worker `syrin-prerender` was still `9fcc58bc` /
`b4d1a94e`. Later Worker redeploy 2026-09-03 ~20:42 UTC / 2026-09-04
~03:42 ICT set live Worker to `931430c0` / `5f94ab6c` (see §1c).
At that Worker deploy, Origin SPA was not redeployed (then `27da93eb`).
This origin bump does not redeploy the Worker; live Worker remains
`931430c0` / `5f94ab6c`. SQL 240 / Worker / Realtime not changed. Canary remains on.

This is A′ (#126) canary-on Cutover Legacy RO for plain `/slug` plus
optional `?legacyRo=1` still RO + banner plus Phase C RawView+Home via LNO
plus Pixel HIGH UX H1–H6 plus H2 opaque Mode/Export plus Ko-fi + New Version
FAB plus FAB-primary + Sonner suppress (#113/#116) plus PWA latch (#119)
one hard-reload per Update apply plus Pixel Legacy opt-in (#122) plus
Encrypt omit on plain RO (`#owner=` Encrypt stays active):
plain slug and SplitView panes are `CutoverNotePage` → `LegacyNotePage`
(LNO RO); `#owner`/`#edit` may open capability polling. RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists`. Duplicate securely is
hidden with honest unavailable copy. Home mints capabilities when
canary is on (create → `/<slug>#owner=`; fail-closed on idle). Phase C is
still on this origin. H1–H6 is still on this line. H2 is still on this line.
Ko-fi FAB / New Version remains on this line. #113 is still on this line.
#116 is still on this line. #118 is superseded on this line. #119 is still on
this line. #122 is still on this line. #123 `#owner=` Encrypt is still on
this line. #126 is still on this line. FAB is
the primary update UX; Sonner is suppressed while Ko-fi FAB is mounted;
Update apply consumes one hard-reload per target. Encrypt is omitted on
plain Legacy RO; `#owner=` Encrypt stays active; the encryption gate is
not opened on the plain table path.
Pixel visual A′ PASS (plain `/hage` Legacy RO + banner + CTA Home; Encrypt
omit; Duplicate hidden; mint `#owner=` editable; evidence
`pixel-qa/a-prime-b4eba5d2/`). Sentinel pin: READY WITH KNOWN RISKS on live
`b4eba5d2` / Pages `07cb774d` (LOW non-blocking: transient dynamic-import on
first `?legacyRo=1`, update reminder, SplitView not smoked).
This is not SQL 240, not Realtime, not soak-complete.
Soak ≥48h started ~12:01 ICT from the first canary origin `c5914c8e`;
this bump does not restart soak. This is a same-canary origin SHA bump,
not soak-complete, not 240. Origin attest only.
That short preview still served historical `b4eba5d2` when re-checked
2026-09-08 ~16:58 UTC / ~23:58 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-08 ~23:28 ICT (not current live): Pages `snote-g4-origin`
redeployed Duplicate securely (#128) via Edge `note-session` `import-legacy`,
with prior A′ Cutover restore (#126) still on this line, git `f84183ba`.
Canary stays on (`capabilityRoutesEnabled` true; Home mint stays on).
A′ remains live: plain `/<slug>` and SplitView panes are Cutover/LNO RO (Choice A
#118 editable-plain default is **superseded**); matching `#owner`/`#edit`
still render `NotePage`; RawView `/:slug.md` is unchanged (Phase C LNO
`open`). Optional `?legacyRo=1` still RO + banner. Duplicate securely is enabled (PR #128; Edge `note-session` `import-legacy`;
`DUPLICATE_SECURELY_AVAILABLE = true`). Flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Encrypt omit on plain Legacy RO; `#owner=` Encrypt
stays active (encryption gate not opened on the plain table path). PWA latch
(#119): one hard-reload per Update apply (consume one hard-reload per target
per updater generation; a later different `version.json` buildId can still
apply). Phase C remains live on this origin: RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists` (no `char_count`;
`exists: true` includes empty legacy rows and is treated as taken). Home mint
fail-closed idle remains live. Pixel HIGH UX H1–H6 remains on this line. H2
opaque Mode/Export remains on this line. Ko-fi + New Version FAB remains on
this line. FAB-primary + Sonner suppress (#113/#116) remains on this line.
#118 remains on this line as superseded routing. #119 remains on this line.
#122 remains on this line. #123 remains on this line as `#owner=` Encrypt.
#126 remains on this line. #128 is live on this line.
Phase B Edge `legacy-note-open` remains live (see §1b). This origin attest
does not deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-08 ~16:58 UTC / ~23:58 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://74637d87.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `f84183ba32d4057a4012424766a4ee53577528a4`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-08T16:28:58.668Z`,
`buildId` `1788884922635-dbv60j3l`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"981b13ea1b56f6022d8f8a01f41838e8"`.
Pages production deployment id `74637d87` (short preview
`https://74637d87.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaces previous live origin `b4eba5d2` / Pages `07cb774d` (last
merged origin attest was `b4eba5d2` / `07cb774d` in #127). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse pin matches this independent fetch: live
`note.syrin.online`, SHA `f84183ba`, Pages `74637d87`, buildId
`1788884922635-dbv60j3l`, canary on. Duplicate securely enabled (#128).
A′ plain RO remains the default. Pixel visual A′ PASS remains the A′ routing
evidence (plain `/hage` Legacy RO + banner + CTA Home; Encrypt omit; mint
`#owner=` editable; evidence `pixel-qa/a-prime-b4eba5d2/`).
PWA smoke after this ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34251814023`; `EXPECTED_DEPLOYED_SHA` `f84183ba…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `f84183ba32d4057a4012424766a4ee53577528a4`.
Identity verify logged `Verified live release f84183ba32d4057a4012424766a4ee53577528a4 capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `f84183ba` / Pages `74637d87`; PWA smoke
`34251814023` PASS. Duplicate securely #128 live. A′ Cutover restore #126 still live.
Encrypt omit on plain RO. Pixel Legacy opt-in #122 still live. PWA latch #119 still live. Choice A
editable-plain is superseded.
Sentinel pin: READY WITH KNOWN RISKS on live `f84183ba` / Pages `74637d87`
(LOW: fail-path not smoke-tested live). Pixel PASS.
Walls HOLD: Worker / Realtime / `writes_enabled`. SQL 240 already applied.

Kill switch unchanged: `writes_enabled=true`,
`private_realtime_enabled=false`, `updated_at`
`2026-09-02 04:24:07.235188+00` (see §3d). SQL 240 already applied
(`capability_note_import_legacy` present).
POST `/functions/v1/legacy-note-open` `{}` 400 `{"error":"invalid request"}`.
POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`.
At the 27da93eb origin bump, Worker `syrin-prerender` was still `9fcc58bc` /
`b4d1a94e`. Later Worker redeploy 2026-09-03 ~20:42 UTC / 2026-09-04
~03:42 ICT set live Worker to `931430c0` / `5f94ab6c` (see §1c).
At that Worker deploy, Origin SPA was not redeployed (then `27da93eb`).
This origin bump does not redeploy the Worker; live Worker remains
`931430c0` / `5f94ab6c`. Worker / Realtime not changed. Canary remains on.

This is A′ (#126) canary-on Cutover Legacy RO for plain `/slug` plus
Duplicate securely (#128) plus
optional `?legacyRo=1` still RO + banner plus Phase C RawView+Home via LNO
plus Pixel HIGH UX H1–H6 plus H2 opaque Mode/Export plus Ko-fi + New Version
FAB plus FAB-primary + Sonner suppress (#113/#116) plus PWA latch (#119)
one hard-reload per Update apply plus Pixel Legacy opt-in (#122) plus
Encrypt omit on plain RO (`#owner=` Encrypt stays active):
plain slug and SplitView panes are `CutoverNotePage` → `LegacyNotePage`
(LNO RO); `#owner`/`#edit` may open capability polling. RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists`. Duplicate securely is enabled (PR #128; Edge `note-session` `import-legacy`). Home mints capabilities when
canary is on (create → `/<slug>#owner=`; fail-closed on idle). Phase C is
still on this origin. H1–H6 is still on this line. H2 is still on this line.
Ko-fi FAB / New Version remains on this line. #113 is still on this line.
#116 is still on this line. #118 is superseded on this line. #119 is still on
this line. #122 is still on this line. #123 `#owner=` Encrypt is still on
this line. #126 is still on this line. #128 is still on this line. FAB is
the primary update UX; Sonner is suppressed while Ko-fi FAB is mounted;
Update apply consumes one hard-reload per target. Encrypt is omitted on
plain Legacy RO; `#owner=` Encrypt stays active; the encryption gate is
not opened on the plain table path.
Pixel visual A′ PASS (plain `/hage` Legacy RO + banner + CTA Home; Encrypt
omit; mint `#owner=` editable; evidence
`pixel-qa/a-prime-b4eba5d2/`). Pixel PASS. Sentinel pin: READY WITH KNOWN RISKS
on live `f84183ba` / Pages `74637d87` (LOW: fail-path not smoke-tested live).
This is not SQL 240, not Realtime, not soak-complete.
Soak ≥48h started ~12:01 ICT from the first canary origin `c5914c8e`;
this bump does not restart soak. This is a same-canary origin SHA bump,
not soak-complete. Origin attest only.
That short preview still served historical `f84183ba` when re-checked
2026-09-09 ~03:27 UTC / ~10:27 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-09 ~10:22 ICT (not current live): Pages `snote-g4-origin`
redeployed W1 convert-on-write (#130 U1 SPA lineage) plus lint/lockfile #131,
git `2ae9a230`. Canary stays on (`capabilityRoutesEnabled` true; Home mint
stays on).
W1 is live: plain `/<slug>` and SplitView panes are `CutoverNotePage` →
editable `NotePage` (no A′ RO banner). A′ (#126) Cutover/LNO RO default is
**superseded**; Choice A (#118) editable-plain table path remains
**superseded**. Matching `#owner`/`#edit` still render `NotePage`; RawView
`/:slug.md` is unchanged (Phase C LNO `open`). Optional `?legacyRo=1` still
RO + banner. First persist on existing legacy calls `note-session`
`convert-legacy` (same slug) then soft-replaces to `#owner=` with
`convert_success` toast; empty notes mint via live `create`. U1 SQL
`capability_note_convert_legacy` is **applied** live. Edge `convert-legacy` is
**published** (Pulse `umsg_01m21zhm…`). Duplicate securely is enabled on Legacy RO
only (PR #128; Edge `note-session` `import-legacy`;
`DUPLICATE_SECURELY_AVAILABLE = true`). Flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Encrypt + Legacy Advanced remain opt-in on the owner
path; Encrypt disabled+honest on plain pre-convert; `#owner=` Encrypt stays
active (encryption gate not opened on the plain table path). PWA latch
(#119): one hard-reload per Update apply (consume one hard-reload per target
per updater generation; a later different `version.json` buildId can still
apply). Phase C remains live on this origin: RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists` (no `char_count`;
`exists: true` includes empty legacy rows and is treated as taken). Home mint
fail-closed idle remains live. Pixel HIGH UX H1–H6 remains on this line. H2
opaque Mode/Export remains on this line. Ko-fi + New Version FAB remains on
this line. FAB-primary + Sonner suppress (#113/#116) remains on this line.
#118 remains on this line as superseded routing. #119 remains on this line.
#122 remains on this line. #123 remains on this line as `#owner=` Encrypt.
#126 remains on this line as superseded A′ default. #128 remains on Legacy
RO. #130 and #131 are live on this line.
Phase B Edge `legacy-note-open` remains live (see §1b). This origin attest
does not deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-09 ~03:27 UTC / ~10:27 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://fb35474a.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `2ae9a23084dbdddec5aeffb9dd9aff191602b4b8`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-09T03:22:42.753Z`,
`buildId` `1788924147004-wx705xxn`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"fc5e9588c9d1eefcb11aba320b9aa291"`.
Pages production deployment id `fb35474a` (short preview
`https://fb35474a.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaces previous live origin `f84183ba` / Pages `74637d87` (last
merged origin attest was `f84183ba` / `74637d87` in #129). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse pin matches this independent fetch: live
`note.syrin.online`, SHA `2ae9a230`, Pages `fb35474a`, buildId
`1788924147004-wx705xxn`, canary on. W1 convert-on-write live (#130).
A′ plain RO is no longer the default. Pixel Live UX W1 PASS on live
`2ae9a230` / Pages `fb35474a` (hard-reload after A′ SW/cache false RO; plain
`/hage` editable modern no RO banner; panel Legacy OFF + Encrypt
disabled+honest + Duplicate hidden; convert busy «Saving securely…» →
soft-replace `#owner=` + Synced; evidence `pixel-qa/w1-2ae9a230/`). Pixel
MEDIUM residual (not BLOCKER): `?legacyRo=1` on `/hage` after convert →
«This legacy note does not exist» + Duplicate absent (expected U1 after row
flip); leftover unconverted smoke still needed; empty legacyRo helper still
A′ «table note» copy (POLISH/MEDIUM). Sentinel pin: READY WITH KNOWN RISKS
on live `2ae9a230` / Pages `fb35474a` (BLOCKER none; first-persist OK;
evidence `sentinel-qa-w1-live/`). PASSED: pin+canary; anon notes 42501;
empty → `#owner=` (after SW clear); `/hage` editable no RO; Pixel first
convert → LNO exists:false; `#owner=` Encrypt OK / Duplicate hidden; no
`from("notes")` write. HIGH residual: plain reopen of a converted slug does
NOT go `#owner=` → note-session `create` → 409 `slug_unavailable` (does not
call convert-legacy) → Sync error (bookmark residual; needs follow-up
recovery / «open secure link»). MEDIUM: `?legacyRo=1` post-convert «does not
exist»/no Duplicate = expected; SW A′ false RO until hard-reload. Historical A′ Pixel PASS remains `pixel-qa/a-prime-b4eba5d2/`.
PWA smoke after this ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34306921753`; `EXPECTED_DEPLOYED_SHA` `2ae9a230…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `2ae9a23084dbdddec5aeffb9dd9aff191602b4b8`.
Identity verify logged `Verified live release 2ae9a23084dbdddec5aeffb9dd9aff191602b4b8 capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `2ae9a230` / Pages `fb35474a`; PWA smoke
`34306921753` PASS. W1 convert-on-write #130 live. Duplicate securely #128
remains on Legacy RO. A′ Cutover restore #126 superseded as default.
Encrypt disabled+honest on plain pre-convert. Pixel Legacy opt-in #122 still
live as Legacy Advanced. PWA latch #119 still live. Choice A editable-plain
is superseded. U1 SQL `capability_note_convert_legacy` applied live; Edge
`convert-legacy` published (Pulse `umsg_01m21zhm…`).
Walls HOLD: Worker / Realtime / `writes_enabled`. SQL 240 already applied.

Kill switch unchanged: `writes_enabled=true`,
`private_realtime_enabled=false`, `updated_at`
`2026-09-02 04:24:07.235188+00` (see §3d). SQL 240 already applied
(`capability_note_import_legacy` present).
POST `/functions/v1/legacy-note-open` `{}` 400 `{"error":"invalid request"}`.
POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`.
At the 27da93eb origin bump, Worker `syrin-prerender` was still `9fcc58bc` /
`b4d1a94e`. Later Worker redeploy 2026-09-03 ~20:42 UTC / 2026-09-04
~03:42 ICT set live Worker to `931430c0` / `5f94ab6c` (see §1c).
At that Worker deploy, Origin SPA was not redeployed (then `27da93eb`).
This origin bump does not redeploy the Worker; live Worker remains
`931430c0` / `5f94ab6c`. Worker / Realtime not changed. Canary remains on.

This is W1 (#130) canary-on convert-on-write for plain `/slug` plus
Duplicate securely (#128) on Legacy RO only plus
optional `?legacyRo=1` still RO + banner plus Phase C RawView+Home via LNO
plus Pixel HIGH UX H1–H6 plus H2 opaque Mode/Export plus Ko-fi + New Version
FAB plus FAB-primary + Sonner suppress (#113/#116) plus PWA latch (#119)
one hard-reload per Update apply plus Pixel Legacy opt-in (#122) plus
Encrypt disabled+honest on plain pre-convert (`#owner=` Encrypt stays active):
plain slug and SplitView panes are `CutoverNotePage` → editable `NotePage`;
`#owner`/`#edit` may open capability polling. RawView `/:slug.md` loads via
LNO `open`; Home availability uses LNO `exists`. Duplicate securely is enabled on Legacy RO only (PR #128; Edge `note-session` `import-legacy`). Home mints capabilities when
canary is on (create → `/<slug>#owner=`; fail-closed on idle). Phase C is
still on this origin. H1–H6 is still on this line. H2 is still on this line.
Ko-fi FAB / New Version remains on this line. #113 is still on this line.
#116 is still on this line. #118 is superseded on this line. #119 is still on
this line. #122 is still on this line. #123 `#owner=` Encrypt is still on
this line. #126 is superseded as default on this line. #128 is still on
Legacy RO. #130 is still on this line. #131 is still on this line. FAB is
the primary update UX; Sonner is suppressed while Ko-fi FAB is mounted;
Update apply consumes one hard-reload per target. Encrypt is disabled+honest
on plain pre-convert; `#owner=` Encrypt stays active; the encryption gate is
not opened on the plain table path.
Pixel Live UX W1 PASS on live `2ae9a230` / Pages `fb35474a` (hard-reload after
A′ SW/cache false RO; plain `/hage` editable modern no RO banner; panel
Legacy OFF + Encrypt disabled+honest + Duplicate hidden; convert busy
«Saving securely…» → soft-replace `#owner=` + Synced; evidence
`pixel-qa/w1-2ae9a230/`). Pixel MEDIUM residual (not BLOCKER): `?legacyRo=1`
on `/hage` after convert → «This legacy note does not exist» + Duplicate
absent (expected U1 after row flip); leftover unconverted smoke still
needed; empty legacyRo helper still A′ «table note» copy (POLISH/MEDIUM).
Sentinel pin: READY WITH KNOWN RISKS on live `2ae9a230` / Pages `fb35474a`
(BLOCKER none; first-persist OK; evidence `sentinel-qa-w1-live/`). PASSED:
pin+canary; anon notes 42501; empty → `#owner=` (after SW clear); `/hage`
editable no RO; Pixel first convert → LNO exists:false; `#owner=` Encrypt OK
/ Duplicate hidden; no `from("notes")` write. HIGH residual: plain reopen of
a converted slug does NOT go `#owner=` → note-session `create` → 409
`slug_unavailable` (does not call convert-legacy) → Sync error (bookmark
residual; needs follow-up recovery / «open secure link»). MEDIUM: SW A′
false RO until hard-reload.
This is not SQL 240, not Realtime, not soak-complete.
Soak ≥48h started ~12:01 ICT from the first canary origin `c5914c8e`;
this bump does not restart soak. This is a same-canary origin SHA bump,
not soak-complete. Origin attest only.
That short preview still served historical `2ae9a230` when re-checked
2026-09-15 ~15:20 UTC / ~22:20 ICT; it is not current live.

Same-canary origin SHA bump 2026-09-15 ~22:05 ICT: Pages `snote-g4-origin`
redeployed W2 free-edit + Legacy opt-in (#135) plus Legacy ON handoff (#137)
plus A3 bare-after-ON RO (#138) plus lint/types (#139), git `0cdcdc0f`.
Canary stays on (`capabilityRoutesEnabled` true; Home mint stays on).
W2 is live: plain `/<slug>` and SplitView panes are `CutoverNotePage` →
editable `NotePage` (free-edit; no forced convert; no `#owner=` required to
edit). W1 convert-on-write as product default is **superseded**; A′ (#126)
Cutover/LNO RO default remains **superseded**; Choice A (#118) editable-plain
table path remains **superseded**. Matching `#owner`/`#edit` still render
`NotePage`; RawView `/:slug.md` is unchanged (Phase C LNO `open`). Optional
`?legacyRo=1` still RO + banner. Plain persist uses Edge `plain-upsert`.
Legacy ON (owner only) calls `note-session` `convert-legacy` from the current
Y.Doc then soft-replaces to `#owner=` with Pixel success toast «Đã bật
Legacy. Giữ link owner để đặt sau.»; Encrypt becomes available; server
managed so `plain-upsert` returns HTTP 409 `capability_managed`. After Legacy
ON, bare `/{slug}` (same tab or new tab) is read-only need-owner / Legacy-on
banner + Home CTA (AC A3; localStorage pin and/or LNO `managed:true` so
free-edit is not mounted). Legacy OFF (owner `#owner=` only) calls
`disable-secure`, soft-replaces to bare free-edit with toast «Đã tắt Legacy.
Ai có link cũng sửa được.»; `plain-upsert` returns 200 unmanaged again.
SQL `capability_note_plain_upsert` and `capability_note_disable_secure` are
**applied** live. U1 SQL `capability_note_convert_legacy` remains
**applied** live. Edge `note-session` `plain-upsert`, `disable-secure`, and
`convert-legacy` are **published** (`convert-legacy` Pulse
`umsg_01m21zhm…`). Edge `legacy-note-open` is republished with
`managed:true` for managed slugs. Duplicate securely is enabled on Legacy RO
only (PR #128; Edge `note-session` `import-legacy`;
`DUPLICATE_SECURELY_AVAILABLE = true`). Flag-off builds keep `NotePage` with
`legacyOnly={!canary}`. Encrypt is disabled on free-edit (Legacy OFF) and
becomes available after Legacy ON on the owner path; `#owner=` Encrypt stays
active. PWA latch (#119): one hard-reload per Update apply (consume one
hard-reload per target per updater generation; a later different
`version.json` buildId can still apply). Phase C remains live on this
origin: RawView `/:slug.md` loads via LNO `open`; Home availability uses LNO
`exists` (no `char_count`; `exists: true` includes empty legacy rows and is
treated as taken). Home mint fail-closed idle remains live. Pixel HIGH UX
H1–H6 remains on this line. H2 opaque Mode/Export remains on this line.
Ko-fi + New Version FAB remains on this line. FAB-primary + Sonner suppress
(#113/#116) remains on this line. #118 remains on this line as superseded
routing. #119 remains on this line. #122 remains on this line. #123 remains
on this line as `#owner=` Encrypt. #126 remains on this line as superseded
A′ default. #128 remains on Legacy RO. #130 and #131 remain as superseded W1
default. #135, #137, #138, and #139 are live on this line.
Phase B Edge `legacy-note-open` remains live (see §1b). This origin attest
does not deploy Edge.
Live `version.json` (browser UA; `no-store`; independently fetched
2026-09-15 ~15:20 UTC / ~22:20 ICT; cache-buster `cb=<epoch-ns>`) on canonical
`https://note.syrin.online/version.json`, Pages
`https://snote-g4-origin.pages.dev/version.json`, and short Pages preview
`https://1b9ed3d1.snote-g4-origin.pages.dev/version.json`:
`deployedSha` `0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd`,
`capabilityRoutesEnabled` true, `builtAt` `2026-09-15T15:05:49.668Z`,
`buildId` `1789484737351-s31qn3nf`.
Canonical also returned `Cache-Control: no-cache, no-store, must-revalidate`
and `CDN-Cache-Control: no-store`. Pages `.dev` hosts returned
`Cache-Control: no-cache, no-store, must-revalidate` (no `CDN-Cache-Control`
on those responses). All three hosts returned the same body and etag
`"573ea67f70cce0747dcdc959a13a3408"`.
Pages production deployment id `1b9ed3d1` (short preview
`https://1b9ed3d1.snote-g4-origin.pages.dev`; full UUID not supplied in this
attest) replaces previous live origin `2ae9a230` / Pages `fb35474a` (last
merged origin attest was `2ae9a230` / `fb35474a` in #132). This attest pins
the independently verified short id, not an invented UUID.
Atlas/Pulse pin matches this independent fetch: live
`note.syrin.online`, SHA `0cdcdc0f`, Pages `1b9ed3d1`, buildId
`1789484737351-s31qn3nf`, canary on. W2 free-edit + Legacy A3 live (#135/#137/#138/#139).
W1 convert-on-write is no longer the default. Pixel PASS live A3 @
`0cdcdc0f` / Pages `1b9ed3d1` (panel, free-edit, legacy-on, bare-after-on,
bare-tab2, legacy-off; evidence `pixel-qa/a3-0cdcdc0f/`). Sentinel pin:
READY WITH KNOWN RISKS live A3 @ `0cdcdc0f` / Pages `1b9ed3d1`
(BLOCKER/HIGH/MEDIUM none; evidence `sentinel-qa-a3-0cdcdc0f/`). PASSED:
cold bare editable; Legacy ON soft-replace `#owner=` + toast; plain-upsert
409 managed; bare RO same-tab + new-tab need-owner banner; owner reopen
editable; Legacy OFF → free-edit; plain-upsert 200 after OFF. LOW: normal
new-version reminder; one owner-link load needing hard reload; optional cold
localStorage-clear not run. Historical W1 Pixel Live UX W1 PASS remains
`pixel-qa/w1-2ae9a230/`. Historical W1 Sentinel remains `sentinel-qa-w1-live/`.
PWA smoke after this ship: SUCCESS (GitHub Actions `workflow_dispatch` run
`34986611791`; `EXPECTED_DEPLOYED_SHA` `0cdcdc0f…`;
`EXPECTED_CAPABILITY_ROUTES_ENABLED` true; Playwright 2 passed (2/2)). GitHub
`headSha` for that dispatch was `0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd`.
Identity verify logged `Verified live release 0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd capabilityRoutesEnabled=true`.
Pulse confirmed that pin: `0cdcdc0f` / Pages `1b9ed3d1`; PWA smoke
`34986611791` PASS. W2 free-edit + Legacy A3 live. Duplicate securely #128
remains on Legacy RO. A′ Cutover restore #126 superseded as default.
W1 convert-on-write #130 superseded as default. Pixel Legacy opt-in #122
still live as Legacy Advanced. PWA latch #119 still live. Choice A
editable-plain is superseded. W2 SQL `capability_note_plain_upsert` /
`capability_note_disable_secure` applied live; U1 SQL
`capability_note_convert_legacy` applied live; Edge `plain-upsert` /
`disable-secure` / `convert-legacy` published (Pulse `umsg_01m21zhm…` for
`convert-legacy`).
Walls HOLD: Worker / Realtime / `writes_enabled`. SQL 240 already applied.
No extra Edge / no SQL from this docs PR.

Kill switch unchanged: `writes_enabled=true`,
`private_realtime_enabled=false`, `updated_at`
`2026-09-02 04:24:07.235188+00` (see §3d). SQL 240 already applied
(`capability_note_import_legacy` present).
POST `/functions/v1/legacy-note-open` `{}` 400 `{"error":"invalid request"}`.
POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`.
At the 27da93eb origin bump, Worker `syrin-prerender` was still `9fcc58bc` /
`b4d1a94e`. Later Worker redeploy 2026-09-03 ~20:42 UTC / 2026-09-04
~03:42 ICT set live Worker to `931430c0` / `5f94ab6c` (see §1c).
At that Worker deploy, Origin SPA was not redeployed (then `27da93eb`).
This origin bump does not redeploy the Worker; live Worker remains
`931430c0` / `5f94ab6c`. Worker / Realtime not changed. Canary remains on.

This is W2 (#135/#137/#138/#139) canary-on free-edit for plain `/slug` plus
Legacy opt-in ON/OFF plus A3 bare-after-ON RO plus
Duplicate securely (#128) on Legacy RO only plus
optional `?legacyRo=1` still RO + banner plus Phase C RawView+Home via LNO
plus Pixel HIGH UX H1–H6 plus H2 opaque Mode/Export plus Ko-fi + New Version
FAB plus FAB-primary + Sonner suppress (#113/#116) plus PWA latch (#119)
one hard-reload per Update apply plus Pixel Legacy opt-in (#122):
plain slug and SplitView panes are `CutoverNotePage` → editable `NotePage`
(free-edit unless managed); `#owner`/`#edit` may open capability polling.
RawView `/:slug.md` loads via LNO `open`; Home availability uses LNO
`exists`. Duplicate securely is enabled on Legacy RO only (PR #128; Edge
`note-session` `import-legacy`). Home mints capabilities when canary is on
(create → `/<slug>#owner=`; fail-closed on idle). Phase C is still on this
origin. H1–H6 is still on this line. H2 is still on this line. Ko-fi FAB /
New Version remains on this line. #113 is still on this line. #116 is still
on this line. #118 is superseded on this line. #119 is still on this line.
#122 is still on this line. #123 `#owner=` Encrypt is still on this line.
#126 is superseded as default on this line. #128 is still on Legacy RO.
#130 is superseded as default on this line. #131 is still on this line as
W1 lint lineage. #135 is still on this line. #137 is still on this line.
#138 is still on this line. #139 is still on this line. FAB is the primary
update UX; Sonner is suppressed while Ko-fi FAB is mounted; Update apply
consumes one hard-reload per target. Encrypt is disabled on free-edit
(Legacy OFF) and becomes available after Legacy ON; `#owner=` Encrypt stays
active.
Pixel PASS live A3 @ `0cdcdc0f` / Pages `1b9ed3d1` (panel, free-edit,
legacy-on, bare-after-on, bare-tab2, legacy-off; evidence
`pixel-qa/a3-0cdcdc0f/`). Sentinel pin: READY WITH KNOWN RISKS live A3 @
`0cdcdc0f` / Pages `1b9ed3d1` (BLOCKER/HIGH/MEDIUM none; evidence
`sentinel-qa-a3-0cdcdc0f/`). LOW: normal new-version reminder; one
owner-link load needing hard reload; optional cold localStorage-clear not
run.
This is not SQL 240, not Realtime, not soak-complete.
Soak ≥48h started ~12:01 ICT from the first canary origin `c5914c8e`;
this bump does not restart soak. This is a same-canary origin SHA bump,
not soak-complete. Origin attest only.

## 3f. Production bulk Legacy/Secure OFF — verified; origin unchanged

Docs attestation only (2026-09-16). This section does not deploy origin /
Pages / Worker / Edge and does not re-apply SQL.

Syringa named Go A then B; Pulse **PASS**. Git tip when applied: `bd11deed`
(`bd11deedf95bec1f2e207a59fecdad974d861ff7`; migration
`20260916000000_capability_note_bulk_disable_secure.sql` SHA-256
`a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850` from #142;
tip also includes #143 `pwa-update-smoke` harden). Live SPA origin remains
`0cdcdc0f` / Pages `1b9ed3d1` from the prior A3 attest (#140). Bulk OFF is
SQL/ops, not a SPA ship. Do not claim origin moved. Origin is `0cdcdc0f`.

Go A: RPC `capability_note_bulk_disable_secure` **applied** live;
`service_role` EXECUTE only; anon/authenticated EXECUTE false.

Go B: `managed_live` 26→0; skipped_encrypted=0; errors=[]; plaintext
converted; `note_id` rotated. Pulse evidence `/workspace/pulse-bulk-off-ab2c4de9/`
(`SUMMARY.md` + `REPORT.json` verdict PASS).

Go C pin heal **HOLD**. Known residual: stale SPA `snote:legacy-secure:*`
may keep bare RO until heal / local pin clear. Server LNO for converted
slugs is unmanaged.

Sentinel live verify: **READY WITH KNOWN RISKS** (API + cold SPA free-edit
PASS; BLOCKER/HIGH none; MEDIUM = Go C residual in `FINDINGS-API.md`).
Evidence `/workspace/sentinel-qa-bulk-off-live/` (`FINDINGS.md` +
`FINDINGS-API.md`). Live `version.json` still `deployedSha`
`0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd`.

Pixel cold-browser: **PASS WITH KNOWN RISKS** (`hage`, `design` bare
editable + Synced; evidence `/workspace/pixel-qa/bulk-off-verify/`).
Aegis: khớp design.

Walls: no Worker / Realtime / origin / Pages / Edge from this attest.

This is not SQL 240, not Realtime, not soak-complete. Origin attest unchanged.

## 4. Public `notes` access — cutover migration applied; soak still required

Production SQL 220 (see §3a) and SQL 270 (see §3b) remain applied. SQL 240 is
already applied. This attest does not re-apply 240.

`20260724000000_atomic_capability_cutover.sql` dynamically drops every policy
on `public.notes` and revokes all direct privileges from `PUBLIC`, `anon`, and
`authenticated` in one transaction. Capability, update, checkpoint, and share
tables remain default-deny. The SPA uses narrow Edge APIs. Production
`legacy-note-open` is the Phase B SELECT-only exact-match Edge (see §1b).
Do not restore a dump.

SQL 240 is already applied. Remaining soak and post-cutover probes remain
mandatory. Do not re-apply. Do not restore a dump. After cutover, probe both
`anon` and `authenticated` for failed select/insert/update/delete attempts.
Rollback is API read-only and must never recreate public policies.

## 5. Realtime and durable persistence — implemented, deploy unverified

Capability notes use private `note:<noteId>` channels. Five-minute Realtime
JWTs carry note ID, scope, generation, and rollback claims; RLS on
`realtime.messages` permits receive for active capabilities and send only for
owner/edit scopes. The forged legacy `slug-abandoned` control event is removed,
and accepted event types and payload sizes are bounded.

The client persists each Yjs update to an IndexedDB outbox before broadcast or
HTTP sync. `note-sync` acknowledges an update ID idempotently; only acknowledged
items are removed. Peers may persist the same validated update hash. Checkpoint
compaction uses `throughSequence` plus version/encryption CAS. Locked-note
updates, checkpoints, recovery snapshots, and outbox entries remain ciphertext;
locking purges plaintext persistence before the secure mode is accepted.

Production must still prove reconnects, reversed delivery, sub-800 ms
navigation, concurrent saves, JWT refresh, encrypted recovery, outbox backlog,
and checkpoint conflicts during the soak. Oversized existing data must be
quarantined read-only, never truncated.

## 6. Privacy boundary — implemented in code, operations need review

The application no longer calls `ipapi.co`; locale selection uses browser
signals. Privacy copy, the extension manifest, and runtime behavior prohibit
logging note content, slug, capability/share token, URL fragment, or raw IP.
Only aggregate API errors, authorization denials, outbox backlog, and
compaction failures are permitted. Deployment logging and retention settings
must be checked separately.

## 7. Toolchain security exceptions — verified locally

The otherwise deferred Vite major upgrade is included because
[GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)
affects every Vite release through `6.4.2`; `6.4.3` is the first patched line
compatible with the current plugins, and there is no patched Vite 5 release.
[GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
affects Vitest versions below `3.2.6`. Vitest and `@vitest/coverage-v8` remain
exactly aligned and pinned together at `3.2.6`.

These exceptions do not authorize other framework majors. Frozen install,
dependency audit, lint, Knip, app/Node/tooling/Edge typechecks, unit coverage,
production build, actionlint, extension E2E, and browser smoke remain release
gates.

### Resolved dependency-audit blocker

The 2026-07-27 toolchain refresh removes the high finding previously reported
by `bun audit --audit-level=high`:
[`brace-expansion <=5.0.7` (GHSA-mh99-v99m-4gvg)](https://github.com/advisories/GHSA-mh99-v99m-4gvg).
The finding was limited to the development/build dependency graph through
ESLint, TypeScript-ESLint, `@vitest/coverage-v8`, and
`vite-plugin-pwa → workbox-build`.

The only patched `brace-expansion` release at the time was `5.0.8`, so it is
not forced into legacy `minimatch` ranges. Instead, ESLint 10 removes its
legacy consumer. Vitest's build-only `test-exclude@8.0.0` override retains the
7.x runtime source while moving its dependency graph to patched lines. All
remaining compatible 5.x paths now resolve to `brace-expansion@5.0.9` (see the
2026-08 refresh below).

Workbox `7.4.1` still reaches EJS solely through its build-time Rollup plugin.
EJS declares Jake `^10.8.5`, whose `filelist@1` chain cannot receive the patch;
`filelist@2.0.2` retains the API Jake 10 uses while moving its only dependency
to the patched `minimatch` line. Because this graph contains one `filelist`
instance and the repository's Node floor satisfies its engine requirement, a
narrowly pinned `filelist@2.0.2` override removes that final build-only path
without globally replacing `glob`, `minimatch`, or `brace-expansion`. The full
audit remains mandatory in both CI workflows; no advisory suppression or audit
exception is granted.

### Resolved dependency-audit blocker (2026-08 refresh)

The 2026-08-17 lockfile refresh clears the three high advisories reported by
`bun audit --audit-level=high` after the 2026-07 toolchain refresh:

- `fast-uri` (`ajv` path) [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7),
  resolved `3.1.4` → `3.1.5`;
- `brace-expansion` (ESLint, TypeScript-ESLint, `@vitest/coverage-v8`,
  `vite-plugin-pwa → workbox-build` paths)
  [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895),
  resolved `5.0.8` → `5.0.9`;
- `nanoid` (`postcss` path)
  [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8),
  resolved `3.3.16` → `3.3.18` (the advisory floor moved from `3.3.17` to
  `3.3.18` between 2026-08-09 and 2026-08-17).

The fix is a three-line `bun.lock` resolution update with official registry
integrity hashes. `package.json` ranges, overrides, and every other resolution
are unchanged. All three bumps stay inside the dependents' existing semver
ranges, so no new override or direct dependency was introduced.
A 2026-09-01 lockfile bump of `browserslist` `4.28.2` → `4.28.7` (official registry integrity; `update-browserslist-db` unchanged) clears [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) and [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g); still no override.
A 2026-09-02 `package.json` override of `fast-uri` `^3.1.6` (resolved `3.1.7`, official registry integrity) clears [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp), [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3), and [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g). The override is the durable floor; the lockfile must not resolve below `3.1.6`.
A 2026-09-15 `package.json` override of `smol-toml` `^1.7.1` (knip path; resolved `1.8.0`, official registry integrity) clears [GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2). The override is the durable floor; the lockfile must not resolve `<=1.7.0`.

## Scan triage rule

Treat any finding about deployed direct-table access, public Realtime,
content-bearing crawler output, raw token paths, or fail-open admin rate limits
as open until staging and production evidence proves otherwise. The repository
contains the intended fixes, but merge status is not deployment status.
