import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "packaging", "install-node.sh");
const dash = Bun.which("dash");

function run(shell: string) {
  const result = Bun.spawnSync({ cmd: [shell, script], stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe("the node installer, piped into the machine's own shell", () => {
  test("runs under dash: the usage path is reached, the header does not fall over", () => {
    if (!dash) return;
    const result = run(dash);
    expect(result.err).not.toContain("Illegal option");
    expect(result.err).toContain("Usage:");
    expect(result.code).toBe(1);
  });

  test("carries nothing a plain sh cannot run", () => {
    const code = readFileSync(script, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("pipefail");
    expect(code).not.toMatch(/\[@\]/);
    expect(code).not.toMatch(/^\s*local\s/m);
    expect(code).not.toMatch(/\[\[/);
  });

  test("rejects an unknown option instead of reading it as a shell construct", () => {
    if (!dash) return;
    const result = Bun.spawnSync({ cmd: [dash, script, "--nope"], stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unknown option --nope");
  });
});
