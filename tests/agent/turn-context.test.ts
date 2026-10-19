import { test } from "bun:test";
import assert from "node:assert/strict";
import { turnContextBlock } from "../../src/agent/prompt/turn-context.ts";
import type { SkillInfo } from "../../src/skills/types.ts";

function skill(name: string): SkillInfo {
  return { name, description: `${name} description`, source: "built-in", path: `/skills/${name}` };
}

test("the inbound turn carries the time and the suggested skills", () => {
  const block = turnContextBlock({
    now: new Date("2026-10-19T20:18:36.172Z"),
    suggested: [skill("voice")],
  });
  assert.ok(block.startsWith("<context>"));
  assert.ok(block.endsWith("</context>"));
  assert.match(block, /Current time: 2026-10-19T20:18:36\.172Z/);
  assert.match(block, /- voice: voice description/);
  assert.match(block, /Treat this as a hint, not an order\./);
});

test("without a suggestion the block keeps only the clock", () => {
  const block = turnContextBlock({ now: new Date("2026-10-19T00:00:00.000Z"), suggested: [] });
  assert.match(block, /Current time: 2026-10-19T00:00:00\.000Z/);
  assert.ok(!block.includes("Skills possibly relevant"));
});
