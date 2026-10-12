FROM oven/bun:1.3.13 AS build
WORKDIR /app
COPY packaging/apns-relay/package.json packaging/apns-relay/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/apns-relay ./src/apns-relay
RUN bun build src/apns-relay/main.ts --target bun --external cbor --external node-app-attest --external zod --outfile relay.js

FROM oven/bun:1.3.13
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/relay.js ./relay.js
RUN mkdir /data && chown bun:bun /data
USER bun
ENV RELAY_HOST=0.0.0.0 PORT=8080 RELAY_DB=/data/relay.sqlite
EXPOSE 8080
VOLUME /data
CMD ["bun", "relay.js"]
