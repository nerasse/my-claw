/**
 * The bare-metal installer on fresh machines (tests-install/, docs/install-test.md). Needs Docker
 * and the network, takes ~10 minutes a machine: run by hand,
 *   packaging/build-tar.sh && INSTALL_E2E=1 bun test tests-e2e/install
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const gate = process.env.INSTALL_E2E === "1" ? describe : describe.skip;
const script = join(import.meta.dir, "..", "..", "tests-install", "run.sh");

gate("bare-metal install on a fresh machine", () => {
  for (const machine of ["debian12", "ubuntu2404"]) {
    test(machine, async () => {
      const proc = Bun.spawn(["bash", script, machine], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code !== 0) console.log(out);
      expect(out).toContain(`PASS [${machine}]`);
      expect(code).toBe(0);
    }, 30 * 60_000);
  }
});
