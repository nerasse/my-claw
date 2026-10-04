import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, type PromptContext } from "../../src/agent/prompt/builder.ts";
import type { SkillInfo } from "../../src/skills/types.ts";

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    platform: "unknown",
    model: "test-model-1",
    sessionId: "sess-1",
    skills: [],
    ...overrides,
  };
}

function makeSkill(name: string): SkillInfo {
  return {
    name,
    description: `${name} description`,
    source: "built-in",
    path: `/skills/${name}`,
  };
}

test("empty context returns core directives and runtime with model name", async () => {
  const result = await buildSystemPrompt(makeCtx());
  assert.match(result, /Core Directives/);
  assert.match(result, /Runtime:/);
  assert.match(result, /test-model-1/);
});

test("the tools are not listed in the prompt: their definitions already go out with the request", async () => {
  // The layer sent every tool description a second time, on every request (removed 2026-10-04).
  const result = await buildSystemPrompt(makeCtx({ skills: [makeSkill("deploy")] }));
  assert.doesNotMatch(result, /# Available tools/);
});

test("skills appear in output with the instruction to load them", async () => {
  const result = await buildSystemPrompt(
    makeCtx({ skills: [makeSkill("deploy"), makeSkill("lint")] }),
  );
  assert.match(result, /# Available skills/);
  assert.match(result, /deploy/);
  assert.match(result, /lint/);
  assert.match(result, /call skills\(name\)/);
});

test("platform my-claw-app includes the app hint", async () => {
  const result = await buildSystemPrompt(makeCtx({ platform: "my-claw-app" }));
  assert.match(result, /You are in the my-claw app/);
});

test("unknown platform has no platform hint section", async () => {
  const result = await buildSystemPrompt(makeCtx({ platform: "unknown" }));
  assert.ok(!result.includes("You are in the my-claw app"));
});

test("workspace files are loaded into prompt", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const dir = await mkdtemp(join(tmpdir(), "prompt-test-"));
  try {
    await writeFile(join(dir, "SOUL.md"), "I am the soul of this bot.");
    await writeFile(join(dir, "USER.md"), "The user likes tea.");
    process.env["MY_CLAW_WORKSPACE"] = dir;
    const result = await buildSystemPrompt(makeCtx());
    assert.match(result, /I am the soul of this bot/);
    assert.match(result, /The user likes tea/);
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an edited workspace file is picked up by the very next build", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const dir = await mkdtemp(join(tmpdir(), "prompt-hot-"));
  try {
    const file = join(dir, "AGENTS.md");
    await writeFile(file, "FIRST RULES");
    process.env["MY_CLAW_WORKSPACE"] = dir;
    const before = await buildSystemPrompt(makeCtx());
    assert.match(before, /FIRST RULES/);

    await writeFile(file, "SECOND RULES");
    // mtimeMs has millisecond resolution: pin a later stamp so the assertion cannot hinge
    // on both writes landing in the same millisecond.
    const later = new Date(Date.now() + 2000);
    await utimes(file, later, later);

    const after = await buildSystemPrompt(makeCtx());
    assert.match(after, /SECOND RULES/, "edit applies with no cache delay");
    assert.ok(!after.includes("FIRST RULES"), "stale content dropped");
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace file content is normalised", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const dir = await mkdtemp(join(tmpdir(), "prompt-inject-"));
  try {
    await writeFile(join(dir, "SOUL.md"), "stay cur\u200bious");
    process.env["MY_CLAW_WORKSPACE"] = dir;
    const result = await buildSystemPrompt(makeCtx());
    assert.match(result, /stay curious/);
    assert.ok(!result.includes("\u200b"), "invisible character stripped from the workspace file");
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("layers are ordered: core before skills before runtime", async () => {
  const result = await buildSystemPrompt(makeCtx({ skills: [makeSkill("carpentry")] }));
  const coreIdx = result.indexOf("Core Directives");
  const skillsIdx = result.indexOf("# Available skills");
  const runtimeIdx = result.indexOf("Runtime:");
  assert.ok(coreIdx >= 0, "core present");
  assert.ok(skillsIdx >= 0, "skills present");
  assert.ok(runtimeIdx >= 0, "runtime present");
  assert.ok(coreIdx < skillsIdx, "core before skills");
  assert.ok(skillsIdx < runtimeIdx, "skills before runtime");
});

test("suggested skills render a soft reminder after the runtime line", async () => {
  const result = await buildSystemPrompt(
    makeCtx({
      skills: [makeSkill("deploy"), makeSkill("video")],
      suggestedSkills: [makeSkill("video")],
    }),
  );
  const runtimeIdx = result.indexOf("Runtime:");
  const suggestIdx = result.indexOf("# Skills possibly relevant to this request");
  assert.ok(suggestIdx >= 0, "soft reminder present");
  assert.ok(runtimeIdx < suggestIdx, "reminder comes after runtime (keeps cacheable prefix stable)");
  assert.match(result, /Treat this as a hint, not an order/);
});

test("no suggested skills means no reminder section", async () => {
  const result = await buildSystemPrompt(makeCtx({ skills: [makeSkill("deploy")] }));
  assert.ok(!result.includes("# Skills possibly relevant to this request"));
});

test("an instructions list selects which workspace layers reach the prompt", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const dir = await mkdtemp(join(tmpdir(), "prompt-layers-"));
  try {
    await writeFile(join(dir, "SOUL.md"), "PERSONA TEXT");
    await writeFile(join(dir, "AGENTS.md"), "RULES TEXT");
    await writeFile(join(dir, "USER.md"), "USER TEXT");
    process.env["MY_CLAW_WORKSPACE"] = dir;
    const result = await buildSystemPrompt(makeCtx({ instructions: ["CORE", "USER"] }));
    assert.match(result, /USER TEXT/);
    assert.ok(!result.includes("PERSONA TEXT"), "SOUL dropped by the instructions list");
    assert.ok(!result.includes("RULES TEXT"), "AGENTS dropped by the instructions list");
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty instructions list drops every workspace layer, CORE included", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const dir = await mkdtemp(join(tmpdir(), "prompt-none-"));
  try {
    await writeFile(join(dir, "SOUL.md"), "PERSONA TEXT");
    process.env["MY_CLAW_WORKSPACE"] = dir;
    const result = await buildSystemPrompt(makeCtx({ instructions: [] }));
    assert.ok(!result.includes("PERSONA TEXT"));
    assert.ok(!result.includes("Core Directives"), "the empty list also drops the CORE layer");
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a configured inherit source flows into the built prompt", async () => {
  const saved = process.env["MY_CLAW_WORKSPACE"];
  const sofa = await mkdtemp(join(tmpdir(), "prompt-policy-"));
  const lab = await mkdtemp(join(tmpdir(), "prompt-policy-lab-"));
  try {
    await writeFile(join(lab, "SOUL.md"), "LAB PERSONA");
    await writeFile(join(sofa, "USER.md"), "USER TEXT");
    process.env["MY_CLAW_WORKSPACE"] = sofa;
    const result = await buildSystemPrompt(
      makeCtx({
        workspaceKey: "sofa",
        workspaces: { sofa, lab },
        workspacePrompts: { sofa: { "SOUL.md": { inherit: "lab" } } },
      }),
    );
    assert.match(result, /LAB PERSONA/);
    assert.match(result, /USER TEXT/);
  } finally {
    if (saved === undefined) delete process.env["MY_CLAW_WORKSPACE"];
    else process.env["MY_CLAW_WORKSPACE"] = saved;
    await rm(sofa, { recursive: true, force: true });
    await rm(lab, { recursive: true, force: true });
  }
});
