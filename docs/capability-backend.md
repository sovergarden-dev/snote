# Capability backend

This is the additive backend phase for accountless secure notes. A slug is a
locator. A 32-byte capability is the authority. Existing notes stay in legacy
mode and never receive an owner capability automatically.

## Threat model and invariants

- Raw owner, edit, and view capabilities are returned only at secure-note
  creation or rotation. They are never stored in Postgres.
- The browser generates and durably retains the owner candidate before the
  create request. A retry with the same owner HMAC recovers the exact note;
  another caller still receives `slug_unavailable`.
- `note_capabilities.token_hash` stores a domain-separated HMAC-SHA-256 made
  with `CAPABILITY_HMAC_SECRET`. A database-only leak cannot be used to mint or
  verify candidate capabilities offline without that separate secret.
- Capability requests put the token only in `Authorization: Bearer <token>`.
  New endpoints do not read tokens from a path, query string, or JSON body and
  do not log request data.
- The temporary `x-legacy-share` header is solely for old `/s/:token` links.
  It is not accepted as a new capability and is removed by the PR5 cutover.
- During the additive phase, legacy share creation is serialized through
  `legacy_share_rotate`. The atomic cutover tombstones that Edge endpoint and
  revokes the RPC from `service_role`, so legacy state is read-only afterward.
- `owner` can manage and edit, `edit` can sync, and `view` can only read.
- Realtime JWTs expire after five minutes. Their `sub`, `note_id`, scope, and
  generation are checked against an active capability by RLS on
  `realtime.messages`; channels use the private topic `note:<noteId>`.
- `note_updates` and `note_checkpoints` reject in-place update/direct delete.
  They are removed only when an authorized database deletion removes the whole
  parent note. A repeated update with the same SHA-256 `updateId` is idempotent
  and resolves to its original sequence.
- Atomic hourly admission windows bound create/sync operations globally and by
  a one-way subject hash. Per-note update/checkpoint counts and cumulative
  opaque bytes are also bounded; crossing a durable limit quarantines the note
  read-only instead of truncating data.
- Encryption transitions require an owner capability, the expected encryption
  version, and a checkpoint through the current update sequence in one database
  transaction. An exact retry after a lost response recovers the committed
  checkpoint idempotently. No client may directly toggle the encrypted state.
- The migration publishes its security-definer functions, revocations, and
  grants in one transaction; a partially applied privilege boundary is never
  committed.

## Public HTTP contract

All responses carry `Cache-Control: no-store` and `CDN-Cache-Control: no-store`.
The legacy credential-free `raw` Edge dump is a permanent `410` tombstone
(`{"found":false}`, `no-store`) and must not select or echo note bytes.
Git `legacy-note-open` is the Phase B exact-match `legacy-note-open` Edge Function:
service-role SELECT-only `{ action: "exists" | "open", slug }` with
`capability_managed = false AND sync_status = 'legacy' AND deleted_at IS NULL`.
Capability-managed, non-legacy, and deleted rows are `exists: false`. Invalid
action/slug is `400 { "error": "invalid request" }` without echoing the slug.
The function never INSERT/UPDATE/DELETEs, never reads Bearer or query/path tokens,
and never returns capability ciphertext. HMAC CF-Connecting-IP admission is omitted
because this path is SELECT-only and has no admission window. Consume RPCs
would write; do not invent Turnstile. Do not restore a dump.
Production Edge deploy is attested separately (see [security findings §1b](security-findings.md)).
This document does not authorize an Edge deploy, origin Pages, Worker, SQL 240, or
Realtime flip.
Live writes remain the legacy `NotePage` path (plain slug; dual-mode canary on, findings §3e). Home create mints when canary is on (fail-closed idle). SQL 240 is not applied.
After the atomic cutover, browser roles still have no table grants; rollback keeps
this read-only LNO and must never restore `anon`/`authenticated` `notes` GRANTs.
See [the cutover runbook](security/atomic-capability-cutover.md)
for the mandatory 48-hour soak, migration order, compatibility deadline, and
read-only rollback procedure.
Malformed credentials return a generic `401`; storage/configuration failures
return `503` without including database error text.

### `note-session`

`POST { "action": "create", "slug": "..." }` uses the client-generated owner
candidate in `Authorization: Bearer <candidate>`. The first `201` response
contains `{ session, capabilities: { owner, edit, view } }`. If the response is
lost, retrying the same candidate returns `200` with the recovered owner only;
the raw edit/view keys are never regenerated for an existing note.

`POST { "action": "import-legacy", ...initialCheckpoint }` is the cutover-only
duplicate path. It validates/encrypts on the client first, then atomically
inserts the note, capability hashes, and initial checkpoint in one database
transaction. The client persists a fresh owner candidate before sending it as
the Bearer credential; retrying the same owner + checkpoint recovers a commit
whose response was lost instead of leaving an unowned slug.

Otherwise, send `Authorization: Bearer <capability>` and optionally
`{ "afterSequence": 42 }`. The response contains a `NoteSession`:

```ts
type NoteSession = {
  noteId: string
  slug: string
  scope: "owner" | "edit" | "view"
  realtimeToken: string
  realtimeExpiresAt: string
  realtimeTopic: `note:${string}`
  generation: number
  syncStatus: "active" | "read_only_quarantine"
  currentSequence: number
  payloadLimitBytes: number
  checkpointSequence: number
  checkpointVersion: number | null
  checkpointPayload: string | null
  checkpointEncryptionVersion: number | null
  missingUpdates: Array<{
    updateId: string
    payload: string
    sequence: number
    encryptionVersion: number
  }>
  encryption: {
    enabled: boolean
    version: number
    salt: string | null
    check: string | null
    iterations: number
  }
}
```

Database payloads in `NoteSession` use unwrapped standard base64. Write requests
use canonical unpadded base64url so the server can reject alternate encodings.

### `note-sync`

Send a Bearer owner/edit capability and:

```json
{
  "updates": [{ "updateId": "sha256-hex", "payload": "base64url" }],
  "expectedEncryptionVersion": 0,
  "afterSequence": 42
}
```

The server verifies that every `updateId` is the SHA-256 of the exact payload,
validates the complete batch before the first write, inserts it atomically, and
returns `{ acknowledgements, session }`.
Calling it again with the same `{ updateId, payload }` is idempotent and returns
the same sequence. A view capability is rejected. A stale encryption version or
`read_only_quarantine` note cannot accept writes. Temporary admission failure
returns `429 { code: "rate_limited" }` with `Retry-After`; database/admission
unavailability fails closed with `503`.

An append batch and a checkpoint must be separate requests. This prevents a
checkpoint CAS response from hiding acknowledgements for an append that already
committed. Sync-specific `409` codes are deliberate:

- `append_encryption_conflict`: preserve the outbox and fence the client; the
  encryption epoch changed before any append.
- `checkpoint_encryption_conflict`: fence the client; the checkpoint was made
  for a stale encryption epoch.
- `checkpoint_version_conflict`: a different writer won only the checkpoint
  CAS; reload the `NoteSession` cursor and retry compaction later.

`quota_exceeded` from append/checkpoint means the note was quarantined and is
terminal for that capability. It maps to `409 { code: "quota_exceeded" }` with
no `Retry-After`, so raw HTTP clients must stop retrying and preserve their
outbox. The Edge boundary renames the older admission-RPC `quota_exceeded`
response to `rate_limited`, which remains the temporary `429` variant.

An owner/editor may also send an optional checkpoint
`{ checkpointId, payload, throughSequence, expectedCheckpointVersion }`.
Checkpoint creation uses checkpoint-version and encryption-version CAS;
`throughSequence` must advance beyond the latest checkpoint without exceeding
the durable update sequence.

### `note-manage`

All actions require an owner Bearer capability:

- `{ "action": "rename", "slug": "new-slug" }`
- `{ "action": "delete" }` (atomic parent delete; capabilities and opaque
  history are erased by foreign-key cascade)
- `{ "action": "rotate", "scope": "edit" | "view" }`
- `{ "action": "set-encryption", ... }` with expected version and a checkpoint

Rotation returns the new raw capability once. Owner rotation is intentionally
not exposed in this phase to avoid an unrecoverable accidental lockout.

### `share-view`

A view capability in the Bearer header receives the same `NoteSession` shape;
send `{ "afterSequence": 42 }` to page beyond the first 500 missing updates.
Owner/edit capabilities may also read. During dual-mode soak, an old share can
still use `x-legacy-share`; it only reads a non-capability-managed legacy row.

## Payload sizing and quarantine

Before staging enables the new endpoints, run:

```sql
select * from public.capability_payload_audit(1048576);
```

The result is aggregate-only: counts and maximum byte sizes, never content,
slug, token, or IP. Set `notes.payload_limit_bytes` above the largest valid
production payload while remaining below the verified Edge/gateway request
limit. Also verify `storage_limit_bytes`, `update_limit_count`, and
`checkpoint_limit_count` against synthetic production-like histories. Run
`capability_quarantine_oversized()` after changing a limit. It marks exceptions
`read_only_quarantine`; it never truncates or deletes data.

Create admission hashes the single Cloudflare-owned `cf-connecting-ip` address
with a separate HMAC domain; forwarded chains and missing/unverified addresses
fail closed. There is no secondary-header fallback. Staging must prove that the
exact public invocation path rejects or overwrites client attempts to set the
header before enabling note creation. The database stores only the resulting
`subject_hash`, never a raw address.

## Migration and rollout order

1. Take the required staging backup/PITR checkpoint.
2. Verify Edge has its platform-provided `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`, then add a random `CAPABILITY_HMAC_SECRET` of
   at least 32 bytes. Do **not** add `SUPABASE_JWT_SECRET`: managed Realtime
   Auth uses the platform identity rather than custom JWT signing.
3. Apply `20260722000000_capability_backend.sql` on staging.
4. Apply `20260723000000_capability_checkpoint_compaction.sql` on the same
   staging database. `20260727000000_capability_sync_conflict_codes.sql`
   replaces functions introduced by this migration, so it cannot precede it.
5. Run the aggregate payload audit, choose the production limit, and quarantine
   exceptions.
6. Deploy and verify the compatible `_shared/capability-edge.ts` mapping and all
   four capability functions (`note-session`, `note-sync`, `note-manage`, and
   `share-view`) before changing the sync RPC contract. This deploy must expose
   `rate_limited`, terminal `quota_exceeded`, and the three explicit sync
   conflict codes before the migration below is applied.
7. Apply `20260727000000_capability_sync_conflict_codes.sql`; it recreates only
   the two service-only sync RPCs, preserves their signatures and locking, and
   does not rewrite historical migrations or data.
8. Deploy the client that fences encryption/quarantine conflicts and retries
   only `checkpoint_version_conflict`; verify the durable outbox on an induced
   `409` before enabling it broadly.
9. Prove the gateway-owned address header cannot be spoofed, then exercise
   admission concurrency, `429`, and fail-closed `503` paths.
10. Verify private-channel RLS for owner/edit/view and revoked generations.
11. Soak with synthetic capability notes before any client or table cutover.
    `20260724000000_atomic_capability_cutover.sql` is deliberately excluded
    from this additive rollout; apply it only through the separate 48-hour
    [cutover runbook](security/atomic-capability-cutover.md). If a staging clone
    already includes that cutover, preserve forward filename order:
    `220 → 230 → 240 → 270`.

## Rollback

Disable the four Edge functions first. Leave the additive tables and immutable
identifiers in place so updates and checkpoints remain recoverable. Put secure
notes into `read_only_quarantine`; do not re-enable public access to them and do
not drop append-only data. Legacy policies remain limited to
`capability_managed = false` until the separate PR5 transaction removes all
direct-table privileges.
