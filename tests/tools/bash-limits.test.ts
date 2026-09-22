/**
 * The box one bash call runs in -- docs/bash-limits.md.
 *
 * Written after 2026-09-22, when one command that wanted the whole machine took the server with
 * it: `Bun.spawn(["setsid", "bash", ...])` had a wall and no memory ceiling, and the server's own
 * `oom_score_adj 200` made it the kernel's preferred victim.
 */

import { describe, test, expect } from "bun:test";
import { bashArgvFor, bashTool, memoryLabel, setBashLimits, resetBashScopeProbe, type BashLimits } from "../../src/tools/bash.ts";

const LIMITS: BashLimits = {
  memoryMaxBytes: 8 * 1024 * 1024 * 1024,
  swapMaxBytes: 2 * 1024 * 1024 * 1024,
  tasksMax: 512,
  cgroup: true,
};

describe("bashArgvFor", () => {
  test('the command rides as $0, never interpolated', () => {
    const argv = bashArgvFor('echo "$HOME" | wc -l', true, LIMITS);
    // The last argument is the command verbatim: quoting survives whatever it contains.
    expect(argv[argv.length - 1]).toBe('echo "$HOME" | wc -l');
    expect(argv).toContain('echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec bash -c "$0"');
  });

  test('a scoped call carries the three ceilings', () => {
    const argv = bashArgvFor("true", true, LIMITS);
    expect(argv.slice(0, 2)).toEqual(["setsid", "systemd-run"]);
    expect(argv).toContain("MemoryMax=8589934592");
    expect(argv).toContain("MemorySwapMax=2147483648");
    expect(argv).toContain("TasksMax=512");
  });

  test('zero means two different things, and each is sent as itself', () => {
    // memoryMaxBytes 0 = no ceiling at all (systemd spells that `infinity`); swapMaxBytes 0 = no
    // swap, which is the default's whole point: the machine's swap is the server's reserve.
    const argv = bashArgvFor("true", true, { ...LIMITS, memoryMaxBytes: 0, swapMaxBytes: 0, tasksMax: 0 });
    expect(argv).toContain("MemoryMax=infinity");
    expect(argv).toContain("MemorySwapMax=0");
    expect(argv).toContain("TasksMax=infinity");
  });

  test('cgroup off, or a host with no user bus, runs exactly the bare spawn of always', () => {
    expect(bashArgvFor("true", true, { ...LIMITS, cgroup: false })).toEqual(["setsid", "bash", "-c", "true"]);
    expect(bashArgvFor("true", false, LIMITS)).toEqual(["setsid", "bash", "-c", "true"]);
  });
});

test("the memory ceiling is named the way the config names it", () => {
  expect(memoryLabel(8 * 1024 * 1024 * 1024)).toBe("8 GiB");
  expect(memoryLabel(64 * 1024 * 1024)).toBe("0.1 GiB");
});

describe("what a killed call says", () => {
  test("a SIGKILL says so, and blames the ceiling only when there is one", async () => {
    // `kill -9` is what an OOM kill and an external killifier both look like from here.
    const result = await bashTool.execute({ command: "kill -9 $$" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Killed (SIGKILL)");
    expect(result.error).toContain("killed externally");
    expect(result.error).toContain("tools.bash.memoryMaxBytes");
    // The wall is named, not blamed on memory: they all end in SIGKILL.
    expect(result.error).not.toContain("timed out");
  });

  test("the wall says timeout, never memory", async () => {
    const result = await bashTool.execute({ command: "sleep 5", timeout: 400 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Command timed out after 0 s");
    expect(result.error).not.toContain("memory limit");
  });
});

/**
 * The real thing, on a host with a user systemd bus. Gated: CI has no such bus (the probe says
 * no and every call runs bare), so this only ever runs when someone asks for it.
 */
if (process.env["BASH_CGROUP_E2E"] === "1") {
  test("a command that wants the whole machine dies at its ceiling, alone", async () => {
    resetBashScopeProbe();
    setBashLimits({ memoryMaxBytes: 64 * 1024 * 1024, swapMaxBytes: 0, tasksMax: 512 });
    // ~400 MB of shell variable: a fifth of the host, five times over the ceiling. `yes`, not
    // /dev/zero: bash truncates a variable at the first NUL byte, so zeroes allocate nothing.
    const result = await bashTool.execute({ command: 'x=$(yes | head -c 400M); echo "survived ${#x}"' });
    setBashLimits(undefined);
    expect(result.success).toBe(false);
    expect(result.error).toContain("hit its memory limit (0.1 GiB)");
    // The proof it died at the ceiling and not of fright: without the scope the same command
    // prints its length and succeeds (see the falsification in the commit message).
  }, 60_000);
}
