import { test, expect } from "bun:test";
import { attributionParent, type SessionData, type SubAgentMeta } from "../../src/sessions/store.ts";

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    id: "subagent/digger-c3d4",
    platform: "matrix",
    chatType: "group",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    ...over,
  };
}

function meta(over: Partial<SubAgentMeta> = {}): SubAgentMeta {
  return {
    displayName: "digger",
    type: "research",
    parentSessionId: "matrix/room/!creator:test",
    visibility: "global",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

test("attribution prefers the session that triggered this run over the creator", () => {
  const s = session({ meta: meta(), invokedBy: "telegram/dm/999" });
  // A global sub-agent can be driven from another chat, and that chat pays for the run.
  expect(attributionParent(s)).toBe("telegram/dm/999");
});

test("attribution falls back to the creator, then to itself", () => {
  expect(attributionParent(session({ meta: meta() }))).toBe("matrix/room/!creator:test");
  // A top-level chat has neither, and records itself so parent rollups stay complete.
  const chat = session({ id: "matrix/room/!x:test" });
  expect(attributionParent(chat)).toBe("matrix/room/!x:test");
});

test("a missing parent degrades to self rather than to another conversation", () => {
  // The failure mode that matters: never silently bill one chat for another's work.
  const s = session({ meta: meta({ parentSessionId: "" }) });
  expect(attributionParent(s)).toBe("subagent/digger-c3d4");
});
