ARG HUB_BUN_BUILDER_IMAGE_REPOSITORY
ARG HUB_BUN_BUILDER_IMAGE_DIGEST
ARG HUB_NODE_RUNTIME_IMAGE_REPOSITORY
ARG HUB_NODE_RUNTIME_IMAGE_DIGEST
FROM ${HUB_BUN_BUILDER_IMAGE_REPOSITORY}@sha256:${HUB_BUN_BUILDER_IMAGE_DIGEST} AS builder

WORKDIR /build
COPY deploy/rt1/package.json deploy/rt1/bun.lock ./
RUN test "$(bun --version)" = "1.3.14" \
  && bun install --frozen-lockfile --production

COPY src/lib/realtime/protocol.ts ./src/lib/realtime/protocol.ts
COPY src/lib/realtime/hub/clock.ts ./src/lib/realtime/hub/clock.ts
COPY src/lib/realtime/hub/health.ts ./src/lib/realtime/hub/health.ts
COPY src/lib/realtime/hub/keyring.ts ./src/lib/realtime/hub/keyring.ts
COPY src/lib/realtime/hub/node-adapter.ts ./src/lib/realtime/hub/node-adapter.ts
COPY src/lib/realtime/hub/node-entrypoint.ts ./src/lib/realtime/hub/node-entrypoint.ts
COPY src/lib/realtime/hub/node-sqlite.ts ./src/lib/realtime/hub/node-sqlite.ts
COPY src/lib/realtime/hub/rate-limiter.ts ./src/lib/realtime/hub/rate-limiter.ts
COPY src/lib/realtime/hub/relay-core.ts ./src/lib/realtime/hub/relay-core.ts
COPY src/lib/realtime/hub/replay-store.ts ./src/lib/realtime/hub/replay-store.ts
RUN mkdir -p /out \
  && bun build ./src/lib/realtime/hub/node-entrypoint.ts --target=node --outfile=/out/node-entrypoint.mjs

FROM ${HUB_NODE_RUNTIME_IMAGE_REPOSITORY}@sha256:${HUB_NODE_RUNTIME_IMAGE_DIGEST} AS runtime

ENV NODE_ENV=production
WORKDIR /opt/snote-rt1
RUN mkdir -p /var/lib/snote-rt1 \
  && chown 10001:10001 /var/lib/snote-rt1 /opt/snote-rt1
COPY --from=builder --chown=10001:10001 /out/node-entrypoint.mjs ./node-entrypoint.mjs
USER 10001:10001
ENTRYPOINT ["node", "/opt/snote-rt1/node-entrypoint.mjs"]
