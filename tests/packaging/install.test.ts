/**
 * The installer runs on a machine with nothing on it. Two of its lines broke exactly that, found by
 * tests-install/ on Debian 12 (docs/install-test.md); these keep them from coming back unseen.
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const script = () => readFile(join(import.meta.dir, "..", "..", "packaging", "install.sh"), "utf8");

test("nothing before the package step needs a package it installs", async () => {
  const s = await script();
  const code = s
    .slice(0, s.indexOf("apt-get update"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  // jq read the version and failed on every fresh machine: "is jq installed?".
  expect(code.filter((line) => /\bjq\b/.test(line))).toEqual([]);
  expect(code.some((line) => line.startsWith('VERSION="$(sed -n'))).toBe(true);
});

test("no `| grep -q` under pipefail: an early exit SIGPIPEs the writer and the test reads false", async () => {
  const s = await script();
  expect(s.includes("set -euo pipefail")).toBe(true);
  expect(s.split("\n").filter((line) => /\|\s*grep -q/.test(line))).toEqual([]);
});

test("Chromium where the distribution has none: Chrome for Testing, root-owned, outside the user's tree", async () => {
  const s = await script();
  expect(s.includes('CFT_DIR="/opt/my-claw-chromium"')).toBe(true);
  expect(s.includes('ln -sfn "$chrome" /usr/bin/chromium')).toBe(true);
});

test("VNC asks for a password, or stays on loopback without one", async () => {
  const unit = await readFile(join(import.meta.dir, "..", "..", "packaging", "units", "my-claw-vnc.service"), "utf8");
  const exec = unit.split("\n").find((line) => line.startsWith("ExecStart="))!;
  expect(exec.includes('-rfbauth "$$f"')).toBe(true);
  // -nopw only ever beside -localhost: the network never gets the browser without a password.
  expect(exec.match(/-nopw/g)?.length).toBe(1);
  expect(exec.includes("-localhost -nopw")).toBe(true);
  const update = await readFile(join(import.meta.dir, "..", "..", "packaging", "update.sh"), "utf8");
  expect(update.includes('[ "$UNIT_SRC" = "units" ] && ensure_vnc_password')).toBe(true);
});
