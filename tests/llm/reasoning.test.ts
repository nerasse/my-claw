import { describe, expect, test } from "bun:test";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { chatCompletion, chatCompletionStream, readReasoning } from "../../src/llm/provider.ts";

const config = {
  baseUrl: "https://example.com",
  model: "base-model",
  apiKey: "token",
};

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

async function streamWith(chunks: unknown[]): Promise<{ reasoning: string[]; text: string; returned?: string }> {
  const fetchMock = mockFetch(async () =>
    new Response(sse(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
  );
  try {
    const reasoning: string[] = [];
    let text = "";
    const response = await chatCompletionStream(
      config,
      [{ role: "user", content: "hi" }],
      (token) => {
        text += token;
      },
      undefined,
      undefined,
      { onText: async (delta) => void reasoning.push(delta) },
    );
    return { reasoning, text, returned: response.reasoning };
  } finally {
    fetchMock.restore();
  }
}

describe("readReasoning field fallback", () => {
  // Order matters: some proxies send two of these carrying the same text, and concatenating both
  // would double every thought. See docs/reasoning-visibility.md.
  test("reads reasoning_content, the DeepSeek and opencode-go name", () => {
    expect(readReasoning({ reasoning_content: "pondering" })).toBe("pondering");
  });

  test("falls back to reasoning, which OpenRouter uses", () => {
    expect(readReasoning({ reasoning: "pondering" })).toBe("pondering");
  });

  test("falls back to reasoning_text", () => {
    expect(readReasoning({ reasoning_text: "pondering" })).toBe("pondering");
  });

  test("two fields with the same text yield it once, not twice", () => {
    expect(readReasoning({ reasoning_content: "once", reasoning: "once" })).toBe("once");
  });

  test("the most specific field wins when they disagree", () => {
    expect(readReasoning({ reasoning_content: "specific", reasoning: "generic" })).toBe("specific");
  });

  test("an empty field is skipped rather than ending the search", () => {
    expect(readReasoning({ reasoning_content: "", reasoning: "real" })).toBe("real");
  });

  test("no reasoning at all reads as empty, which is a normal model", () => {
    expect(readReasoning({ content: "hello" })).toBe("");
    expect(readReasoning(undefined)).toBe("");
  });
});

describe("chatCompletionStream reasoning", () => {
  test("reasoning_content deltas reach the sink and never the text callback", async () => {
    const { reasoning, text } = await streamWith([
      { choices: [{ delta: { reasoning_content: "let me " } }] },
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { content: "answer" } }] },
    ]);
    expect(reasoning.join("")).toBe("let me think");
    expect(text).toBe("answer");
  });

  test("the accumulated reasoning comes back on the response, for persistence", async () => {
    const { returned } = await streamWith([
      { choices: [{ delta: { reasoning_content: "a" } }] },
      { choices: [{ delta: { reasoning_content: "b" } }] },
      { choices: [{ delta: { content: "done" } }] },
    ]);
    expect(returned).toBe("ab");
  });

  test("a model that reasons silently leaves the field absent, not empty", async () => {
    const { reasoning, returned } = await streamWith([{ choices: [{ delta: { content: "plain" } }] }]);
    expect(reasoning).toEqual([]);
    expect(returned).toBeUndefined();
  });

  test("a stream with no sink still parses, so the chat channels are unaffected", async () => {
    const fetchMock = mockFetch(async () =>
      new Response(sse([{ choices: [{ delta: { reasoning_content: "quiet" } }] }, { choices: [{ delta: { content: "hi" } }] }]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as never,
    );
    try {
      let text = "";
      const response = await chatCompletionStream(config, [{ role: "user", content: "hi" }], (t) => {
        text += t;
      });
      expect(text).toBe("hi");
      expect(response.reasoning).toBe("quiet");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("chatCompletionStream cuts the answer where the thinking restarted", () => {
  async function segmentsOf(chunks: unknown[]) {
    const fetchMock = mockFetch(async () =>
      new Response(sse(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } }) as never,
    );
    try {
      // The duration is measured off the real clock and belongs to the transport that streamed
      // it, so it is dropped here: this suite pins where the cuts are, not how long a phase took
      // (that lives in tests/channels/reasoning-segments.test.ts, with a pinned clock).
      const segments = (await chatCompletionStream(config, [{ role: "user", content: "hi" }], () => {})).segments;
      return segments?.map(({ reasoning, content }) => ({
        ...(reasoning !== undefined ? { reasoning } : {}),
        content,
      }));
    } finally {
      fetchMock.restore();
    }
  }

  test("one thinking phase is not a split, so nothing is stored", async () => {
    const segments = await segmentsOf([
      { choices: [{ delta: { reasoning_content: "weighing" } }] },
      { choices: [{ delta: { content: "answer" } }] },
    ]);
    expect(segments).toBeUndefined();
  });

  test("thinking again after answering opens a second phase", async () => {
    const segments = await segmentsOf([
      { choices: [{ delta: { reasoning_content: "first thought" } }] },
      { choices: [{ delta: { content: "first answer" } }] },
      { choices: [{ delta: { reasoning_content: "second thought" } }] },
      { choices: [{ delta: { content: "second answer" } }] },
    ]);
    expect(segments).toEqual([
      { reasoning: "first thought", content: "first answer" },
      { reasoning: "second thought", content: "second answer" },
    ]);
  });

  test("deltas of one phase stay in it, however many arrive", async () => {
    const segments = await segmentsOf([
      { choices: [{ delta: { content: "one " } }] },
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: { reasoning_content: "now " } }] },
      { choices: [{ delta: { reasoning_content: "thinking" } }] },
      { choices: [{ delta: { content: "the rest" } }] },
    ]);
    expect(segments).toEqual([
      { content: "one answer" },
      { reasoning: "now thinking", content: "the rest" },
    ]);
  });

  test("a phase that thought and then stopped is still a phase", async () => {
    const segments = await segmentsOf([
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: { reasoning_content: "about to call a tool" } }] },
    ]);
    expect(segments).toEqual([{ content: "answer" }, { reasoning: "about to call a tool", content: "" }]);
  });

  test("the whole answer still comes back merged, since that is what a model reads", async () => {
    const fetchMock = mockFetch(async () =>
      new Response(
        sse([
          { choices: [{ delta: { content: "first" } }] },
          { choices: [{ delta: { reasoning_content: "again" } }] },
          { choices: [{ delta: { content: " second" } }] },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ) as never,
    );
    try {
      const response = await chatCompletionStream(config, [{ role: "user", content: "hi" }], () => {});
      expect(response.content).toBe("first second");
      expect(response.reasoning).toBe("again");
    } finally {
      fetchMock.restore();
    }
  });
});

test("chatCompletion carries reasoning on the non-streaming path", async () => {
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hello", reasoning_content: "thought about it" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );
  try {
    const response = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    expect(response.content).toBe("hello");
    expect(response.reasoning).toBe("thought about it");
  } finally {
    fetchMock.restore();
  }
});

/**
 * Reasoning is stored whole. It never goes back to the model (`toChatMessages` maps content and
 * tool calls, nothing else), so the only thing a ceiling ever bought was disk, at the price of a
 * thought that stops mid-sentence.
 */
test("a long chain of thought is kept whole, not cut", async () => {
  const long = "x".repeat(50_000);
  const fetchMock = mockFetch(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "hello", reasoning: long } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never,
  );
  try {
    const response = await chatCompletion(config, [{ role: "user", content: "hi" }]);
    expect(response.reasoning).toBe(long);
  } finally {
    fetchMock.restore();
  }
});
