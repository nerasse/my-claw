# Local text-to-speech (profile `piper`): Piper's own HTTP server, POST /synthesize {"text": ...}
# -> WAV. Pinned: the route moved between releases, and src/voice/tts.ts speaks this one.
FROM python:3.12-slim
RUN pip install --no-cache-dir "piper-tts[http]==1.8.0" && useradd -m -u 1000 claw && mkdir /voices && chown claw /voices
COPY packaging/compose/piper-entrypoint.sh /app/piper-entrypoint.sh
USER claw
EXPOSE 5000
ENTRYPOINT ["/app/piper-entrypoint.sh"]
