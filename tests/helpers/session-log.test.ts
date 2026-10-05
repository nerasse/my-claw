import { test, expect } from "bun:test";
import { setupSessionLog } from "./session-log.ts";
import { openSessionLog } from "../../src/sessions/log.ts";

// Same id in every test of a file, cleanup in afterEach: what the last test appended without
// waiting must not open the next test's log.
test("appends still in flight at cleanup never reach the next setup of the same id", async () => {
  for (let round = 0; round < 20; round++) {
    const first = await setupSessionLog("test-helper-reuse");
    for (let i = 0; i < 50; i++) first.log.append({ type: "user", prompt: true, text: `old ${i}` });
    first.cleanup();
    const second = await setupSessionLog("test-helper-reuse");
    try {
      expect(second.log.entries()).toEqual([]);
      expect((await openSessionLog("test-helper-reuse")).entries()).toEqual([]);
    } finally {
      second.cleanup();
    }
  }
});
