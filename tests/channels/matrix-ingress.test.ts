import { describe, test, expect } from "bun:test";
import { prepareTimelineEvent, buildTimelineIngress } from "../../src/channels/matrix/ingress.ts";

function mockEvent(overrides: Record<string, unknown> = {}) {
  return {
    getContent: () => overrides.content ?? { msgtype: "m.text", body: "hello" },
    isRelation: (relType: string) => overrides.isReplace === true && relType === "m.replace",
    getId: () => overrides.eventId ?? "$evt1",
    getRelation: () => overrides.relation ?? undefined,
    getThread: () => undefined,
    ...overrides,
  } as never;
}

function mockRoom(roomId = "!room:test") {
  return { roomId } as never;
}

describe("prepareTimelineEvent", () => {
  const resolveInboundThreadId = () => undefined;

  test("normal m.room.message returns prepared event with text", async () => {
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent({ content: { msgtype: "m.text", body: "hi there" } }),
      eventType: "m.room.message",
      chatType: "dm",
      resolveInboundThreadId,
    });
    expect(result).toBeDefined();
    expect(result!.text).toBe("hi there");
    expect(result!.isPollEvent).toBe(false);
  });

  test("non-message non-poll event type returns undefined", async () => {
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent(),
      eventType: "m.room.member",
      chatType: "dm",
      resolveInboundThreadId,
    });
    expect(result).toBeUndefined();
  });

  test("m.replace relation returns undefined", async () => {
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent({ isReplace: true }),
      eventType: "m.room.message",
      chatType: "dm",
      resolveInboundThreadId,
    });
    expect(result).toBeUndefined();
  });

  test("poll start event returns prepared with poll text", async () => {
    const pollContent = {
      "m.poll.start": {
        question: { "m.text": "Favorite?" },
        answers: [
          { id: "a", "m.text": "Alpha" },
          { id: "b", "m.text": "Beta" },
        ],
        kind: "m.poll.disclosed",
        max_selections: 1,
      },
    };
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent({ content: pollContent }),
      eventType: "m.poll.start",
      chatType: "group",
      resolveInboundThreadId,
    });
    expect(result).toBeDefined();
    expect(result!.isPollEvent).toBe(true);
    expect(result!.text).toContain("[Poll]");
    expect(result!.text).toContain("Favorite?");
  });

  test("poll response event returns prepared with empty text", async () => {
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent({ content: { "m.poll.response": { answers: ["a"] } } }),
      eventType: "m.poll.response",
      chatType: "group",
      resolveInboundThreadId,
    });
    expect(result).toBeDefined();
    expect(result!.isPollEvent).toBe(true);
    expect(result!.text).toBe("");
  });

  test("text extracted from content body", async () => {
    const result = await prepareTimelineEvent({
      room: mockRoom(),
      event: mockEvent({ content: { msgtype: "m.text", body: "extracted body" } }),
      eventType: "m.room.message",
      chatType: "dm",
      resolveInboundThreadId,
    });
    expect(result).toBeDefined();
    expect(result!.text).toBe("extracted body");
    expect(result!.content).toEqual({ msgtype: "m.text", body: "extracted body" });
  });
});

describe("buildTimelineIngress", () => {
  const baseContext = {
    resolveRoomConfig: () => ({}),
    isRoomAllowed: () => true,
    isAllowedByPolicy: () => true,
    selfDisplayNameForRoom: () => "Bot",
    resolveInboundThreadId: () => undefined,
    shouldProcessRoomMessage: () => true,
    resolvePendingRoomHistoryText: () => "",
    roomHistory: { recordPending: () => {}, prepareTrigger: () => undefined },
  } as never;

  const baseParams = {
    room: mockRoom(),
    event: mockEvent({ content: { msgtype: "m.text", body: "test msg" } }),
    eventType: "m.room.message",
    sender: "@user:test",
    chatType: "dm" as const,
    historyLimit: 0,
    fetchPollSnapshot: async () => undefined,
    sdk: {},
  };

  test("disallowed room returns undefined", async () => {
    const context = {
      ...Object.fromEntries(
        Object.entries(baseContext as Record<string, unknown>),
      ),
      isRoomAllowed: () => false,
      isAllowedByPolicy: () => true,
      resolveRoomConfig: () => ({}),
    } as never;
    const result = await buildTimelineIngress({ ...baseParams, context });
    expect(result).toBeUndefined();
  });

  test("disallowed sender returns undefined", async () => {
    const context = {
      ...Object.fromEntries(
        Object.entries(baseContext as Record<string, unknown>),
      ),
      isRoomAllowed: () => true,
      isAllowedByPolicy: () => false,
      resolveRoomConfig: () => ({}),
    } as never;
    const result = await buildTimelineIngress({ ...baseParams, context });
    expect(result).toBeUndefined();
  });

  test("normal allowed message returns ingress with shouldProcess true", async () => {
    const result = await buildTimelineIngress({
      ...baseParams,
      context: baseContext,
    });
    expect(result).toBeDefined();
    expect(result!.shouldProcess).toBe(true);
    expect(result!.text).toBe("test msg");
  });
});
