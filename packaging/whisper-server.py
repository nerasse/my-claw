#!/usr/bin/env python3
"""Local speech-to-text sidecar, the server side of `voice/stt.ts` transcribeLocal.

It exists because the unit used to call `faster-whisper-server`, a binary that is not on PyPI and
was never installed, then fall back to `python3 -m faster_whisper_server`, a module that does not
exist either. The unit therefore failed every five seconds under Restart=always, forever, and local
STT silently never worked.

The contract is the client's, and it is exact:

    POST /transcribe   multipart/form-data, field `file` (audio), optional field `language`
    200  {"text": "...", "language": "fr"}

Only `faster_whisper` is imported, nothing else outside the standard library. The multipart body is
parsed by hand because `cgi` was removed in Python 3.13 and pulling a dependency for one boundary
split would be worse.
"""

import argparse
import json
import os
import re
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

# Small is the trade this box was already using: large-v3 needs more RAM than the VM can spare
# beside the agent, and the transcript feeds a chat message, not a subtitle track.
DEFAULT_MODEL = os.environ.get("FASTER_WHISPER_MODEL", "small")
DEFAULT_DEVICE = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
DEFAULT_COMPUTE = os.environ.get("FASTER_WHISPER_COMPUTE", "int8")

# 25 MB, the ceiling the client refuses to send past.
MAX_BODY = 25 * 1024 * 1024

_model = None
_model_lock = threading.Lock()


def model():
    """Loaded on the first request, not at import: the unit must come up before the weights do."""
    global _model
    with _model_lock:
        if _model is None:
            _model = WhisperModel(DEFAULT_MODEL, device=DEFAULT_DEVICE, compute_type=DEFAULT_COMPUTE)
        return _model


def boundary_of(content_type):
    match = re.search(r'boundary="?([^";]+)"?', content_type or "")
    return match.group(1).encode() if match else None


def parse_multipart(body, boundary):
    """The parts we care about: the file payload and the language field. Everything else is dropped."""
    parts = {}
    for chunk in body.split(b"--" + boundary):
        head, _, payload = chunk.partition(b"\r\n\r\n")
        if not payload:
            continue
        name = re.search(rb'name="([^"]+)"', head)
        if not name:
            continue
        # The trailing CRLF belongs to the delimiter, not to the value.
        parts[name.group(1).decode()] = payload[:-2] if payload.endswith(b"\r\n") else payload
    return parts


class Handler(BaseHTTPRequestHandler):
    server_version = "my-claw-whisper/1"
    protocol_version = "HTTP/1.1"

    def reply(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self.reply(200, {"ok": True, "model": DEFAULT_MODEL})
            return
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/transcribe":
            self.reply(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self.reply(400, {"error": "empty body"})
            return
        if length > MAX_BODY:
            self.reply(413, {"error": "audio too large"})
            return

        boundary = boundary_of(self.headers.get("Content-Type"))
        raw = self.rfile.read(length)
        # A raw audio body is accepted too: it costs one branch and makes the endpoint testable
        # with curl --data-binary.
        parts = parse_multipart(raw, boundary) if boundary else {"file": raw}

        audio = parts.get("file")
        if not audio:
            self.reply(400, {"error": "no file part"})
            return
        language = (parts.get("language") or b"").decode().strip() or None

        path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as handle:
                handle.write(audio)
                path = handle.name
            segments, info = model().transcribe(path, language=language)
            text = " ".join(segment.text.strip() for segment in segments).strip()
            self.reply(200, {"text": text, "language": getattr(info, "language", language) or ""})
        except Exception as err:  # noqa: BLE001 - the client wants a body, not a stack trace
            print(f"transcribe failed: {err}", file=sys.stderr, flush=True)
            self.reply(500, {"error": str(err)})
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def log_message(self, fmt, *args):
        # One line per request would drown the journal; failures print themselves above.
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"my-claw-whisper listening on {args.host}:{args.port} (model {DEFAULT_MODEL})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
