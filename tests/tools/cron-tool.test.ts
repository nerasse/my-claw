import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCronTool, type CronToolContext } from "../../src/tools/cron.ts";
import type { CronScheduler } from "../../src/cron/scheduler.ts";
import { loadJobs } from "../../src/cron/store.ts";
import { MY_CLAW_DIR } from "../../src/core/config.ts";

const fakeScheduler = { tick: async () => 0, runningOf: () => undefined } as unknown as CronScheduler;

function context(over: Partial<CronToolContext> = {}): CronToolContext {
  return {
    models: () => ["fast-1", "strong-2"],
    defaultModel: () => "fast-1",
    workspaces: () => ["sofa"],
    skills: () => ["code-review"],
    mcp: () => ["mailcow"],
    cronTools: () => ["bash", "web_search"],
    cronAgentSkills: () => ["inherit-me"],
    cronAgentMcp: () => "all",
    ...over,
  };
}

beforeEach(async () => {
  // jobs.json lives under MY_CLAW_DIR, which the test setup points at a throwaway dir.
  await mkdir(join(MY_CLAW_DIR, "cron"), { recursive: true });
  await writeFile(join(MY_CLAW_DIR, "cron", "jobs.json"), JSON.stringify({ jobs: [], updatedAt: new Date().toISOString() }));
});

test("list reports every job's scope and the catalogs a job can reference", async () => {
  const tool = createCronTool(fakeScheduler, context());
  await tool.execute({ action: "create", name: "Morning", prompt: "summarize", schedule: "every 24h", deliver: "local", skills: "code-review", mcp: "all" });

  const result = await tool.execute({ action: "list" });
  assert.equal(result.success, true);
  const out = result.output;
  assert.match(out, /Morning/);
  assert.match(out, /skills: code-review \| mcp: all \| tools: inherit/);
  assert.match(out, /Context — models: fast-1, strong-2 \(default: fast-1\)/);
  assert.match(out, /Context — workspaces: default|sofa|both/);
  assert.match(out, /Context — skills: code-review/);
  assert.match(out, /Context — mcp: mailcow/);
  assert.match(out, /Context — tools: bash, web_search/);
  assert.match(out, /Cron agent scope: skills: inherit-me \| mcp: all/);
});

test("create stores the skills/mcp/tools scope in the config shape", async () => {
  const tool = createCronTool(fakeScheduler, context());
  const created = await tool.execute({
    action: "create",
    name: "Scoped",
    prompt: "do things",
    schedule: "0 9 * * 1", deliver: "local",
    skills: "code-review, other-skill",
    mcp: "all",
    tools: "none",
  });
  assert.equal(created.success, true);

  const jobs = await loadJobs();
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0]!.skills, ["code-review", "other-skill"]);
  assert.deepEqual(jobs[0]!.mcp, ["*"]);
  assert.deepEqual(jobs[0]!.tools, []);
});

test("update with inherit clears a scope field, an absent argument leaves it untouched", async () => {
  const tool = createCronTool(fakeScheduler, context());
  await tool.execute({ action: "create", name: "Scoped", prompt: "do things", schedule: "every 1h", deliver: "local", skills: "code-review", mcp: "mailcow" });
  const jobs = await loadJobs();
  const id = jobs[0]!.id;

  // skills cleared, mcp untouched (absent argument), tools never set.
  const updated = await tool.execute({ action: "update", job_id: id, skills: "inherit" });
  assert.equal(updated.success, true);
  const after = await loadJobs();
  assert.equal(after[0]!.skills, undefined);
  assert.deepEqual(after[0]!.mcp, ["mailcow"]);
});

test("a stale scope name is saved and then flagged removed by list", async () => {
  const tool = createCronTool(fakeScheduler, context());
  await tool.execute({ action: "create", name: "Stale", prompt: "do things", schedule: "every 1h", deliver: "local", skills: "vanished-skill", model: "ghost-model", workspace: "gone-ws" });

  const result = await tool.execute({ action: "list" });
  assert.match(result.output, /removed: ghost-model \(model\), gone-ws \(workspace\), vanished-skill \(skills\)/);
});

test("scope spellings map: all/* to the wildcard, none to an empty list", async () => {
  const tool = createCronTool(fakeScheduler, context());
  await tool.execute({ action: "create", name: "A", prompt: "a", schedule: "every 1h", deliver: "local", skills: "*", mcp: "none" });
  const jobs = await loadJobs();
  assert.deepEqual(jobs[0]!.skills, ["*"]);
  assert.deepEqual(jobs[0]!.mcp, []);
});

test("the capability switches are stored, reported per job, and granted back by clearing them", async () => {
  const tool = createCronTool(fakeScheduler, context());
  const created = await tool.execute({
    action: "create",
    name: "Watcher",
    prompt: "watch the thing",
    schedule: "every 1h",
    deliver: "local",
    subagents: false,
    browser: false,
  });
  assert.equal(created.success, true);

  const jobs = await loadJobs();
  assert.equal(jobs[0]!.subagents, false);
  assert.equal(jobs[0]!.browser, false);
  const listed = await tool.execute({ action: "list" });
  assert.match(listed.output, /sub-agents: off \| browser: off/);

  // Granting one back clears the flag rather than storing `true`: absent is granted, and an
  // untouched job keeps a clean shape (same rule as `silent`).
  const id = jobs[0]!.id;
  const updated = await tool.execute({ action: "update", job_id: id, subagents: true });
  assert.equal(updated.success, true);
  const after = await loadJobs();
  assert.equal(after[0]!.subagents, undefined);
  assert.equal(after[0]!.browser, false);
  const relisted = await tool.execute({ action: "list" });
  assert.match(relisted.output, /sub-agents: on \| browser: off/);
});

test("a job created without the switches carries neither flag, and reads as granted", async () => {
  const tool = createCronTool(fakeScheduler, context());
  await tool.execute({ action: "create", name: "Plain", prompt: "do it", schedule: "every 2h", deliver: "local" });
  const jobs = await loadJobs();
  assert.equal(jobs[0]!.subagents, undefined);
  assert.equal(jobs[0]!.browser, undefined);
  const listed = await tool.execute({ action: "list" });
  assert.match(listed.output, /sub-agents: on \| browser: on/);
});
