# Lovable-Managed Realtime Authorization Design

**Date:** 2026-07-24

**Status:** Approved by the user on 2026-07-24

**Baseline:** `17819f9ca3aa313d5042b6f908c70da1c0205931`

**Implementation plan:** `docs/superpowers/plans/2026-07-24-lovable-managed-realtime-auth.md`

## Historical note (2026-10-09)

Approach 3 below (replacing Supabase Realtime with a custom Cloudflare relay) has been superseded by the approved Realtime hub v2 design in `docs/superpowers/specs/2026-10-09-realtime-hub-v2-design.md`. This document and its original approach analysis are retained as historical context; the replaced approach is not the active PR 5 design.

## Context

Snote is hosted on Lovable Cloud. Its database, Auth, Realtime, storage, and Edge
Functions use Lovable's managed Supabase-compatible platform; there is no
separate user-owned Supabase project.

The current capability backend signs five-minute Realtime JWTs with
`SUPABASE_JWT_SECRET`. That is not a portable production design:

- Lovable Cloud does not expose that secret in the project.
- Current Supabase runtimes expose verification material such as
  `SUPABASE_JWKS`, not an extractable signing key.
- An arbitrary secret added by the project would not be trusted by Realtime.
- Modern Supabase signing keys are intentionally non-extractable.

The production project currently has 51 notes, anonymous Auth is available but
disabled, the capability migrations are not deployed, and the old Edge
Functions are still active. This allows the undeployed migration and client
contracts to be corrected before any production cutover.

## Goals

1. Keep the product accountless: users do not create credentials or see a
   login screen.
2. Keep slug as a locator and the 32-byte capability as the authority.
3. Use only platform-issued Auth JWTs for private Supabase Realtime.
4. Prevent an owner, edit, or view capability from inheriting authority from
   another capability opened in the same browser.
5. Bound stale Realtime authority to five minutes.
6. Preserve HTTP capability authorization, idempotent Yjs update storage,
   encrypted-note behavior, the IndexedDB outbox, and revocation semantics.
7. Fail closed to authenticated API polling when the platform cannot prove the
   five-minute Realtime bound.
8. Avoid creating or paying for a separate Supabase project.

## Non-goals

- Adding user-visible accounts or social login.
- Migrating production data away from Lovable Cloud.
- Replacing Yjs, the capability URL model, or encrypted-note cryptography.
- Applying the atomic cutover before the required dual-mode soak.
- Enabling anonymous Auth or changing production before staging evidence and
  backup approval exist.

## Approaches considered

### 1. Lovable-managed anonymous Auth with capability membership

This is the selected approach. Lovable issues and rotates Auth JWTs. Snote
keeps capabilities as the authorization source and creates short-lived,
service-only Realtime memberships after verifying both identities.

Advantages:

- Uses the platform's supported signing path.
- Requires no separate backend account or data migration.
- Private Realtime RLS can use `auth.uid()` and database state.
- Capability rotation and revocation remain database-controlled.

Costs:

- Requires a migration, Auth lifecycle code, RLS changes, abuse controls, and
  client fallback behavior.
- Anonymous Auth users are persistent records and require cleanup.
- Strict private Realtime is allowed only when the issued JWT lifetime is no
  more than five minutes.

### 2. Move Snote to an independent Supabase project

Rejected for this rollout. It would create a separate empty backend, require a
high-risk migration of 51 live notes and all functions/secrets, and likely
require a paid plan for safe storage headroom and backups.

### 3. Replace Supabase Realtime with a custom Cloudflare relay

Rejected as the primary path. It would add a second authorization and
WebSocket/SSE control plane, introduce new operational failure modes, and
expand the audit surface. API polling remains only the fail-closed fallback.

## Architecture

### Capability-partitioned anonymous identities

The browser creates one Lovable/Supabase anonymous Auth identity per capability,
not one identity for the whole browser.

The client derives a local storage partition name from:

```text
SHA-256("snote-auth-v1" || capability-token)
```

Only the digest is used in the Supabase client's `auth.storageKey`; the raw
capability is never placed in a storage key, path, query, telemetry event, or
log. Tabs opening the same capability reuse one anonymous identity. Different
owner, edit, and view links receive different `auth.uid()` values, even for the
same note.

The anonymous Auth access and refresh tokens are stored by the Supabase client
inside the capability-specific storage partition. Losing that browser storage
creates a new anonymous identity; a still-valid capability can bind the new
identity without changing note ownership.

### HTTP request identity

Capability APIs keep the existing authority contract:

```http
Authorization: Bearer <capability>
X-Snote-Auth: <platform-auth-jwt>
```

The raw capability remains in the standard Authorization header. The
short-lived anonymous Auth JWT is carried in a dedicated header because the
Edge gateway remains configured with `verify_jwt = false` for capability and
legacy compatibility endpoints. The Edge Function explicitly validates the
Auth JWT with Lovable/Supabase Auth before using `auth.uid()`.

`X-Snote-Auth` is never reflected, stored, or logged. Gateway and application
logging must be tested on the staging remix before Realtime is enabled.

Legacy read-only compatibility requests that do not use private Realtime may
omit `X-Snote-Auth`. They never receive a Realtime membership.

Raw clients may also remain capability-only. A valid capability without
`X-Snote-Auth` receives polling mode and never a Realtime membership. A raw
client that wants private Realtime must first obtain its own anonymous Auth
session and send both headers.

### Realtime membership

Add a deny-all, service-only table conceptually equivalent to:

```text
note_realtime_memberships
  auth_user_id uuid
  note_id uuid
  capability_id uuid
  expires_at timestamptz
  created_at timestamptz
  refreshed_at timestamptz
  primary key (auth_user_id, note_id)
```

Constraints and service functions enforce:

- one capability binding per anonymous identity and note;
- the capability belongs to the note;
- the capability is active and unrevoked;
- the note is capability-managed and not deleted;
- membership expiry is at most five minutes from creation or refresh;
- an identity collision fails closed rather than replacing authority.

The table grants no direct access to `anon` or `authenticated`. Only narrow
Security Definer functions callable by the Edge service role may create,
refresh, or remove membership rows.

### Realtime RLS

Private channel topics remain `note:<note_id>`.

Realtime RLS derives authorization from database rows, not custom JWT claims:

1. `auth.uid()` identifies the anonymous Auth identity.
2. `realtime.topic()` identifies the requested note.
3. The membership must exist and be unexpired.
4. The joined capability must be active, unrevoked, and belong to that note.
5. Receive permits owner, edit, or view scope.
6. Send permits only owner or edit scope on an active note.
7. A service-only runtime setting must allow writes.

The current `note_write_disabled` custom JWT claim is removed. A single
service-only database runtime-settings row becomes the kill switch checked by
both Realtime RLS and HTTP write endpoints.

### Five-minute bound and polling fallback

Supabase caches Realtime authorization for a connection until it receives a
new JWT or the current JWT expires. Therefore a five-minute membership alone
cannot constrain a malicious client holding a one-hour Auth JWT.

After Auth validates the caller, the Edge Function checks the trusted JWT
`iat` and `exp`. Private Realtime is issued only when:

```text
0 < exp - iat <= 300 seconds
```

Private Realtime also requires staging evidence that gateway and application
logs do not retain `X-Snote-Auth`. Failure to prove either the JWT lifetime or
header-redaction condition selects polling mode.

The membership expiry and returned Realtime expiry are the earliest of the JWT
expiry and five minutes from the current time. The client refreshes the
capability session before expiry and calls `realtime.setAuth()` with the
current platform token so Realtime recomputes its cached policy.

If Lovable cannot issue Auth JWTs with a lifetime of at most 300 seconds, the
server does not create a Realtime membership. It returns polling mode instead.
The client then:

- persists outgoing updates through `note-sync` immediately;
- fetches missing updates using `afterSequence`;
- polls every two seconds while visible, with jitter;
- polls more slowly while hidden and backs off on errors;
- flushes immediately on focus, online, reopen, and navigation;
- never opens a public channel as a security workaround.

Polling is a degraded transport, not degraded authorization. The IndexedDB
outbox, idempotent update IDs, acknowledgements, checkpoints, and encryption
remain unchanged.

Polling has no pre-ack peer-rescue broadcast. The origin must therefore write
every update to its durable outbox before its first network attempt and may
remove it only after server acknowledgement. Full peer-rescue acceptance is
required only when private Realtime is enabled; polling must visibly report
degraded collaboration in diagnostics without exposing note identifiers.

### `NoteSession` contract

Extend the session without changing existing private-Realtime field meanings:

```ts
type NoteSession = {
  noteId: string;
  slug: string;
  scope: "owner" | "edit" | "view";
  syncTransport: "private-realtime" | "polling";
  realtimeToken: string | null;
  realtimeExpiresAt: string | null;
  realtimeTopic: string;
  checkpointSequence: number;
  missingUpdates: NoteUpdate[];
  encryption: EncryptionMetadata;
};
```

For `private-realtime`, `realtimeToken` is the platform Auth access token. For
`polling`, both Realtime fields are `null` and the provider must not construct
or subscribe to a channel.

## Abuse prevention and lifecycle

- Enable anonymous Auth only on the isolated Lovable staging remix first.
- Require Cloudflare Turnstile when creating a new anonymous identity.
- Reuse the identity for the same capability to avoid creating one user per
  page load.
- Keep existing capability admission and IP-HMAC rate limits.
- Rate-limit membership refreshes and reject malformed or overlong headers.
- Prune expired memberships on a scheduled job.
- Delete abandoned anonymous Auth users after a documented retention period
  when they have no active memberships. The cleanup uses the supported Auth
  Admin API and records only aggregate counts.
- Never log raw IPs, capability tokens, Auth JWTs, slugs, note content, URL
  fragments, or share paths.

## Error handling

- Missing or invalid capability: `401`, with no note existence disclosure.
- Valid capability with missing/invalid Auth JWT: polling session with no
  membership; never public Realtime.
- Capability/Auth identity collision: `409`, fail closed, do not overwrite.
- Capability revoked or generation changed: remove/deny membership and return
  `401`.
- Auth JWT lifetime above 300 seconds: return polling mode.
- Database/Auth unavailable: `503`, no membership and no writes.
- Write kill switch enabled: reads remain available; writes return `503` and
  Realtime send fails RLS.
- Polling errors: retain the IndexedDB outbox, apply bounded backoff, and retry
  on online/focus events.

## Test strategy

Implementation follows test-driven development. Each behavior receives a
failing test before production code.

### Unit and contract tests

- owner, edit, and view capabilities receive distinct Auth storage partitions;
- the same capability reuses its anonymous identity across tabs;
- raw capabilities never appear in storage keys or request URLs;
- capability and Auth headers are separated and bounded;
- invalid or over-five-minute JWT lifetimes select polling;
- private mode returns the platform token and earliest expiry;
- polling mode never constructs a Realtime channel;
- refresh calls `realtime.setAuth()` before expiry;
- write-kill-switch behavior no longer depends on a JWT claim.

### Database and Edge integration tests

- capability A cannot bind to note B;
- one Auth identity cannot silently switch capabilities on the same note;
- owner/edit/view send and receive scopes are enforced;
- expired, rotated, or revoked memberships are denied;
- membership expiry never exceeds five minutes;
- cross-user and cross-note access is denied;
- concurrent membership refresh is atomic;
- database/Auth failures are fail-closed;
- repeated `note-sync` update IDs remain idempotent;
- no secret header appears in Edge, gateway, or Worker logs.

### Staging browser tests

- anonymous identity creation with Turnstile;
- same-capability multi-tab collaboration;
- distinct owner and view links in one browser profile;
- reconnect and token refresh;
- revoke while connected, bounded by five minutes;
- forced long-JWT configuration selects polling;
- typing then navigating in under 800 ms retains every update;
- offline/reopen and reverse-order acknowledgements retain edits;
- locked split view never mounts plaintext before unlock.

## Rollout

1. Commit this design and implementation plan on an isolated branch.
2. Build the change test-first; obtain independent code review.
3. Create a Lovable Cloud remix with no production data and synthetic fixtures.
4. Enable anonymous Auth only on the remix.
5. Verify whether Lovable can set a 300-second Auth JWT lifetime.
6. Deploy the additive containment and capability migrations on the remix,
   excluding atomic cutover.
7. Prove private Realtime when the bound is available and polling fallback
   when it is not.
8. Create a clean green dual-mode release candidate.
9. Obtain a recoverable production backup/restore checkpoint.
10. Repeat the proven additive deployment on production and soak for 48
    continuous hours.
11. Configure the legacy cutoff, perform the separately reviewed atomic
    cutover, and verify rollback.
12. Only after production verification, fast-forward `main`, close the stacked
    PRs, and delete remote feature branches.

## Acceptance criteria

- No separate Supabase account or project is required.
- No user-visible account or login UI is introduced.
- No custom Realtime signing secret is stored or used.
- Different capabilities never share Auth authority.
- Private Realtime stale authority is bounded to five minutes.
- Platforms unable to prove that bound use polling, never public Realtime.
- Revoked or cross-note capabilities cannot read, send, sync, manage, or
  refresh another note.
- Outbox and encryption durability requirements remain intact.
- Production remains untouched until staging, review, backup, and soak gates
  pass.
