import { test, expect } from "bun:test";
import { withRunContext, currentRunId, currentRun, setRunSession } from "../../src/utils/run-context.ts";

test("a run id is visible from anywhere inside the run, including after an await", async () => {
  expect(currentRunId()).toBeUndefined();

  const seen: Array<string | undefined> = [];
  await withRunContext({ platform: "mobile" }, async () => {
    seen.push(currentRunId());
    await new Promise((r) => setTimeout(r, 1));
    // The point of the async storage: nested async work inherits the id without plumbing.
    await (async () => {
      seen.push(currentRunId());
    })();
  });

  expect(seen[0]).toMatch(/^[0-9a-f]{8}$/);
  expect(seen[1]).toBe(seen[0]!);
  expect(currentRunId()).toBeUndefined();
});

test("concurrent runs never share their id", async () => {
  const ids = await Promise.all(
    [1, 2, 3].map(() =>
      withRunContext({ platform: "mobile" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentRunId()!;
      }),
    ),
  );

  expect(new Set(ids).size).toBe(3);
});

test("the session id lands on the context once the router resolves it", async () => {
  await withRunContext({ platform: "telegram" }, async () => {
    expect(currentRun()?.sessionId).toBeUndefined();
    setRunSession("telegram/chat/1");
    expect(currentRun()?.sessionId).toBe("telegram/chat/1");
  });
});

test("setting a session outside a run is a no-op rather than a crash", () => {
  setRunSession("nowhere");
  expect(currentRun()).toBeUndefined();
});
