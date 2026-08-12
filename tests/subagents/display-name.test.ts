import { test } from "bun:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { mockFetch } from "../helpers/mock-fetch.ts";
import { SubAgentRunner } from "../../src/subagents/runner.ts";
import { SubAgentRegistry, sanitizeDisplayName } from "../../src/subagents/registry.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager, SttPipeline } from "../../src/voice/index.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { loadSession, deleteSession } from "../../src/sessions/store.ts";

const config: MyClawConfig = {
  whitelist: ["u1"],
  blacklist: [],
  channels: {},
  llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
  agents: { research: { llm: { defaultModel: "research-model" } } },
};

const voiceManager = new VoiceManager(config);
const sttPipeline = new SttPipeline(voiceManager);

function createMessage(): UnifiedMessage {
  return {
    id: "m1",
    platform: "telegram",
    userId: "u1",
    chatId: "c1",
    chatType: "dm",
    text: "hello",
    attachments: [],
    isForwarded: false,
    raw: {},
  };
}

function answerOnce(): { restore: () => void } {
  return mockFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }) as never,
  );
}

test("sanitizeDisplayName keeps a name that is already safe", () => {
  assert.equal(sanitizeDisplayName("researcher"), "researcher");
  assert.equal(sanitizeDisplayName("api_v2-worker"), "api_v2-worker");
  assert.equal(sanitizeDisplayName("chercheur"), "chercheur");
});

test("sanitizeDisplayName defuses the path characters", () => {
  // The bug this fix exists for: a slash writes outside sessions/subagent/.
  assert.equal(sanitizeDisplayName("a/b"), "a-b");
  assert.equal(sanitizeDisplayName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeDisplayName(".."), "agent");
  assert.equal(sanitizeDisplayName("c:\\win"), "c-win");
  assert.ok(!sanitizeDisplayName("../../etc/passwd").includes("/"));
  assert.ok(!sanitizeDisplayName("../../etc/passwd").includes(".."));
});

test("sanitizeDisplayName removes control and invisible code points", () => {
  assert.equal(sanitizeDisplayName("a\u0000b"), "a-b");
  assert.equal(sanitizeDisplayName("two\nlines"), "two-lines");
  assert.equal(sanitizeDisplayName("tab\there"), "tab-here");
  // Zero-width space and a bidi override: two agents must not be able to look identical.
  assert.equal(sanitizeDisplayName("re\u200bsearch"), "re-search");
  assert.equal(sanitizeDisplayName("\u202eevil"), "evil");
});

test("sanitizeDisplayName preserves letters outside ASCII", () => {
  assert.equal(sanitizeDisplayName("recherche-é"), "recherche-é");
  assert.equal(sanitizeDisplayName("調査"), "調査");
  // A decomposed accent is a combining mark, and must survive as one.
  assert.equal(sanitizeDisplayName("cafe\u0301"), "cafe\u0301");
});

test("sanitizeDisplayName collapses, trims and never returns empty", () => {
  assert.equal(sanitizeDisplayName("a   b"), "a-b");
  assert.equal(sanitizeDisplayName("--lead--trail--"), "lead-trail");
  assert.equal(sanitizeDisplayName(""), "agent");
  assert.equal(sanitizeDisplayName("///"), "agent");
  assert.equal(sanitizeDisplayName("   "), "agent");
});

test("sanitizeDisplayName caps length without splitting a surrogate pair", () => {
  const long = sanitizeDisplayName("x".repeat(200));
  assert.equal(long.length, 64);
  // Astral letters are one code point each but two UTF-16 units: a naive slice leaves a lone
  // surrogate in the filename.
  const astral = sanitizeDisplayName("𝐀".repeat(100));
  assert.equal(Array.from(astral).length, 64);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral));
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(astral));
});

test("sanitizeDisplayName is idempotent", () => {
  for (const raw of ["a/b", "../x", "re\u200bsearch", "  ", "x".repeat(200)]) {
    const once = sanitizeDisplayName(raw);
    assert.equal(sanitizeDisplayName(once), once);
  }
});

test("generateId builds an id that stays inside the sub-agent directory", () => {
  const reg = new SubAgentRegistry();
  const id = reg.generateId("../../escape", new Set());
  assert.ok(id.startsWith("subagent/"));
  assert.ok(!id.slice("subagent/".length).includes("/"));
  assert.ok(!id.includes(".."));
  assert.match(id, /^subagent\/escape-[0-9a-f]{4}$/);
});

test("generateId still avoids collisions after sanitizing", () => {
  const reg = new SubAgentRegistry();
  const taken = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    // Two different hostile names that sanitize to the same thing must not collide either.
    const id = reg.generateId(i % 2 === 0 ? "a/b" : "a\\b", taken);
    assert.equal(taken.has(id), false);
    taken.add(id);
  }
  assert.equal(taken.size, 50);
});

test("spawn sanitizes even when the caller's generateId does not", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const fetchMock = answerOnce();
  let seen = "";
  try {
    // A raw passthrough, which is what the runner's own callers pass in several places. Without
    // the sanitizing inside spawn(), this writes a nested directory.
    const { id } = await runner.spawn({
      displayName: "team/../worker",
      type: "research",
      mode: "session",
      task: "init",
      parentMessage: createMessage(),
      existingIds: new Set(),
      generateId: (n) => {
        seen = n;
        return `subagent/${n}-fixed`;
      },
      parentSessionId: "matrix/room/!caller:test",
      visibility: "global",
    });
    assert.equal(seen, "team-worker");
    assert.equal(id, "subagent/team-worker-fixed");
    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});

test("a hostile display name lands in sessions/subagent and stays listable", async () => {
  const runner = new SubAgentRunner(config, new ToolRegistry(), new SkillRegistry(), voiceManager, sttPipeline);
  const reg = new SubAgentRegistry();
  const fetchMock = answerOnce();
  try {
    const { id } = await runner.spawn({
      displayName: "../../pwned/agent",
      type: "research",
      mode: "session",
      task: "init",
      parentMessage: createMessage(),
      existingIds: await reg.listExistingIds(),
      generateId: (n, e) => reg.generateId(n, e),
      parentSessionId: "matrix/room/!caller:test",
      visibility: "global",
    });

    assert.match(id, /^subagent\/pwned-agent-[0-9a-f]{4}$/);

    // The file is a direct child of sessions/subagent, not a tree hanging off it.
    const entries = await readdir(join(MY_CLAW_DIR, "sessions", "subagent"), { withFileTypes: true });
    const file = entries.find((e) => e.name === `${id.slice("subagent/".length)}.json`);
    assert.ok(file, `expected ${id} as a file in sessions/subagent`);
    assert.ok(file.isFile());

    // The two things that silently broke before: the uniqueness scan and the roster.
    assert.ok((await reg.listExistingIds()).has(id));
    const listed = await runner.list(reg, "matrix/room/!caller:test");
    assert.ok(listed.some((a) => a.id === id));

    // The stored name is the same one the id carries, or the app shows one thing and addresses
    // another.
    const session = await loadSession(id);
    assert.equal(session?.meta?.displayName, "pwned-agent");
    assert.equal(id, `subagent/${session?.meta?.displayName}-${id.slice(-4)}`);

    await deleteSession(id);
  } finally {
    fetchMock.restore();
  }
});
