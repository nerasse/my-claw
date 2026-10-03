# The browser the agent drives, for the compose install (docs/compose.md): Xvfb, Chromium with CDP,
# the sidecar, and VNC to watch or take over. The same stack the bare-metal units run.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify procps tini \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && usermod -l claw -d /home/claw -m node && groupmod -n claw node
WORKDIR /app
# The sidecar imports playwright-core from /app/node_modules, at the version the server's lock pins.
COPY package.json ./server-package.json
RUN npm install --no-save --no-package-lock --omit=dev "playwright-core@$(node -p 'require("./server-package.json").dependencies["playwright-core"].replace(/^[\^~]/, "")')" \
 && rm server-package.json
COPY sidecar ./sidecar
COPY packaging/chromium-prestart.sh packaging/compose/browser-entrypoint.sh ./packaging/
ENV HOME=/home/claw
USER claw
EXPOSE 9223 5900 6080
ENTRYPOINT ["tini", "--", "/app/packaging/browser-entrypoint.sh"]
