ARG ALPINE_VERSION=3.24

FROM node:24-alpine${ALPINE_VERSION} AS node-runtime

FROM node-runtime AS app-dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npx --yes pnpm@11.19.0 install --prod --frozen-lockfile

FROM alpine:${ALPINE_VERSION}

LABEL org.opencontainers.image.source="https://github.com/overad9658/northstar" \
      org.opencontainers.image.description="Northstar: a lightweight, persistent priority matrix for engineering portfolios." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000

RUN apk upgrade --no-cache \
    && apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=app-dependencies /app/node_modules ./node_modules
COPY package.json \
activity-service.mjs \
    api.mjs \
    auth-service.mjs \
    backup-service.mjs \
    data-api.mjs \
    database.mjs \
    events-service.mjs \
    http-utils.mjs \
    kanban-service.mjs \
    okr-service.mjs \
    planning-service.mjs \
    postgres-database.mjs \
    postgres-worker.mjs \
    project-domain.mjs \
    project-service.mjs \
    rate-limit.mjs \
    server.mjs \
    sso-service.mjs \
    sso-settings.mjs \
    team-service.mjs \
    todo-service.mjs ./
COPY public ./public
COPY docs/*.md ./docs/
COPY mcp/README.md ./mcp/README.md

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q --spider http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.mjs"]
