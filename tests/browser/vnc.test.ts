import { test, describe } from "bun:test";
import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeVncPassword, readVncPassword } from "../../src/browser/vnc.ts";

/** Captured from the real `x11vnc -storepasswd`, not from this module: a fixture built with the
 *  same code it verifies would agree with any key, including a wrong one. */
const GOLDEN: Array<{ password: string; stored: string }> = [
  { password: "test1234", stored: "70685069802a5e92" },
  { password: "abc", stored: "9c0a172d3482e122" },
  { password: "LongerTh", stored: "1ad5e6c88cd63f22" },
];

describe("VNC password file", () => {
  test("decodes what x11vnc actually wrote", () => {
    for (const { password, stored } of GOLDEN) {
      assert.strictEqual(decodeVncPassword(Buffer.from(stored, "hex")), password, `for ${stored}`);
    }
  });

  test("only the first eight characters are stored at all", () => {
    // "LongerThan8Chars" was handed to x11vnc; what came back is "LongerTh". Anyone showing this
    // password in a UI has to know a longer one is silently cut, not merely weakly hashed.
    const long = GOLDEN.find((g) => g.password === "LongerTh");
    assert.ok(long);
    assert.strictEqual(decodeVncPassword(Buffer.from(long.stored, "hex")).length, 8);
  });

  test("a missing file reads as absent, not as a failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vnc-"));
    assert.strictEqual(await readVncPassword(join(dir, "nothing-here")), null);
  });

  test("a file that is not a password file reads as absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vnc-"));
    const path = join(dir, "passwd");
    await writeFile(path, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    // Decoding succeeds on any 8 bytes; it is the printable check that rejects this one, so a
    // page never shows control characters as though they were a password.
    assert.strictEqual(await readVncPassword(path), null);
  });

  test("a truncated file is refused rather than padded into a wrong answer", () => {
    assert.throws(() => decodeVncPassword(Buffer.from("7068", "hex")), /shorter than one DES block/);
  });
});
