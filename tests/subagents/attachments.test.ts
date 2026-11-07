/**
 * What a sub-agent is handed when the message carries a picture.
 *
 * The `send` tool has always taken attachments, and the runner has always listed them in the
 * turn's text as `[Attachments]\n- image: <path>`. That is prose: the model received a filesystem
 * path and nothing else, so it went looking for the file with a tool, was refused for escaping the
 * workspace, and burnt the turn. Nothing warned, because the only guard reads the message's
 * attachment array and the runner built that array empty.
 *
 * The images ride on the entry, like a human's turn: `attachImages` rebuilds the image blocks from
 * that field on every request -- docs/subagents.md.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import type { UserEntry } from "../../src/sessions/log.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

/** Vision on, or the prompt builder is right to leave every image on the floor. */
const config: MyClawConfig = {
  whitelist: ["owner"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model", vision: true },
  agents: {},
  memory: { enabled: false },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

// A real 1x1 PNG: the encoder reads the bytes off the disk, so an empty file would prove nothing.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function anImage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sub-img-"));
  const path = join(dir, "shot.png");
  await writeFile(path, PNG);
  return path;
}

function subSession(id: string): LegacySessionData {
  return {
    id,
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages: [],
    meta: {
      displayName: "eyes",
      type: "research",
      parentSessionId: "my-claw-app/thread/owner/main",
      visibility: "global",
      createdAt: new Date().toISOString(),
    },
  };
}

function parentMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "my-claw-app",
    userId: "owner",
    chatId: "owner",
    chatType: "dm",
    text: "look at this",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

type SentMessage = { role: string; content: string | Array<{ type: string; image_url?: { url: string } }> };

/** The one thing that matters: what the model was actually sent. */
function capture(): { bodies: SentMessage[][]; restore: () => void } {
  const bodies: SentMessage[][] = [];
  const mock = mockFetch(async (_input, init) => {
    const asked = JSON.parse(String(init?.body ?? "{}")) as { messages?: SentMessage[] };
    bodies.push(asked.messages ?? []);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "seen" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ) as never;
  });
  return { bodies, restore: mock.restore };
}

function imageParts(messages: SentMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user" && Array.isArray(m.content))
    .flatMap((m) => (m.content as Array<{ type: string; image_url?: { url: string } }>))
    .filter((part) => part.type === "image_url")
    .map((part) => part.image_url?.url ?? "");
}

test("an image sent to a sub-agent reaches the model as an image, not as a path", async () => {
  const id = "subagent/eyes-a1b2";
  await writeLegacySessionFile(id, subSession(id));
  const setup = await setupSessionLog(id);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const path = await anImage();
  const sent = capture();
  try {
    const out = await runner.send(
      id,
      "what do you see?",
      [{ type: "image", path, mimeType: "image/png" }],
      parentMessage(),
      reg,
      "my-claw-app/thread/owner/main",
    );
    assert.equal(out, "seen");

    // The turn owns the picture: this field is what every later request reads back.
    await setup.log.flush();
    const user = (await setup.log.all()).filter((e): e is UserEntry => e.type === "user").pop();
    assert.deepEqual(user?.attachments, [{ type: "image", path, mimeType: "image/png" }]);
    // The path stays named in the text too, which is how the reader and the tools see it.
    assert.match(user?.text ?? "", /\[Attachments\]\n- image: /);

    const urls = imageParts(sent.bodies[0] ?? []);
    assert.equal(urls.length, 1, `the request carried no image block: ${JSON.stringify(sent.bodies[0])}`);
    assert.ok(urls[0]?.startsWith("data:image/png;base64,"), `not an inline image: ${urls[0]?.slice(0, 40)}`);
  } finally {
    sent.restore();
    setup.cleanup();
    await deleteSession(id);
  }
});

test("the picture is still there a turn later, since the log is what the prompt is built from", async () => {
  const id = "subagent/eyes-c3d4";
  await writeLegacySessionFile(id, subSession(id));
  const setup = await setupSessionLog(id);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const path = await anImage();
  const sent = capture();
  try {
    await runner.send(id, "first", [{ type: "image", path, mimeType: "image/png" }], parentMessage(), reg, "my-claw-app/thread/owner/main");
    await runner.send(id, "and now, what colour?", undefined, parentMessage(), reg, "my-claw-app/thread/owner/main");

    // Chat APIs are stateless: an image only stays visible if it is resent every time.
    assert.equal(imageParts(sent.bodies[1] ?? []).length, 1, "the second turn lost the picture");
  } finally {
    sent.restore();
    setup.cleanup();
    await deleteSession(id);
  }
});

test("a send with no image sends no image block", async () => {
  const id = "subagent/eyes-e5f6";
  await writeLegacySessionFile(id, subSession(id));
  const setup = await setupSessionLog(id);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const sent = capture();
  try {
    await runner.send(id, "plain question", undefined, parentMessage(), reg, "my-claw-app/thread/owner/main");
    await setup.log.flush();
    const user = (await setup.log.all()).filter((e): e is UserEntry => e.type === "user").pop();
    assert.equal(user?.attachments, undefined);
    assert.equal(imageParts(sent.bodies[0] ?? []).length, 0);
  } finally {
    sent.restore();
    setup.cleanup();
    await deleteSession(id);
  }
});

test("a file that is not an image is listed, not carried", async () => {
  const id = "subagent/eyes-g7h8";
  await writeLegacySessionFile(id, subSession(id));
  const setup = await setupSessionLog(id);
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const dir = await mkdtemp(join(tmpdir(), "sub-doc-"));
  const path = join(dir, "notes.txt");
  await writeFile(path, "nothing to see");
  const sent = capture();
  try {
    await runner.send(id, "read this", [{ type: "file", path }], parentMessage(), reg, "my-claw-app/thread/owner/main");
    await setup.log.flush();
    const user = (await setup.log.all()).filter((e): e is UserEntry => e.type === "user").pop();
    assert.equal(user?.attachments, undefined);
    assert.match(user?.text ?? "", /- file: /);
    assert.equal(imageParts(sent.bodies[0] ?? []).length, 0);
  } finally {
    sent.restore();
    setup.cleanup();
    await deleteSession(id);
  }
});
