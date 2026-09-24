import { describe, test, expect } from "bun:test";
import { chatCompletion, chatCompletionStream } from "../../src/llm/provider.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const config = {
  provider: "x",
  baseUrl: "https://example.com",
  model: "base-model",
  apiKey: "token",
};

describe("chatCompletion", () => {
  test("parses content and tool calls", async () => {
    const mock = mockFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "hello",
                tool_calls: [
                  {
                    id: "tc1",
                    function: { name: "demo", arguments: '{"x":1}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));

    try {
      const result = await chatCompletion(config, [{ role: "user", content: "hi" }]);
      expect(result.content).toBe("hello");
      expect(result.toolCalls).toEqual([{ id: "tc1", name: "demo", arguments: { x: 1 } }]);
    } finally {
      mock.restore();
    }
  });

  test("sends reasoning_effort only when config.effort is set", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }]);
      expect(capturedBodies[0]!.reasoning_effort).toBeUndefined();

      await chatCompletion({ ...config, effort: "xhigh" }, [{ role: "user", content: "hi" }]);
      expect(capturedBodies[1]!.reasoning_effort).toBe("xhigh");
    } finally {
      mock.restore();
    }
  });

  test("serializes array content with image_url", async () => {
    const capturedBodies: unknown[] = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      capturedBodies.push(body);

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "I see it" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const messages = [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "What is this?" },
            { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,abc123" } },
          ],
        },
      ];

      const result = await chatCompletion(config, messages);
      expect(result.content).toBe("I see it");
      expect(capturedBodies.length).toBe(1);

      const body = capturedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages.length).toBe(1);
      expect(body.messages[0]!.role).toBe("user");
      expect(Array.isArray(body.messages[0]!.content)).toBe(true);
      expect((body.messages[0]!.content as Array<{ type: string }>)[0]!.type).toBe("text");
      expect((body.messages[0]!.content as Array<{ type: string }>)[1]!.type).toBe("image_url");
    } finally {
      mock.restore();
    }
  });
});

describe("chatCompletionStream", () => {
  test("parses SSE tokens and streamed tool calls", async () => {
    const encoder = new TextEncoder();
    const chunk1 = JSON.stringify({ choices: [{ delta: { content: "hel" } }] });
    const chunk2 = JSON.stringify({
      choices: [{ delta: { content: "lo", tool_calls: [{ index: 0, id: "tc1", function: { name: "demo", arguments: '{"x":' } }] } }],
    });
    const chunk3 = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
    });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${chunk1}\n`));
        controller.enqueue(encoder.encode(`data: ${chunk2}\n`));
        controller.enqueue(encoder.encode(`data: ${chunk3}\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });

    const mock = mockFetch(async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));

    try {
      const tokens: string[] = [];
      const result = await chatCompletionStream(
        config,
        [{ role: "user", content: "hi" }],
        async (token) => {
          tokens.push(token);
        },
      );

      expect(tokens).toEqual(["hel", "lo"]);
      expect(result.content).toBe("hello");
      expect(result.toolCalls).toEqual([{ id: "tc1", name: "demo", arguments: { x: 1 } }]);
    } finally {
      mock.restore();
    }
  });
});

type WireMessage = { role: string; content: unknown; tool_call_id?: string };

async function sentMessages(
  messages: Parameters<typeof chatCompletion>[1],
  opts: { stream?: boolean; promptCache?: boolean } = {},
): Promise<WireMessage[]> {
  let body: Record<string, unknown> | undefined;
  const mock = mockFetch(async (_u, init) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (opts.stream) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const cfg = { ...config, ...(opts.promptCache ? { promptCache: true } : {}) };
    if (opts.stream) await chatCompletionStream(cfg, messages, () => undefined);
    else await chatCompletion(cfg, messages);
  } finally {
    mock.restore();
  }
  return (body as { messages: WireMessage[] }).messages;
}

const png = (tag: string) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${tag}` } });
const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const partTypes = (m: WireMessage) => (m.content as Array<{ type: string }>).map((p) => p.type);
const urls = (m: WireMessage) =>
  (m.content as Array<{ type: string; image_url?: { url: string } }>).flatMap((p) => (p.image_url ? [p.image_url.url] : []));

// The chat-completions spec types a tool message's content as `string | Array<text part>`: no image.
// A strict upstream enforces it -- OpenCode Go routed some sessions of deepseek-v4.1-flash to one
// that answers 422 "messages.3.tool.content.str: Input should be a valid string" (measured
// 2026-09-24), and since the same session keeps landing on the same upstream, every retry failed
// the same way. The images travel in a user turn right after the tool results instead.
test("a tool's images leave the tool message, which keeps its text, and follow in one user turn", async () => {
  const messages = await sentMessages([
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("tc1", "read")] },
    { role: "tool", tool_call_id: "tc1", content: [{ type: "text", text: "Image read successfully" }, png("AAAA")] },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect(messages[2]!.content).toBe("Image read successfully");
  expect(urls(messages[3]!)).toEqual(["data:image/png;base64,AAAA"]);
  expect(JSON.stringify(messages[3]!.content)).toContain("read");
  expect(JSON.stringify(messages[3]!.content)).toContain("tc1");
});

test("the tool results of one turn stay together: the images come after the last of them", async () => {
  const messages = await sentMessages([
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("a", "read"), call("b", "bash"), call("c", "browser_screenshot")] },
    { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "Image read" }, png("A")] },
    { role: "tool", tool_call_id: "b", content: "ls output" },
    { role: "tool", tool_call_id: "c", content: [{ type: "text", text: "Screenshot captured" }, png("C")] },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "tool", "user"]);
  expect(messages.slice(2, 5).every((m) => typeof m.content === "string")).toBe(true);
  expect(urls(messages[5]!)).toEqual(["data:image/png;base64,A", "data:image/png;base64,C"]);
});

test("each turn's images follow that turn, not the end of the prompt", async () => {
  const messages = await sentMessages([
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("a", "read")] },
    { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "first" }, png("A")] },
    { role: "assistant", content: "", tool_calls: [call("b", "read")] },
    { role: "tool", tool_call_id: "b", content: [{ type: "text", text: "second" }, png("B")] },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool", "user"]);
  expect(urls(messages[3]!)).toEqual(["data:image/png;base64,A"]);
  expect(urls(messages[6]!)).toEqual(["data:image/png;base64,B"]);
});

test("a tool that returned only an image still answers its call with text", async () => {
  const messages = await sentMessages([
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("a", "read")] },
    { role: "tool", tool_call_id: "a", content: [png("A")] },
  ]);
  expect(typeof messages[2]!.content).toBe("string");
  expect((messages[2]!.content as string).length).toBeGreaterThan(0);
});

test("a prompt without tool images goes out as it was", async () => {
  const messages = await sentMessages([
    { role: "user", content: [{ type: "text", text: "look" }, png("U")] },
    { role: "assistant", content: "", tool_calls: [call("a", "bash")] },
    { role: "tool", tool_call_id: "a", content: "done" },
  ]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(partTypes(messages[0]!)).toEqual(["text", "image_url"]);
  expect(messages[2]!.content).toBe("done");
});

test("the stream and the cache hints send the same shape", async () => {
  const prompt: Parameters<typeof chatCompletion>[1] = [
    { role: "user", content: "look" },
    { role: "assistant", content: "", tool_calls: [call("a", "read")] },
    { role: "tool", tool_call_id: "a", content: [{ type: "text", text: "Image read" }, png("A")] },
  ];
  for (const opts of [{ stream: true }, { promptCache: true }, { stream: true, promptCache: true }]) {
    const messages = await sentMessages(prompt, opts);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const tool = messages[2]!.content;
    const toolText = typeof tool === "string" ? tool : (tool as Array<{ type: string }>).every((p) => p.type === "text");
    expect(toolText).toBeTruthy();
    expect(urls(messages[3]!)).toEqual(["data:image/png;base64,A"]);
  }
});
