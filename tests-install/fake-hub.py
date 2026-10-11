#!/usr/bin/env python3
"""A dl-hub for tests-install/release-source.sh, in a container beside the test machine: the
neutral layout, one key. A fresh machine has no python, so the hub does not run on it.

Serves /my-claw/{server,app}/latest.json and the files under /srv/hub/<component>/<version>/,
and the installer at /my-claw/install.sh. A request without `Bearer $KEY` is a 401, as on the
real hub; /srv/hub/revoked makes every key fail, to play a revocation.
"""
import json, os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/srv/hub"
KEY = sys.argv[1]
FORGE_TOKEN = "forge-e2e"
TRADED = KEY + "-traded"
LOG = open("/srv/fake-hub.log", "a", buffering=1)


def latest(component):
    base = os.path.join(ROOT, component)
    versions = sorted(os.listdir(base), key=lambda v: [int(x) for x in v.split(".")])
    v = versions[-1]
    files = [{"name": n, "size": os.path.getsize(os.path.join(base, v, n))} for n in sorted(os.listdir(os.path.join(base, v)))]
    if component == "app":
        files.sort(key=lambda f: not f["name"].endswith(".apk"))
    return {"version": v, "files": files}


class Hub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body=b"", kind="text/plain"):
        self.send_response(code)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        auth = self.headers.get("authorization", "")
        LOG.write(f"POST {self.path} {'forge' if auth == 'token ' + FORGE_TOKEN else 'noforge'}\n")
        self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path != "/my-claw/key/exchange" or auth != "token " + FORGE_TOKEN:
            return self.send(403, b"refused")
        self.send(200, json.dumps({"key": TRADED, "url": "http://hub:8099/my-claw"}).encode(), "application/json")

    def do_GET(self):
        auth = self.headers.get("authorization", "")
        good = auth in ("Bearer " + KEY, "Bearer " + TRADED)
        LOG.write(f"{self.command} {self.path} {'key' if good else 'nokey'}\n")
        if not good or os.path.exists(os.path.join(ROOT, "revoked")):
            return self.send(401, b"a download key is needed")
        m = re.fullmatch(r"/my-claw/(server|app)/latest\.json", self.path)
        if m:
            return self.send(200, json.dumps(latest(m.group(1))).encode(), "application/json")
        if self.path == "/my-claw/install.sh":
            # As dl-hub serves it: the source and the request's key under the shebang.
            script = open(os.path.join(ROOT, "install.sh")).read().split("\n", 1)
            head = f"DL_HUB_URL='http://hub:8099/my-claw'\nDL_HUB_KEY='{auth[7:]}'\n"
            return self.send(200, (script[0] + "\n" + head + script[1]).encode())
        m = re.fullmatch(r"/my-claw/(server|app)/(\d+\.\d+\.\d+)/([A-Za-z0-9._-]+)", self.path)
        if m and os.path.isfile(os.path.join(ROOT, *m.groups())):
            return self.send(200, open(os.path.join(ROOT, *m.groups()), "rb").read(), "application/gzip")
        self.send(404, b"not found")


ThreadingHTTPServer(("0.0.0.0", 8099), Hub).serve_forever()
