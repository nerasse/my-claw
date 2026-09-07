import { describe, expect, test } from "bun:test";
import { chatCompletion, chatCompletionStream } from "../../src/llm/provider.ts";
import { sessionAffinityHeaders } from "../../src/llm/session-headers.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const SESSION = "my-claw-app:dm:device-1:neras:thread:37e36291-fb17-4523-b5bc-f4ec77194a70";

describe("sessionAffinityHeaders", () => {
  test("an opencode endpoint gets the header it refuses a request without", () => {
    const headers = sessionAffinityHeaders("https://opencode.ai/zen/go/v1", SESSION, "my-claw/1.2.3");
    expect(headers["x-opencode-session"]).toBeTruthy();
    expect(headers["x-opencode-client"]).toBe("my-claw");
    expect(headers["User-Agent"]).toBe("my-claw/1.2.3");
    // Not the raw id: the owner's device and thread ride in it, and the router only needs it stable.
    expect(headers["x-opencode-session"]).not.toContain("neras");
    expect(headers["x-opencode-session"]).not.toContain("37e36291");
  });

  test("the same conversation is the same value, twice, and two conversations differ", () => {
    const once = sessionAffinityHeaders("https://opencode.ai/zen/go/v1", SESSION, "my-claw/1.2.3");
    const twice = sessionAffinityHeaders("https://opencode.ai/zen/go/v1", SESSION, "my-claw/1.2.3");
    const other = sessionAffinityHeaders("https://opencode.ai/zen/go/v1", `${SESSION}-b`, "my-claw/1.2.3");
    expect(once["x-opencode-session"]).toBe(twice["x-opencode-session"]!);
    expect(once["x-opencode-session"]).not.toBe(other["x-opencode-session"]!);
  });

  test("another provider gets the affinity pair instead, never the opencode header", () => {
    const headers = sessionAffinityHeaders("https://litellm.example.com/v1", SESSION, "my-claw/1.2.3");
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["x-session-affinity"]).toBeTruthy();
    expect(headers["X-Session-Id"]).toBe(headers["x-session-affinity"]!);
    expect(headers["User-Agent"]).toBe("my-claw/1.2.3");
  });

  test("a run with no conversation behind it still names the caller, and claims no session", () => {
    const headers = sessionAffinityHeaders("https://opencode.ai/zen/go/v1", undefined, "my-claw/1.2.3");
    expect(headers["User-Agent"]).toBe("my-claw/1.2.3");
    expect(headers["x-opencode-session"]).toBeUndefined();
  });

  test("a subdomain of the endpoint counts, a lookalike domain does not", () => {
    expect(sessionAffinityHeaders("https://api.opencode.ai/v1", SESSION, "ua")["x-opencode-session"]).toBeTruthy();
    expect(sessionAffinityHeaders("https://opencode.ai.evil.test/v1", SESSION, "ua")["x-opencode-session"]).toBeUndefined();
  });
});

describe("the request the transport actually sends", () => {
  async function capture(baseUrl: string, stream: boolean): Promise<Headers> {
    const seen: Headers[] = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      const body = stream
        ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
        : JSON.stringify({ choices: [{ message: { content: "ok" } }] });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
      });
    });
    try {
      const config = { baseUrl, model: "kimi-k3", apiKey: "k", cacheKey: SESSION };
      if (stream) await chatCompletionStream(config, [{ role: "user", content: "hi" }], () => {});
      else await chatCompletion(config, [{ role: "user", content: "hi" }]);
      return seen[0]!;
    } finally {
      mock.restore();
    }
  }

  test("a call carries the session header, streamed or not", async () => {
    for (const stream of [false, true]) {
      const headers = await capture("https://opencode.ai/zen/go/v1", stream);
      expect(headers.get("x-opencode-session")).toBeTruthy();
      expect(headers.get("user-agent")).toStartWith("my-claw/");
    }
  });

  test("the config has the last word: an owner can override what we send", async () => {
    const seen: Headers[] = [];
    const mock = mockFetch(async (_url?: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      await chatCompletion(
        {
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "kimi-k3",
          apiKey: "k",
          cacheKey: SESSION,
          headers: { "User-Agent": "opencode/1.0.0", "x-opencode-session": "mine" },
        },
        [{ role: "user", content: "hi" }],
      );
      expect(seen[0]!.get("user-agent")).toBe("opencode/1.0.0");
      expect(seen[0]!.get("x-opencode-session")).toBe("mine");
    } finally {
      mock.restore();
    }
  });
});
