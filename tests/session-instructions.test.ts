import { test, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionInstructionsReport } from "../src/channels/session-instructions.ts";
import { AgentRegistry } from "../src/agents/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { resetPromptFileCache } from "../src/agent/prompt/loader.ts";
import type { Skill } from "../src/skills/types.ts";
import type { MyClawConfig } from "../src/core/config.ts";
import type { LegacySessionData } from "../src/sessions/store.ts";

let base: string;

function configFor(): MyClawConfig {
  return {
    whitelist: ["u1"],
    blacklist: [],
    channels: {},
    llm: { provider: "x", baseUrl: "https://example.com", model: "base-model" },
    agents: {},
    workspace: join(base, "default"),
    workspaces: { sofa: join(base, "sofa") },
  };
}

function sessionFor(extra: Partial<LegacySessionData> = {}): LegacySessionData {
  return {
    id: "my-claw-app/dm/u1",
    platform: "my-claw-app",
    chatType: "dm",
    createdAt: "2026-08-15T10:00:00.000Z",
    lastActiveAt: "2026-08-15T10:00:00.000Z",
    messages: [],
    ...extra,
  };
}

function params(session: LegacySessionData | null) {
  return {
    session,
    sessionId: "my-claw-app/dm/u1",
    config: configFor(),
    skillRegistry: new SkillRegistry(),
    toolRegistry: new ToolRegistry(),
    agentRegistry: new AgentRegistry(),
    platform: "my-claw-app",
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "session-instructions-"));
  await mkdir(join(base, "default"), { recursive: true });
  await mkdir(join(base, "sofa"), { recursive: true });
  await writeFile(join(base, "default", "CORE.md"), "core rules\n", "utf-8");
  await writeFile(join(base, "default", "SOUL.md"), "default soul\n", "utf-8");
  await writeFile(join(base, "default", "AGENTS.md"), "default agents\n", "utf-8");
  await writeFile(join(base, "default", "USER.md"), "default user\n", "utf-8");
  resetPromptFileCache();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test("the page lists the skills of the session's workspace, like the run that follows it", async () => {
  // The run loads `skillRegistry.list(agent.skills, session.workspace)` -- the session's key, not
  // the agent file's pin (bridge.ts). Asking the pin left the skill of a workspace session out of
  // the page: the owner dropped one in `career/skills`, watched the watcher reload it, and the two
  // sessions of that workspace never showed it (2026-09-16).
  const p = params(sessionFor({ workspace: "sofa" }));
  const entry = (name: string, source: Skill["source"], workspace?: string): [string, Skill] => [
    workspace ? `${workspace}/${name}` : name,
    {
      meta: { name, description: `${name} skill` },
      content: "",
      path: join(base, `${name}.md`),
      source,
      ...(workspace ? { workspace } : {}),
    },
  ];
  p.skillRegistry.setAll(new Map([
    entry("shared", "custom"),
    entry("sofa-only", "workspace", "sofa"),
    entry("elsewhere-only", "workspace", "dev"),
  ]));

  const report = await sessionInstructionsReport(p);
  assert.equal(report.workspace, "sofa");
  assert.deepEqual(report.skills.map((s) => s.name).sort(), ["shared", "sofa-only"]);
  // The roster is a layer of the composed prompt, so the page's preview has to carry it too.
  assert.ok(report.layers.some((l) => l.text.includes("sofa-only")));
});

test("the report names every layer of the prompt, in build order", async () => {
  const report = await sessionInstructionsReport(params(sessionFor()));

  assert.deepEqual(
    report.layers.map((l) => l.id),
    ["CORE", "SOUL", "AGENTS", "USER", "platform", "runtime"],
  );
  assert.equal(report.agent, "orchestrator");
  assert.equal(report.workspace, "default");
  // The bytes are the sum of the layers: the page shows the size of the prompt itself.
  assert.equal(report.totalBytes, report.layers.reduce((sum, l) => sum + l.bytes, 0));
});

test("every prompt layer says where it comes from and how to edit it", async () => {
  const report = await sessionInstructionsReport(params(sessionFor({ workspace: "sofa" })));

  const soul = report.layers.find((l) => l.id === "SOUL");
  // sofa owns none of the four files, so it reads the default workspace's copy.
  assert.equal(soul?.origin, "inherited");
  assert.equal(soul?.from, "default");
  assert.ok(soul?.text.includes("default soul"));
  // Editing targets the conversation's own workspace: the edit is an override of what it reads.
  assert.deepEqual(soul?.edit, { workspace: "sofa", file: "SOUL.md" });
});

test("a missing CORE.md is reported as the hardcoded fallback, not as an own file", async () => {
  await rm(join(base, "default", "CORE.md"));
  resetPromptFileCache();

  const report = await sessionInstructionsReport(params(sessionFor()));
  const core = report.layers.find((l) => l.id === "CORE");
  assert.equal(core?.origin, "fallback");
  assert.ok(core!.bytes > 0, "the structural layer is never empty");
});

test("the nested AGENTS.md a session read are listed with their trace", async () => {
  const inside = join(base, "default", "svc", "AGENTS.md");
  await mkdir(join(base, "default", "svc"), { recursive: true });
  await writeFile(inside, "svc rules\n", "utf-8");
  const outside = join(base, "elsewhere", "AGENTS.md");
  await mkdir(join(base, "elsewhere"), { recursive: true });
  await writeFile(outside, "outside rules\n", "utf-8");

  const report = await sessionInstructionsReport(
    params(
      sessionFor({
        nestedAgents: [
          { path: outside, bytes: 5, firstAt: "2026-08-15T10:00:00.000Z", lastAt: "2026-08-15T12:00:00.000Z", count: 3 },
          { path: inside, bytes: 5, firstAt: "2026-08-15T11:00:00.000Z", lastAt: "2026-08-15T11:00:00.000Z", count: 1 },
          { path: join(base, "gone", "AGENTS.md"), bytes: 7, firstAt: "2026-08-15T09:00:00.000Z", lastAt: "2026-08-15T09:00:00.000Z", count: 1 },
        ],
      }),
    ),
  );

  const inWorkspace = report.nested.find((n) => n.path === inside);
  // Inside the workspace it is named relative to it, outside it keeps its absolute path.
  assert.equal(inWorkspace?.label, join("svc", "AGENTS.md"));
  assert.equal(report.nested.find((n) => n.path === outside)?.label, outside);
  // The size is what is on disk now, not what was injected: the file may have been edited since.
  assert.equal(inWorkspace?.bytes, Buffer.byteLength("svc rules\n"));
  assert.equal(report.nested.find((n) => n.path === outside)?.count, 3);
  // A file that has since been deleted stays listed: it did shape this conversation.
  const gone = report.nested.find((n) => n.path.endsWith(join("gone", "AGENTS.md")));
  assert.equal(gone?.missing, true);
  assert.equal(gone?.bytes, 7);
});

test("a thread that has never run still reports what it would load", async () => {
  const report = await sessionInstructionsReport(params(null));
  assert.ok(report.layers.some((l) => l.id === "CORE"));
  assert.deepEqual(report.nested, []);
});

test("the report reflects layers, skills and memory recall the session turned off", async () => {
  const report = await sessionInstructionsReport(
    params(sessionFor({ promptLayersOff: ["runtime", "suggested"], skillsOff: ["voice"], memoryRecallOff: true })),
  );
  assert.deepEqual(report.layersOff, ["runtime", "suggested"]);
  assert.deepEqual(report.skillsOff, ["voice"]);
  assert.equal(report.memoryRecallOff, true);
  // The off layers are gone from the composed prompt: runtime is not a layer. `suggested` is no
  // longer one either: the hint is injected into the inbound turn, not the system prompt.
  const ids = report.layers.map((l) => l.id);
  assert.equal(ids.includes("runtime"), false);
  assert.equal(report.layers.every((layer) => String(layer.id) !== "suggested"), true);
});

test("the report marks disabled nested files", async () => {
  const repoPath = join(base, "repo", "AGENTS.md");
  const report = await sessionInstructionsReport(
    params(
      sessionFor({
        nestedAgents: [{ path: repoPath, bytes: 40, firstAt: "2026-08-15T10:00:00.000Z", lastAt: "2026-08-15T10:00:00.000Z", count: 1 }],
        nestedDisabled: [repoPath],
      }),
    ),
  );
  // A disabled file stays in the main list, greyed out.
  assert.equal(report.nested.find((n) => n.path === repoPath)?.disabled, true);
});
