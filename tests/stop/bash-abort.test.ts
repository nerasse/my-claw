import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { bashTool } from "../../src/tools/bash.ts";
import { AbortedError } from "../../src/core/aborted.ts";

test("bash: abort kills a long-running command quickly", async () => {
  const c = new AbortController();
  const startedAt = Date.now();
  const p = bashTool.execute({ command: "sleep 30", __signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(() => p, AbortedError);
  assert.ok(Date.now() - startedAt < 5000, "returned promptly after abort");
});

test("bash: already-aborted signal throws AbortedError without running", async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => bashTool.execute({ command: "echo hi", __signal: c.signal }), AbortedError);
});

test("bash: kills the whole process group (no orphaned child)", async () => {
  const c = new AbortController();
  // Marker file written by a grandchild after a delay; if the group is killed it never appears.
  const marker = `/tmp/myclaw-stop-test-${crypto.randomUUID()}`;
  const p = bashTool.execute({ command: `(sleep 1; echo x > ${marker}) & wait`, __signal: c.signal });
  setTimeout(() => c.abort(), 50);
  await assert.rejects(() => p, AbortedError);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await Bun.file(marker).exists(), false, "grandchild was killed with the group");
});

/** A child the command detaches: its own session, and it inherits our stdout and stderr. */
function detached(command: string, pidFile: string): string {
  return `setsid -f bash -c 'echo $$ > ${pidFile}; ${command}'`;
}

async function pidOf(pidFile: string): Promise<number | undefined> {
  for (let i = 0; i < 50; i++) {
    const text = await Bun.file(pidFile).text().catch(() => "");
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  return undefined;
}

function killQuietly(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** The host can put a call in a systemd scope: the only thing that reaches a detached child. */
function canScope(): boolean {
  try {
    return Bun.spawnSync(["systemctl", "--user", "show-environment"]).exitCode === 0;
  } catch {
    return false;
  }
}

test("bash: a command whose detached child holds our pipes still returns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myclaw-detach-"));
  const pidFile = join(dir, "pid");
  const startedAt = Date.now();
  // `setsid -f` leaves a shell holding fd 1 and fd 2 open for a minute. Waiting for EOF on those
  // held a run for 14 hours on 2026-11-24; the call has to answer what the command printed.
  const result = await bashTool.execute({ command: `${detached("exec sleep 60", pidFile)}; echo done` });
  const pid = await pidOf(pidFile);
  try {
    assert.equal(result.success, true);
    assert.match(result.output, /done/);
    assert.ok(Date.now() - startedAt < 10_000, `returned in ${Date.now() - startedAt} ms`);
  } finally {
    killQuietly(pid);
  }
});

test("bash: a stop ends a call whose detached child holds our pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myclaw-detach-"));
  const pidFile = join(dir, "pid");
  const c = new AbortController();
  const startedAt = Date.now();
  // The shell stays alive, so the stop lands mid-call whatever the machine's speed: a call that
  // returned before the abort would prove nothing.
  const p = bashTool.execute({ command: `${detached("exec sleep 60", pidFile)}; sleep 30`, __signal: c.signal });
  const pid = await pidOf(pidFile);
  c.abort();
  try {
    await assert.rejects(() => p, AbortedError);
    assert.ok(Date.now() - startedAt < 10_000, `returned in ${Date.now() - startedAt} ms`);
    if (canScope()) {
      // In a scope the whole cgroup goes: the child the command detached included. Polled, because
      // the kill is a signal travelling through systemd as well as through our own scan.
      let alive = true;
      for (let i = 0; i < 60 && alive; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try { process.kill(pid!, 0); } catch { alive = false; }
      }
      assert.equal(alive, false, "the detached child is gone");
    }
  } finally {
    killQuietly(pid);
  }
});

test("bash: the wall ends a call whose detached child holds our pipes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "myclaw-detach-"));
  const pidFile = join(dir, "pid");
  const startedAt = Date.now();
  // The shell has to still be there when the wall lands, while its detached child holds the pipes.
  const result = await bashTool.execute({ command: `${detached("exec sleep 60", pidFile)}; sleep 30`, timeout: 1000 });
  const pid = await pidOf(pidFile);
  try {
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /timed out/i);
    assert.ok(Date.now() - startedAt < 10_000, `returned in ${Date.now() - startedAt} ms`);
  } finally {
    killQuietly(pid);
  }
});
