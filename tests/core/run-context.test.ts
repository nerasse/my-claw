import { test, expect } from "bun:test";
import { withRunContext, withChildRunContext, currentRunId, currentRun, setRunSession } from "../../src/utils/run-context.ts";

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

test("a child context names its own run and keeps the root: a sub-agent's run is a run of its own on the wire", async () => {
  // Two runs of the same sub-agent inside one parent run used to share the parent's id on the
  // child's thread: the page folded them as one run. The root id stays for the logs, which is
  // what one quoted id pulling the whole tree needs.
  await withRunContext({ platform: "my-claw-app" }, async () => {
    const parent = currentRunId()!;
    const bubbles = currentRun()!.bubbles;
    const children = await Promise.all([
      withChildRunContext(async () => ({ id: currentRunId()!, root: currentRun()!.rootRunId, bubbles: currentRun()!.bubbles })),
      withChildRunContext(async () => ({ id: currentRunId()!, root: currentRun()!.rootRunId, bubbles: currentRun()!.bubbles })),
    ]);
    expect(children[0].id).not.toBe(parent);
    expect(children[1].id).not.toBe(parent);
    expect(children[0].id).not.toBe(children[1].id);
    expect(children[0].root).toBe(parent);
    expect(children[1].root).toBe(parent);
    // The bubble sinks a parent registered for its child are read by the child: same map.
    expect(children[0].bubbles).toBe(bubbles);
    // Back in the parent, nothing moved.
    expect(currentRunId()).toBe(parent);
    expect(currentRun()!.rootRunId).toBe(parent);
  });
});

test("a child context outside any run is a root of its own", async () => {
  await withChildRunContext(async () => {
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}$/);
    expect(currentRun()!.rootRunId).toBe(currentRunId()!);
  });
});
