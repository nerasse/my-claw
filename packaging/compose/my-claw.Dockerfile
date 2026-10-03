# The my-claw server, for the compose install (docs/compose.md). Built from the repo root:
#   docker compose -f packaging/compose/compose.yml build
FROM oven/bun:1.3.13 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.13
# What the agent's tools reach for: ffmpeg (audio, video), git, curl, jq. xdotool unsticks a native
# dialog on the browser's display (browser:99). edge-tts is the default text-to-speech, in a venv.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git curl jq ca-certificates python3 python3-venv xdotool procps tini \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir edge-tts \
 && usermod -l claw -d /home/claw -m bun && groupmod -n claw bun
ENV PATH=/opt/venv/bin:$PATH \
    HOME=/home/claw \
    MY_CLAW_INSTALL=compose
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY docs/prompt ./docs/prompt
COPY packaging/config.json packaging/.env.example ./etc/
COPY packaging/web-bundle.sh packaging/compose/my-claw-entrypoint.sh ./packaging/
COPY packaging/compose/myclaw /usr/local/bin/myclaw
USER claw
EXPOSE 8080
ENTRYPOINT ["tini", "--", "/app/packaging/my-claw-entrypoint.sh"]
