/**
 * What a tool's images become in the conversation (docs/tool-images.md).
 *
 * 2026-10-04: an agent read its own screenshots to check a layout, deleted their folder, and the
 * reply carried six "(deleted)" attachments. Two faults: the copy into the conversation happened at
 * the end of the run, after the file was gone; and an image the agent only looked at (`read`) was
 * attached to the reply at all.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "test-model", vision: true },
  agents: {},
  memory: { enabled: false },
};
const SESSION_ID = "my-claw-app/dm/u1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function message(id: string, text: string): UnifiedMessage {
  return { id, platform: "my-claw-app", userId: "u1", chatId: "c1", chatType: "dm", text, attachments: [], isForwarded: false, raw: {} };
}

function llm(body: object): never {
  return new Response(JSON.stringify({ choices: [{ message: body }] }), { status: 200, headers: { "Content-Type": "application/json" } }) as never;
}

function call(id: string, name: string): object {
  return { content: "", tool_calls: [{ id, function: { name, arguments: "{}" } }] };
}

/** A tool that makes a picture (`shot`, shown), one that only looks at it (`look`), one that deletes it. */
function tools(path: string): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "shot", description: "shot", parameters: {},
    async execute() {
      await writeFile(path, PNG);
      return { success: true, output: "taken", attachments: [{ type: "image", path, mimeType: "image/png" }] };
    },
  });
  reg.register({
    name: "look", description: "look", parameters: {},
    async execute() {
      return { success: true, output: "looked", attachments: [{ type: "image", path, mimeType: "image/png" }], modelOnly: true };
    },
  });
  reg.register({
    name: "clean", description: "clean", parameters: {},
    async execute() {
      await rm(path, { force: true });
      return { success: true, output: "removed" };
    },
  });
  return reg;
}

/** The channel's store: it can copy only a file that still exists, as the real one. */
function store(): { hook: (sessionId: string, path: string) => Promise<string | undefined>; copied: string[] } {
  const copied: string[] = [];
  return {
    copied,
    hook: async (_sessionId, path) => {
      const exists = await stat(path).then(() => true, () => false);
      if (!exists) return undefined;
      copied.push(path);
      return `stored-${copied.length}`;
    },
  };
}

async function run(steps: string[]): Promise<{ out: Awaited<ReturnType<MessageRouter["route"]>>; bodies: string[]; copied: string[] }> {
  runRegistry.clear();
  const setup = await setupSessionLog(SESSION_ID);
  const dir = await mkdtemp(join(tmpdir(), "tool-media-"));
  const path = join(dir, "shot.png");
  const router = new MessageRouter(new SessionManager(), new AgentBridge(config, tools(path), new SkillRegistry()), config);
  const media = store();
  router.setMediaStore(media.hook);
  const bodies: string[] = [];
  let n = 0;
  const mock = mockFetch(async (_u, init) => {
    bodies.push(String(init?.body ?? ""));
    const step = steps[n++];
    return llm(step ? call(`tc${n}`, step) : { content: "done" });
  });
  try {
    const out = await router.route(message("m1", "go"));
    return { out, bodies, copied: media.copied };
  } finally {
    mock.restore();
    runRegistry.clear();
    setup.cleanup();
  }
}

describe("a tool's images in the conversation", () => {
  test("a picture is copied when the tool makes it: deleting the file later in the run loses nothing", async () => {
    const { out, copied } = await run(["shot", "clean"]);
    expect(copied.length).toBe(1);
    expect(out?.attachments?.map((a) => a.id)).toEqual(["stored-1"]);
  });

  test("an image the agent only looked at reaches the model, not the reply", async () => {
    const { out, bodies, copied } = await run(["shot", "look"]);
    // The model was shown both: the shot, then the same file looked at.
    expect(bodies.at(-1)!.match(/data:image\/png;base64,/g)?.length).toBe(2);
    expect(copied.length).toBe(1);
    expect(out?.attachments?.length).toBe(1);
  });
});
