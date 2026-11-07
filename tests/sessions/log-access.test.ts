import { describe, test, expect } from "bun:test";
import { sessionLogOf, setSessionLogResolver, resetSessionLogResolver } from "../../src/sessions/log-access.ts";
import { openSessionLog, type UserEntry } from "../../src/sessions/log.ts";
import { SessionManager } from "../../src/sessions/manager.ts";

describe("sessionLogOf", () => {
  test("without a manager, a run still writes its entries", async () => {
    // Deliberately functional rather than a throw: a bridge exercised without a manager is the
    // normal case in a test, and what it must never do is silently drop what a run produced.
    const entries = await sessionLogOf("log-access/unmanaged");
    entries.append<UserEntry>({ type: "user", prompt: true, text: "seul" });
    await entries.flush();
    expect((await (await openSessionLog("log-access/unmanaged")).all())).toHaveLength(1);
  });

  test("boot's resolver is what a run gets", async () => {
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const fromRun = await sessionLogOf("log-access/managed");
    expect(fromRun).toBe(await manager.logOf("log-access/managed"));
  });

  test("two runs on one conversation share a handle, and a leaf", async () => {
    // Two handles would each hold their own cursor and write past each other: the second one's
    // appends would chain onto a leaf the first had already moved.
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    const first = await sessionLogOf("log-access/shared");
    const entry = first.append<UserEntry>({ type: "user", prompt: true, text: "un" });
    const second = await sessionLogOf("log-access/shared");
    expect(second.leaf()).toBe(entry.id);
    const next = second.append<UserEntry>({ type: "user", prompt: true, text: "deux" });
    expect(next.parentId).toBe(entry.id);
    await first.flush();
  });

  test("the resolver is answered live, not snapshotted", async () => {
    // A log is opened on demand and evicted with its session, so an answer captured at boot would
    // be wrong by the first eviction.
    let asked = 0;
    setSessionLogResolver((sessionId) => {
      asked += 1;
      return openSessionLog(sessionId);
    });
    await sessionLogOf("log-access/live");
    await sessionLogOf("log-access/live");
    expect(asked).toBe(2);
  });

  test("the reset seam puts the unmanaged resolver back", async () => {
    const manager = new SessionManager();
    setSessionLogResolver((sessionId) => manager.logOf(sessionId));
    resetSessionLogResolver();
    expect(await sessionLogOf("log-access/reset")).not.toBe(await manager.logOf("log-access/reset"));
  });
});
