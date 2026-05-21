import { describe, test, expect } from "bun:test";
import {
  isMatrixPollEventType,
  resolveMatrixPollPrecheckText,
  fetchMatrixPollSnapshot,
} from "../../src/channels/matrix/polls.ts";

describe("isMatrixPollEventType", () => {
  test("m.poll.start -> true", () => {
    expect(isMatrixPollEventType("m.poll.start")).toBe(true);
  });

  test("org.matrix.msc3381.poll.start -> true", () => {
    expect(isMatrixPollEventType("org.matrix.msc3381.poll.start")).toBe(true);
  });

  test("m.poll.response -> true", () => {
    expect(isMatrixPollEventType("m.poll.response")).toBe(true);
  });

  test("org.matrix.msc3381.poll.response -> true", () => {
    expect(isMatrixPollEventType("org.matrix.msc3381.poll.response")).toBe(true);
  });

  test("m.poll.end -> true", () => {
    expect(isMatrixPollEventType("m.poll.end")).toBe(true);
  });

  test("org.matrix.msc3381.poll.end -> true", () => {
    expect(isMatrixPollEventType("org.matrix.msc3381.poll.end")).toBe(true);
  });

  test("m.room.message -> false", () => {
    expect(isMatrixPollEventType("m.room.message")).toBe(false);
  });

  test("undefined -> false", () => {
    expect(isMatrixPollEventType(undefined)).toBe(false);
  });
});

describe("resolveMatrixPollPrecheckText", () => {
  test("poll start with valid question and answers", () => {
    const content = {
      "m.poll.start": {
        question: { "m.text": "What color?" },
        answers: [
          { id: "a1", "m.text": "Red" },
          { id: "a2", "m.text": "Blue" },
        ],
        kind: "m.poll.disclosed",
        max_selections: 1,
      },
    };
    expect(resolveMatrixPollPrecheckText("m.poll.start", content)).toBe(
      "[Poll]\nWhat color?\n\n1. Red\n2. Blue",
    );
  });

  test("poll start with MSC3381 format", () => {
    const content = {
      "org.matrix.msc3381.poll.start": {
        question: { "org.matrix.msc1767.text": "What?" },
        answers: [
          { id: "a1", body: "Yes" },
          { id: "a2", body: "No" },
        ],
      },
    };
    expect(resolveMatrixPollPrecheckText("org.matrix.msc3381.poll.start", content)).toBe(
      "[Poll]\nWhat?\n\n1. Yes\n2. No",
    );
  });

  test("non-poll-start type returns empty string", () => {
    const content = {
      "m.poll.start": {
        question: { "m.text": "What?" },
        answers: [{ id: "a1", "m.text": "Yes" }],
      },
    };
    expect(resolveMatrixPollPrecheckText("m.poll.response", content)).toBe("");
  });

  test("invalid content with no poll subtype returns empty string", () => {
    expect(resolveMatrixPollPrecheckText("m.poll.start", { body: "hello" })).toBe("");
  });

  test("poll with no answers returns empty string", () => {
    const content = {
      "m.poll.start": {
        question: { "m.text": "What?" },
        answers: [],
      },
    };
    expect(resolveMatrixPollPrecheckText("m.poll.start", content)).toBe("");
  });

  test("poll with empty question returns empty string", () => {
    const content = {
      "m.poll.start": {
        question: { "m.text": "" },
        answers: [{ id: "a1", "m.text": "Yes" }],
      },
    };
    expect(resolveMatrixPollPrecheckText("m.poll.start", content)).toBe("");
  });
});

describe("fetchMatrixPollSnapshot", () => {
  function makeMockClient(opts: {
    roomEvents?: Record<string, Record<string, unknown>>;
    relations?: Record<string, unknown>[];
  }) {
    return {
      fetchRoomEvent: async (_roomId: string, eventId: string) => {
        const ev = opts.roomEvents?.[eventId];
        if (!ev) throw new Error(`Event ${eventId} not found`);
        return ev;
      },
      fetchRelations: async (
        _roomId: string,
        _eventId: string,
        _relType?: string,
        _eventType?: string,
        _params?: { from?: string },
      ) => ({
        chunk: opts.relations ?? [],
        next_batch: undefined,
      }),
    } as never;
  }

  const pollStartContent = {
    "m.poll.start": {
      question: { "m.text": "Favorite fruit?" },
      answers: [
        { id: "apple", "m.text": "Apple" },
        { id: "banana", "m.text": "Banana" },
      ],
      kind: "m.poll.disclosed",
      max_selections: 1,
    },
  };

  const pollStartEvent = {
    event_id: "$poll1",
    sender: "@creator:test",
    type: "m.poll.start",
    origin_server_ts: 1000,
    content: pollStartContent,
  };

  test("poll start with no responses returns plain poll text", async () => {
    const client = makeMockClient({ relations: [] });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", pollStartEvent);
    expect(result).toBe("[Poll]\nFavorite fruit?\n\n1. Apple\n2. Banana");
  });

  test("poll start with responses returns results with vote counts", async () => {
    const client = makeMockClient({
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["apple"] } },
        },
        {
          event_id: "$resp2",
          sender: "@bob:test",
          type: "m.poll.response",
          origin_server_ts: 3000,
          content: { "m.poll.response": { answers: ["banana"] } },
        },
      ],
    });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", pollStartEvent);
    expect(result).toBe(
      "[Poll]\nFavorite fruit?\n\n1. Apple (1 vote)\n2. Banana (1 vote)\n\nTotal voters: 2",
    );
  });

  test("poll with end event shows closed", async () => {
    const client = makeMockClient({
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["apple"] } },
        },
        {
          event_id: "$end1",
          sender: "@creator:test",
          type: "m.poll.end",
          origin_server_ts: 5000,
          content: {},
        },
      ],
    });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", pollStartEvent);
    expect(result).toBe(
      "[Poll closed]\nFavorite fruit?\n\n1. Apple (1 vote)\n2. Banana (0 votes)\n\nTotal voters: 1",
    );
  });

  test("response event fetches root event first", async () => {
    const client = makeMockClient({
      roomEvents: {
        $poll1: pollStartEvent,
      },
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["banana"] } },
        },
      ],
    });
    const responseEvent = {
      event_id: "$resp1",
      sender: "@alice:test",
      type: "m.poll.response",
      origin_server_ts: 2000,
      content: {
        "m.relates_to": { event_id: "$poll1" },
        "m.poll.response": { answers: ["banana"] },
      },
    };
    const result = await fetchMatrixPollSnapshot(client, "!room:test", responseEvent);
    expect(result).toContain("Favorite fruit?");
    expect(result).toContain("Banana");
  });

  test("non-poll event type returns undefined", async () => {
    const client = makeMockClient({});
    const event = {
      event_id: "$msg1",
      sender: "@user:test",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { body: "hello" },
    };
    const result = await fetchMatrixPollSnapshot(client, "!room:test", event);
    expect(result).toBeUndefined();
  });

  test("multiple voters, last vote wins per sender", async () => {
    const client = makeMockClient({
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["apple"] } },
        },
        {
          event_id: "$resp2",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 3000,
          content: { "m.poll.response": { answers: ["banana"] } },
        },
        {
          event_id: "$resp3",
          sender: "@bob:test",
          type: "m.poll.response",
          origin_server_ts: 2500,
          content: { "m.poll.response": { answers: ["apple"] } },
        },
      ],
    });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", pollStartEvent);
    expect(result).toBe(
      "[Poll]\nFavorite fruit?\n\n1. Apple (1 vote)\n2. Banana (1 vote)\n\nTotal voters: 2",
    );
  });

  test("undisclosed poll hides votes until closed", async () => {
    const undisclosedContent = {
      "m.poll.start": {
        question: { "m.text": "Secret vote?" },
        answers: [
          { id: "yes", "m.text": "Yes" },
          { id: "no", "m.text": "No" },
        ],
        kind: "m.poll.undisclosed",
        max_selections: 1,
      },
    };
    const undisclosedEvent = {
      event_id: "$poll2",
      sender: "@creator:test",
      type: "m.poll.start",
      origin_server_ts: 1000,
      content: undisclosedContent,
    };
    const client = makeMockClient({
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["yes"] } },
        },
      ],
    });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", undisclosedEvent);
    expect(result).toContain("Responses are hidden until the poll closes.");
    expect(result).not.toContain("votes)");
  });

  test("redacted response events are ignored", async () => {
    const client = makeMockClient({
      relations: [
        {
          event_id: "$resp1",
          sender: "@alice:test",
          type: "m.poll.response",
          origin_server_ts: 2000,
          content: { "m.poll.response": { answers: ["apple"] } },
          unsigned: { redacted_because: { event_id: "$redact1" } },
        },
        {
          event_id: "$resp2",
          sender: "@bob:test",
          type: "m.poll.response",
          origin_server_ts: 3000,
          content: { "m.poll.response": { answers: ["banana"] } },
        },
      ],
    });
    const result = await fetchMatrixPollSnapshot(client, "!room:test", pollStartEvent);
    expect(result).toBe(
      "[Poll]\nFavorite fruit?\n\n1. Apple (0 votes)\n2. Banana (1 vote)\n\nTotal voters: 1",
    );
  });
});
