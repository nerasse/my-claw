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
