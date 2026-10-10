# rt2 Worker package

This directory is the standalone Cloudflare Worker package for realtime hub `rt2`. Its entrypoint uses the shared realtime relay and Durable Object runtime under `src/lib/realtime/hub/`; it has no dependency on `cloudflare-worker/` and does not alter the site Worker.

## Runtime and configuration

- `wrangler.toml` has an isolated Worker name, a pinned compatibility date, and `workers_dev = false`. It contains no account, zone, route, or custom-domain configuration. An operator must attach the production route separately after an approved deployment.
- The room and health Durable Objects use SQLite through the version-tagged `new_sqlite_classes` migration. The package uses the existing runtime APIs and does not enable paid-plan-only features.
- `HUB_ID`, `TICKET_PROBE_PUBLIC_KEYS_JSON`, and `SAVED_ACK_PUBLIC_KEYS_JSON` are public `[vars]`, not secrets. The two key maps are deliberately empty in this checkout; the package therefore rejects all requests until an authorized operator supplies valid public verification keys. No private signing material is included.
- The compatibility date is pinned to `2026-08-06`, the newest date supported by the repository's installed offline Miniflare/workerd runtime. Updating it requires updating and running the local runtime tests.
- Observability, traces, logs, and invocation logs are disabled. The Worker contains no logging calls; the runtime does not emit IP addresses, room IDs, tickets, or slugs.

## Offline tests

Run from the repository root with Bun `1.3.14`:

```sh
bun test ./deploy/rt2/tests/*.test.ts
bun test ./src/lib/realtime/hub/__tests__/*.bun.ts
```

The first command builds the package and a test-only Worker harness with Miniflare, using temporary local Durable Object SQLite storage and ephemeral test signing keys. It does not access a Cloudflare account or service. `tests/miniflare-harness-worker.ts` is test-only and is not referenced by `wrangler.toml`; it must never be deployed.

## Rollout boundary

No Worker is deployed and no route is attached by this package. The operator-only future deploy, `[vars]` population, route attachment, verification, and rollback sequence are recorded in the shared Realtime rollout checklist. Those steps require Syringa's separate rollout authorization.
