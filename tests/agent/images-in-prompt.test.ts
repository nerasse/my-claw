/**
 * The picture has to reach the model, whatever the conversation looks like around it.
 *
 * Three ways it did not:
 *
 * - `attachImages` found the user message to decorate by counting entries with a running index,
 *   one per user, per phase and per compaction. The prompt folds a run's phases into one assistant
 *   message and adds one message per settled tool, so the index drifted on the first run that called
 *   two tools. It landed on a tool message, the role check failed, and the image was dropped with no
 *   line in the log: the model read "[Attachments] - image: <path>" and went looking for the file.
 *
 * - A message injected mid-run built its image content from the *raw* text. A picture sent without
 *   a word has an empty raw text, so an empty text block rode beside the image, and Anthropic refused
 *   the whole request: "messages: text content blocks must be non-empty". The run died on it.
 *
 * - The same injected message was recorded without its attachments, so the reopened thread showed a
 *   bare bubble and no later request could put the picture back.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog } from "../helpers/session-log.ts";
import { MessageRouter } from "../../src/core/router.ts";
import { SessionManager } from "../../src/sessions/manager.ts";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { UserEntry } from "../../src/sessions/log.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model", vision: true },
  agents: {},
  memory: { enabled: false },
};
const SESSION_ID = "my-claw-app/dm/u1";

// A real 1x1 PNG: the encoder reads the bytes off the disk, so an empty file would prove nothing.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function anImage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-img-"));
  const path = join(dir, "shot.png");
  await writeFile(path, PNG);
  return path;
}

function message(id: string, text: string, imagePath?: string): UnifiedMessage {
  return {
    id,
    platform: "my-claw-app",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text,
    attachments: imagePath ? [{ type: "image", path: imagePath, mimeType: "image/png" }] : [],
    isForwarded: false,
    raw: {},
  };
}

function llm(message: object): never {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

function noopTools(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({ name: "noop", description: "noop", parameters: {}, async execute() { return { success: true, output: "ok" }; } });
  return reg;
}

type Part = { type: string; text?: string; image_url?: { url: string } };
type Body = { messages: Array<{ role: string; content: string | Part[] }> };

function lastUserContent(body: Body): string | Part[] {
  const users = body.messages.filter((m) => m.role === "user");
  return users[users.length - 1]!.content;
}

function imageParts(content: string | Part[]): Part[] {
  return Array.isArray(content) ? content.filter((p) => p.type === "image_url") : [];
}

describe("images in the prompt", () => {
  test("the picture reaches the model after a run that called two tools", async () => {
    runRegistry.clear();
    const setup = await setupSessionLog(SESSION_ID);
    const router = new MessageRouter(new SessionManager(), new AgentBridge(config, noopTools(), new SkillRegistry()), config);
    const bodies: Body[] = [];
    let call = 0;
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
      call++;
      // Two tool calls in one response: one phase, one assistant message, two tool messages. That is
      // the shape the running index could not follow.
      if (call === 1) {
        return llm({
          content: "",
          tool_calls: [
            { id: "tc1", function: { name: "noop", arguments: "{}" } },
            { id: "tc2", function: { name: "noop", arguments: "{}" } },
          ],
        });
      }
      return llm({ content: call === 2 ? "done" : "seen" });
    });
    try {
      await router.route(message("m1", "do two things"));
      expect(call).toBe(2);

      const path = await anImage();
      const r2 = await router.route(message("m2", "and what is this?", path));
      expect(r2?.text).toBe("seen");

      const content = lastUserContent(bodies[2]!);
      const images = imageParts(content);
      expect(images.length).toBe(1);
      expect(images[0]?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
      // Decorated in place: the text is the turn's own, the picture beside it.
      expect((content as Part[]).some((p) => p.type === "text" && (p.text ?? "").includes("and what is this?"))).toBe(true);
    } finally {
      mock.restore();
      runRegistry.clear();
      setup.cleanup();
    }
  });

  test("a picture injected mid-run without a word carries no empty text block, and keeps its attachment on the entry", async () => {
    runRegistry.clear();
    const setup = await setupSessionLog(SESSION_ID);
    const router = new MessageRouter(new SessionManager(), new AgentBridge(config, noopTools(), new SkillRegistry()), config);
    const path = await anImage();
    const bodies: Body[] = [];
    let call = 0;
    const mock = mockFetch(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
      call++;
      if (call === 1) {
        runRegistry.enqueueInjection(SESSION_ID, message("m2", "", path));
        return llm({ content: "", tool_calls: [{ id: "tc1", function: { name: "noop", arguments: "{}" } }] });
      }
      return llm({ content: "seen" });
    });
    try {
      const r1 = await router.route(message("m1", "look at what I send next"));
      expect(call).toBe(2);
      expect(r1?.text).toBe("seen");

      const content = lastUserContent(bodies[1]!);
      expect(Array.isArray(content)).toBe(true);
      const parts = content as Part[];
      expect(parts.filter((p) => p.type === "text" && !(p.text ?? "").trim()).length).toBe(0);
      expect(imageParts(parts).length).toBe(1);
      // The text that does ride along names the attachment, as the stored turn does.
      expect(parts.some((p) => p.type === "text" && (p.text ?? "").includes("[Attachments]"))).toBe(true);

      await setup.log.flush();
      const injected = setup.log.entries().find((e): e is UserEntry => e.type === "user" && e.id === "m2");
      expect(injected?.attachments).toEqual([{ type: "image", path, mimeType: "image/png" }]);
    } finally {
      mock.restore();
      runRegistry.clear();
      setup.cleanup();
    }
  });
});
