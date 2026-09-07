# Immediate containment rollout

This change set is code-only. It must not be applied to staging or production
without the explicit checkpoint below.

**Live status (2026-09-03):** Production Worker `syrin-prerender` is PR #89
`931430c0` / Cloudflare Version ID `5f94ab6c-fde5-4416-a3aa-74daaa2e6094`.
Observability and invocation logs are live; traces remain disabled. Staging
`syrin-prerender-staging` was not deployed. Origin remains `77d791af`
(canary on; CutoverNotePage + Phase C RawView/Home LNO + Home mint live, fail-closed idle). See `docs/security-findings.md` §1c. This runbook is still
required for any future Worker, cache-purge, or tombstone change.

## Required checkpoint

1. Create and verify a database backup/PITR restore point.
2. In staging, prove that the managed Cloudflare edge supplies exactly one IP
   literal in `CF-Connecting-IP` and rejects or overwrites client attempts to
   set it. Do not fall back to `X-Forwarded-For`, `Sb-Forwarded-For`,
   `X-Real-IP`, `True-Client-IP`, or `X-Envoy-External-Address`. If the exact
   public invocation path cannot satisfy that probe, leave the admin functions
   disabled; they intentionally return `503` rather than trust an ambiguous
   header.
3. Provision `ADMIN_RATE_LIMIT_HMAC_SECRET` with at least 32 random bytes and
   set `ADMIN_SESSION_TTL_MINUTES` between 5 and 30 (default: 15). Do not reuse
   the admin passphrase as the HMAC secret.
   Without printing or copying the value into logs, preflight that the existing
   `ADMIN_PASSPHRASE` is non-empty and no longer than 1,024 JavaScript code
   units, which is the legacy endpoint boundary retained only for login
   compatibility. After the replacement endpoint passes staging, rotate it to
   a new 12–72 UTF-8-byte value before removing the environment fallback. Do
   not disable the legacy route and migration rollback path if this preflight
   fails; doing so can lock every administrator out.
4. Inventory every live share hostname and direct origin alias, including
   `note.syrin.online`, `syrin.online`, `www.syrin.online`, and
   `snote.lovable.app`. Route each public hostname through the generic share
   response, or make the alias non-public/disabled.
   Do not advance while any public alias can bypass the generic share response.
5. Deploy only from the committed `cloudflare-worker/wrangler.toml` and confirm
   `[observability.logs] invocation_logs = true` and
   `[observability.traces] enabled = false`. Inventory Workers Logs, Tail
   Workers, Workers Logpush, and zone-level HTTP request datasets. Disable or
   redact every pipeline that can retain a raw `/s/*` request path except the
   committed invocation logs after that inventory; application log sanitization
   cannot remove a URL captured by Cloudflare before the Worker runs. Do not
   advance while Tail, Logpush, traces, or zone HTTP datasets still retain raw
   share paths.

## Migration and deployment order

1. Disable or tombstone the legacy admin, `cleanup`, and
   `old-slug-cleanup-status` Edge endpoints at the gateway before changing
   SQL. Verify the old passphrase-body endpoints are unreachable or return
   fail-closed `503`; do not rely on their baseline limiter after the `ip`
   column is renamed. The old-slug observer must return only its committed
   generic `410 no-store` body and must not resolve, echo, or log either slug.
2. Apply `20260522000000_admin_rate_limit.sql` if it is not already recorded.
3. Apply `20260719000000_security_immediate_containment.sql`. Confirm public
   DELETE is revoked, old raw-IP limiter rows were purged, admission and pass
   rotation RPCs are executable only by `service_role`, and
   `admin_auth_state`, `admin_credential_material`, `admin_session_issue`, and
   `admin_sessions` are service-role-only. Schedule
   `select * from public.admin_security_prune();` as a daily retention job and
   alert on failures. The admin-session endpoint also runs the same RPC on each
   request and fails closed, but that opportunistic backstop does not replace
   the daily retention job for an idle deployment.
4. Deploy `admin-session`, `admin-list`, `admin-delete`, and `admin-rotate`
   while their public routes remain disabled. Deploy `cleanup` and
   `old-slug-cleanup-status` only as their committed `410 no-store`
   tombstones. Smoke-test concurrent
   wrong passes, DB-error `503`, session expiry, logout revocation, subject
   binding, rotation revocation, and both login-before-rotation and
   rotation-before-login interleavings on staging. A verification begun with
   an old credential epoch must never issue a session after rotation.
5. Enable only the replacement admin endpoints after those smoke tests pass.
   The passphrase body contract must remain unavailable.
   The cleanup endpoint remains tombstoned and must not be enabled: until
   atomic capability cutover,
   clients can forge every note field that a destructive cleanup predicate
   could inspect. Any future cleanup replacement requires a separate reviewed
   migration and a server-authoritative ownership/liveness signal.
6. Deploy the `share-rename` tombstone. Verify it returns `410` and `no-store`
   without initializing a database client, then purge cached responses for the
   retired endpoint.
7. Deploy the generic share Worker from the committed Wrangler configuration
   first so no live Worker depends on the old
   `note-meta` resolver. Then deploy the generic `note-meta` tombstone and
   purge both `/s/*` HTML cache entries and **every** Supabase/CDN/intermediary
   `note-meta` cache variant, including the historical `?slug=...` and
   `?token=...` forms. A token-only purge is insufficient. If a wildcard purge
   covering every query-string variant is not available, keep share rollout
   blocked through the verified maximum expiry of the old
   `s-maxage=300, stale-while-revalidate=3600` responses. Prove neither an
   unauthenticated slug nor token query can receive an old cached locator or
   preview. Verify raw,
   percent-encoded, encoded-separator/backslash, uppercase, asset-looking, and
   trailing-slash share paths with Slack and Meta crawler user agents on
   `note.syrin.online`, the apex, and `www` return the same token-free,
   `no-store`, non-indexable crawler response. Verify `snote.lovable.app` is
   non-public/disabled or has equivalent origin-side containment before the
   purge. Do not advance while any public alias can bypass the generic share response.
8. Deploy the SPA and extension containment changes. For an encrypted staging
   note, first establish the durable browser pin, then force metadata to
   plaintext and separately remove the row: both cases must render the
   fail-closed conflict gate without constructing a Y.Doc provider, IndexedDB
   persistence, editor, preview, snapshot, beacon, or keepalive request. With
   two tabs open, lock/decrypt in one tab and confirm the stale tab unmounts and
   cannot broadcast or persist in its old mode. Also verify bounded Realtime
   events, locale-only language selection, privacy copy, and a stalled PWA
   update before advancing beyond staging. Treat any already-issued legacy
   table request as a residual risk until the capability cutover revokes direct
   writes; do not claim the local pin is an authorization boundary.

No function in this sequence logs a passphrase, session token, locator, or raw
client address.

## Rollback

Rollback is API read-only. Disable the new admin functions and keep the public
DELETE policy and table privilege revoked. Do not recreate `USING (true)` or
restore direct anonymous DELETE. Restore application availability from the
verified checkpoint only after incident review; session/limiter tables may be
discarded because they contain no note content.
