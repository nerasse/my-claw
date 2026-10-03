/**
 * The installs on fresh machines (tests-install/, docs/install-test.md). Needs Docker and the
 * network, ~10 minutes a scenario: run by hand,
 *   packaging/build-tar.sh && INSTALL_E2E=1 bun test tests-e2e/install
 * The upgrade scenario also needs an older release in dist/old/.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const gate = process.env.INSTALL_E2E === "1" ? describe : describe.skip;
const dir = join(import.meta.dir, "..", "..", "tests-install");

async function scenario(script: string, args: string[], pass: string): Promise<void> {
  const proc = Bun.spawn(["bash", join(dir, script), ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) console.log(out);
  expect(out).toContain(pass);
  expect(code).toBe(0);
}

gate("installs on fresh machines", () => {
  for (const machine of ["debian12", "ubuntu2404"]) {
    test(`bare metal, ${machine}`, () => scenario("run.sh", [machine], `PASS [${machine}]`), 30 * 60_000);
  }
  test("an owner on an older release, updated by their own updater", () => scenario("upgrade.sh", ["debian12"], "PASS [debian12] upgrade"), 30 * 60_000);
  test("compose", () => scenario("compose-run.sh", [], "PASS [compose]"), 30 * 60_000);
});
