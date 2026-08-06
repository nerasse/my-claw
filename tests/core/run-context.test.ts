import { test, expect } from "bun:test";
import { withRunContext, currentRunId, currentRun, setRunSession } from "../../src/utils/run-context.ts";

test("a run id is visible from anywhere inside the run, including after an await", async () => {
  expect(currentRunId()).toBeUndefined();

  const seen: Array<string | undefined> = [];
  await withRunContext({ platform: "my-claw-app" }, async () => {
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
      withRunContext({ platform: "my-claw-app" }, async () => {
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

test("a nested open reuses the id instead of minting a second one for the same message", async () => {
  // The channel opens the context at ingress, the router opens it again on the way through:
  // two ids for one message would make the logs of a single run impossible to pull.
  const seen: string[] = [];
  await withRunContext({ platform: "my-claw-app" }, async () => {
    seen.push(currentRunId()!);
    await withRunContext({ platform: "my-claw-app" }, async () => {
      seen.push(currentRunId()!);
    });
    seen.push(currentRunId()!);
  });

  expect(new Set(seen).size).toBe(1);
});

test("work that outlives the router still belongs to the run", async () => {
  // The real bug this guards: a short reply is flushed by streamer.finish() after route()
  // returned, so the frame carried no run id and the behaviour depended on the answer length.
  let afterRoute: string | undefined;
  await withRunContext({ platform: "my-claw-app" }, async () => {
    await (async () => {
      /* the routing itself */
    })();
    await new Promise((r) => setTimeout(r, 1));
    afterRoute = currentRunId();
  });

  expect(afterRoute).toMatch(/^[0-9a-f]{8}$/);
});
