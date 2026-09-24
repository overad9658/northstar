ARG ALPINE_VERSION=3.24

FROM node:24-alpine${ALPINE_VERSION} AS node-runtime

FROM alpine:${ALPINE_VERSION}

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000

RUN apk upgrade --no-cache \
    && apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY package.json server.mjs api.mjs auth-service.mjs data-api.mjs backup-service.mjs database.mjs http-utils.mjs planning-service.mjs project-domain.mjs project-service.mjs team-service.mjs ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q --spider http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.mjs"]
