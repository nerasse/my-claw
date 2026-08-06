import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData, SessionMessage } from "../../src/sessions/store.ts";

// A 1x1 png, small enough that the resizer passes it through untouched.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function visionConfig(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: {
      // New-format config: only this shape reads `models[].vision` (the legacy one falls back
      // to the single global flag).
      providers: { main: { baseUrl: "https://example.com" } },
      defaultProvider: "main",
      defaultModel: "seeing-model",
      models: [{ id: "seeing-model", label: "Seeing", provider: "main", vision: true }],
    },
    agents: {},
    memory: { enabled: false },
  };
}

function session(messages: SessionMessage[]): SessionData {
  const now = new Date().toISOString();
  return { id: "my-claw-app/thread/owner-1/t-1", platform: "my-claw-app", chatType: "dm", createdAt: now, lastActiveAt: now, messages };
}

function msg(text: string, attachments: UnifiedMessage["attachments"] = []): UnifiedMessage {
  return { id: "m1", platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments, isForwarded: false, raw: {} };
}

function llmReply(): never {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: "seen" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ) as never;
}

type Body = { messages: Array<{ role: string; content: unknown }> };

async function capture(config: MyClawConfig, sess: SessionData, message: UnifiedMessage): Promise<Body[]> {
  runRegistry.clear();
  const bridge = new AgentBridge(config, new ToolRegistry(), new SkillRegistry());
  const { signal, end } = runRegistry.startRoot(sess.id);
  const bodies: Body[] = [];
  const mock = mockFetch(async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
    return llmReply();
  });
  try {
    await bridge.handleMessage(message, sess, signal);
    return bodies;
  } finally {
    mock.restore();
    end();
    runRegistry.clear();
  }
}

function imageBlocks(content: unknown): unknown[] {
  return Array.isArray(content) ? content.filter((p) => (p as { type?: string }).type === "image_url") : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [];
  return parts
    .filter((p) => (p as { type?: string }).type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

test("an attached image is sent as a media block and keeps the full user content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-"));
  const path = join(dir, "photo.png");
  await writeFile(path, PNG);

  const bodies = await capture(visionConfig(), session([]), msg("Yooo", [{ type: "image", path, mimeType: "image/png" }]));

  const last = bodies[0]!.messages.at(-1)!;
  assert.equal(imageBlocks(last.content).length, 1);
  // The turn must keep the built content, not the raw text: dropping it loses the [Attachments]
  // block and the reply/thread context on the only turn that carries the picture.
  assert.match(textOf(last.content), /Yooo/);
  assert.match(textOf(last.content), /\[Attachments\]/);
});

test("the image stays in the conversation on the turns that follow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-"));
  const path = join(dir, "photo.png");
  await writeFile(path, PNG);

  // Turn one carried the photo; the session keeps the reference the channel resolved.
  const now = new Date().toISOString();
  const sess = session([
    { role: "user", content: "Yooo\n\n[Attachments]\n- image: " + path, timestamp: now, attachments: [{ type: "image", path }] },
    { role: "assistant", content: "Yo!", timestamp: now },
  ]);

  // Turn two carries nothing: the chat API is stateless, so the picture is only still visible
  // if it is resent with this request.
  const bodies = await capture(visionConfig(), sess, msg("et la, tu vois quoi ?"));

  const withImages = bodies[0]!.messages.filter((m) => imageBlocks(m.content).length > 0);
  assert.equal(withImages.length, 1);
  assert.match(textOf(withImages[0]!.content), /Yooo/);
});

test("a deleted attachment degrades to text instead of breaking the turn", async () => {
  const now = new Date().toISOString();
  const sess = session([
    { role: "user", content: "look", timestamp: now, attachments: [{ type: "image", path: "/nope/gone.png" }] },
    { role: "assistant", content: "ok", timestamp: now },
  ]);

  const bodies = await capture(visionConfig(), sess, msg("still there?"));

  assert.equal(bodies[0]!.messages.filter((m) => imageBlocks(m.content).length > 0).length, 0);
  assert.equal(bodies[0]!.messages.some((m) => textOf(m.content).includes("look")), true);
});

test("a text-only model never receives image blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vision-"));
  const path = join(dir, "photo.png");
  await writeFile(path, PNG);

  const config = visionConfig();
  config.llm.models = [{ id: "seeing-model", label: "Seeing", provider: "main", vision: false }];

  const bodies = await capture(config, session([]), msg("Yooo", [{ type: "image", path, mimeType: "image/png" }]));

  assert.equal(bodies[0]!.messages.filter((m) => imageBlocks(m.content).length > 0).length, 0);
});
