# Local speech-to-text (profile `whisper`): the server my-claw-whisper.service runs on bare metal.
FROM python:3.12-slim
# Pinned to the set the bare-metal box runs: PyAV 19 dropped an argument faster-whisper 1.2.1 passes
# (`open() got an unexpected keyword argument 'metadata_errors'`), every transcription a 500.
RUN pip install --no-cache-dir faster-whisper==1.2.1 av==17.0.0 ctranslate2==4.7.1 && useradd -m -u 1000 claw && mkdir /models && chown claw /models
COPY packaging/whisper-server.py /app/whisper-server.py
ENV HF_HOME=/models
USER claw
EXPOSE 8000
CMD ["python", "/app/whisper-server.py", "--host", "0.0.0.0", "--port", "8000"]
