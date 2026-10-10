# rt1 container package

This is packaging only. It does not create or configure a Cloudflare Tunnel, touch the mini PC, publish an image, or deploy anything. The repository contains no runtime env file, tunnel token, or private signing material.

## Runtime contract

- Use an operator-created VM file at `/etc/snote-rt1/runtime.env`, owned by the dedicated service account and mode `0600`. Populate it from `runtime.env.example`; the sample deliberately contains variable names with blank values only. The Hub receives an explicit allowlist: hub ID, ticket/probe public keys, saved-ACK public keys, listener address/port, drain window, and replay database path. No private key, HMAC key, master key, tunnel token, or arbitrary env-file entries are passed to the Hub.
- The Cloudflare Tunnel token is a separate VM-only file whose host path is `CLOUDFLARED_TOKEN_FILE`; keep it mode `0600`, owned by the service account. Compose mounts it read-only only into `cloudflared`, which uses `--token-file`. Use an approved `cloudflare/cloudflared` image at version 2025.4.0 or later and supply its repository and SHA-256 digest separately.
- Supply repository and SHA-256 digest separately for the Bun builder, Node runtime, and cloudflared images. Compose and Dockerfile always construct references as `repository@sha256:digest`; a tag-only source reference cannot be used. Use an approved Bun 1.3.14 builder and Node 22.22.0+ runtime; the final Node version is checked at startup. Docker validates digest syntax when it resolves/builds each image. The Bun builder is used only during image build. Dockerfile `COPY` statements name only the runtime source modules; `.dockerignore` excludes environment files, credentials, keys, databases, and local dependencies from the context.
- Set `HUB_LISTEN_ADDRESS=0.0.0.0` inside the Hub container so the peer container can reach the service by DNS name. The entrypoint rejects any other address. `HUB_REPLAY_DATABASE_PATH` must be an absolute path below `/var/lib/snote-rt1`; that named volume is the only writable Hub data mount. The image prepares it for UID/GID `10001:10001`.
- Hub and `cloudflared` share `rt1-internal` (`internal: true`). Only `cloudflared` also joins `rt1-egress`. Neither service has a Compose `ports` entry, so no host port is published. When an authorized operator later configures the remote Tunnel route, its origin must use the Compose service name, `http://rt1-hub:<HUB_PORT>`; no route is created by this package.
- The Hub runs as UID/GID 10001, with a read-only root filesystem, a writable replay volume, `restart: unless-stopped`, and required operator-selected RAM, CPU, PID, and `nofile` limits. No machine capacity is guessed here. `HUB_DRAIN_WINDOW_MS` is required and capped at 30 seconds; Compose allows 40 seconds before force-stop to leave shutdown margin.

## Start and stop (operator-run only)

From the checkout directory on the VM, after the operator has created and secured the external files and filled all required values:

```sh
docker compose --env-file /etc/snote-rt1/runtime.env \
  --file /opt/snote/deploy/rt1/compose.yaml config

docker compose --env-file /etc/snote-rt1/runtime.env \
  --file /opt/snote/deploy/rt1/compose.yaml up --build -d

docker compose --env-file /etc/snote-rt1/runtime.env \
  --file /opt/snote/deploy/rt1/compose.yaml stop
```

`stop` sends `SIGTERM`; the Hub stops admission, sends `drain` to connected peers, waits no longer than its configured drain window, closes WebSockets/HTTP and SQLite, then exits. Docker's restart policy restarts the containers after daemon/VM reboot unless an operator explicitly stopped them.

## Network boundary assumption

The static Compose contract checks only (a) no published `ports`, (b) `rt1-internal` marked `internal: true`, and (c) only `cloudflared` attached to the egress network. **Accepted threat-model assumption:** the Ubuntu VM/Docker host is inside the trusted boundary, so host access to the Hub container IP is acceptable. Docker's bridge-network documentation confirms that a host can communicate directly with container IPs, including on internal networks; these Compose checks do not claim otherwise. No host firewall or iptables rule is added. The Hub still requires a valid signed ticket in the first frame before admitting/relaying a session, and `/healthz` requires a valid probe token.
