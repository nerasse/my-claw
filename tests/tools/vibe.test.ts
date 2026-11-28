/**
 * `vibe`: one tool over the Mistral Vibe plan, and the registry gate that only shows it while the
 * plan is configured with a key. The HTTP is mocked; the live checks ran by hand against the API
 * (docs/mistral-backend.md).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MyClawConfig } from "../../src/core/config.ts";
import { createVibeTool, vibeTools } from "../../src/tools/vibe.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const KEY = "test-vibe-key";

function config(overrides: Partial<{ type: string; disabled: boolean; apiKeyEnv: string; vibeTool: boolean }> = {}): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: {
      providers: {
        mistral_vibe: {
          type: (overrides.type ?? "mistral-vibe") as "mistral-vibe",
          apiKeyEnv: overrides.apiKeyEnv ?? "MISTRAL_VIBE_TEST_KEY",
          disabled: overrides.disabled,
          vibeTool: overrides.vibeTool,
        },
      },
      models: [],
    },
  } as MyClawConfig;
}

function tool(): ReturnType<typeof createVibeTool> {
  const created = vibeTools(config())[0];
  if (!created) throw new Error("vibe tool was not created");
  return created;
}

beforeEach(() => {
  process.env["MISTRAL_VIBE_TEST_KEY"] = KEY;
});

afterEach(() => {
  delete process.env["MISTRAL_VIBE_TEST_KEY"];
});

describe("vibe: availability", () => {
  test("exists only while a mistral-vibe provider has its key and is enabled", () => {
    expect(vibeTools(config())).toHaveLength(1);
    delete process.env["MISTRAL_VIBE_TEST_KEY"];
    expect(vibeTools(config())).toHaveLength(0);
    process.env["MISTRAL_VIBE_TEST_KEY"] = KEY;
    expect(vibeTools(config({ disabled: true }))).toHaveLength(0);
    expect(vibeTools(config({ type: "openai" }))).toHaveLength(0);
    // The provider page's switch, off: chat still works, the tool is not listed.
    expect(vibeTools(config({ vibeTool: false }))).toHaveLength(0);
  });

  test("the registry reads the conditional set per list, so hot reload adds and removes it", () => {
    const registry = new ToolRegistry();
    let active = false;
    registry.setConditionalProvider(() => (active ? vibeTools(config()) : []));
    expect(registry.staticNames()).not.toContain("vibe");
    active = true;
    expect(registry.staticNames()).toContain("vibe");
    expect(registry.getForAgent("main").map((entry) => entry.name)).toContain("vibe");
    // Read-only research agents never reach it, and the browser's closed set does not either.
    expect(registry.getForAgent("research").map((entry) => entry.name)).not.toContain("vibe");
    expect(registry.getForAgent("browser").map((entry) => entry.name)).not.toContain("vibe");
  });
});

describe("vibe: image", () => {
  test("generates through the image tool, downloads the signed URL and returns an image attachment", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const mock = mockFetch(async (url, init) => {
      if (String(url).endsWith("/chat/completions")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          object: "chat.multi_completion",
          choices: [{
            index: 0,
            finish_reason: "stop",
            messages: [
              { role: "assistant", content: "" },
              { role: "tool", tool_call_id: "c1", content: JSON.stringify({ url: "https://img.test/a" }) },
              { role: "assistant", content: [{ type: "text", text: "Here it is." }] },
            ],
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    try {
      const result = await tool().execute({ action: "image", prompt: "a red cube" });
      expect(result.success).toBe(true);
      expect(result.keepFromReply).toBe(true);
      const attachment = result.attachments?.[0];
      expect(attachment?.type).toBe("image");
      expect(attachment?.mimeType).toBe("image/png");
      expect(new Uint8Array(await readFile(attachment!.path!))).toEqual(png);
      expect(bodies[0]?.["tools"]).toEqual([{ type: "image_generation" }]);
      expect((bodies[0]?.["metadata"] as Record<string, unknown>)["call_source"]).toBe("vibe_code");
    } finally {
      mock.restore();
    }
  });

  test("a response without an image URL is an error, not an empty success", async () => {
    const mock = mockFetch(async () => new Response(JSON.stringify({
      object: "chat.multi_completion",
      choices: [{ messages: [{ role: "assistant", content: "I cannot draw that." }] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const result = await tool().execute({ action: "image", prompt: "x" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no image URL");
    } finally {
      mock.restore();
    }
  });
});

describe("vibe: ocr", () => {
  test("reads a local image as a data URI and returns the markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const path = join(dir, "page.png");
    await writeFile(path, new Uint8Array([1, 2, 3]));
    let body: Record<string, unknown> = {};
    const mock = mockFetch(async (url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(url)).toContain("/ocr");
      return new Response(JSON.stringify({ pages: [{ markdown: "hello ocr" }, { markdown: "page two" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const result = await tool().execute({ action: "ocr", path });
      expect(result.success).toBe(true);
      expect(result.output).toContain("2 page(s)");
      expect(result.output).toContain("hello ocr");
      const document = body["document"] as Record<string, unknown>;
      expect(document["type"]).toBe("image_url");
      expect(String(document["image_url"]).startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

describe("vibe: speech", () => {
  test("writes the base64 audio and returns it as a draft", async () => {
    const audio = Buffer.from("ID3fake-mp3");
    const mock = mockFetch(async (url, init) => {
      expect(String(url)).toContain("/audio/speech");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body["voice_id"]).toBe("voice_3150");
      expect((body["metadata"] as Record<string, unknown>)["call_source"]).toBe("vibe_code");
      return new Response(JSON.stringify({ audio_data: audio.toString("base64") }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const result = await tool().execute({ action: "speak", text: "bonjour" });
      expect(result.success).toBe(true);
      const attachment = result.attachments?.[0];
      expect(attachment?.type).toBe("audio");
      expect(attachment?.mimeType).toBe("audio/mpeg");
      expect((await readFile(attachment!.path!)).toString()).toBe("ID3fake-mp3");
    } finally {
      mock.restore();
    }
  });
});

describe("vibe: transcription", () => {
  test("sends the audio through Voxtral's chat input, which keeps it on the Vibe allowance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vibe-test-"));
    const path = join(dir, "voice.wav");
    await writeFile(path, new Uint8Array([82, 73, 70, 70]));
    let body: Record<string, unknown> = {};
    const mock = mockFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "bonjour tout le monde" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const result = await tool().execute({ action: "transcribe", path, language: "fr" });
      expect(result.success).toBe(true);
      expect(result.output).toBe("bonjour tout le monde");
      expect(body["model"]).toBe("voxtral-small-2507");
      const content = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
      expect(content[0]?.["type"]).toBe("input_audio");
      expect(String(content[0]?.["input_audio"])).toBe(Buffer.from([82, 73, 70, 70]).toString("base64"));
    } finally {
      mock.restore();
    }
  });
});

describe("vibe: account and models", () => {
  test("summarises the account, the plan and both purses", async () => {
    const mock = mockFetch(async (url) => {
      const path = String(url);
      if (path.endsWith("/users/me")) {
        return new Response(JSON.stringify({ email: "owner@example.com", workspace: { name: "Default" }, organization: { name: "Org" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path.endsWith("/billing/budget")) {
        return new Response(JSON.stringify({
          vibe_budget: { usage_percentage: 10, initial_budget: 100, currency: "EUR", reset_at: "2026-12-01T00:00:00Z" },
          api_budget: { usage_percentage: 0, initial_budget: 51, currency: "EUR" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ plan_name: "TEAM", vibe_payg_enabled: false }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const result = await tool().execute({ action: "account" });
      expect(result.success).toBe(true);
      expect(result.output).toContain("owner@example.com");
      expect(result.output).toContain("Org / Default");
      expect(result.output).toContain("Plan: TEAM");
      expect(result.output).toContain("Vibe credits: 10.00% used of 100.00 EUR, 90.00 left");
    } finally {
      mock.restore();
    }
  });

  test("lists the chat models and drops the rest", async () => {
    const mock = mockFetch(async () => new Response(JSON.stringify({
      data: [
        { id: "mistral-large-4-0", capabilities: { completion_chat: true } },
        { id: "mistral-embed", capabilities: { completion_chat: false } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const result = await tool().execute({ action: "models" });
      expect(result.output).toBe("mistral-large-4-0");
    } finally {
      mock.restore();
    }
  });
});
