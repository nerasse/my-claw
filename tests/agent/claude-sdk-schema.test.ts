import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../src/agent/claude-sdk/schema.ts";

test("converts required and optional string properties", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      command: { type: "string", description: "the command" },
      cwd: { type: "string" },
    },
    required: ["command"],
  });
  const schema = z.object(shape);
  assert.deepEqual(schema.parse({ command: "ls" }), { command: "ls" });
  assert.deepEqual(schema.parse({ command: "ls", cwd: "/tmp" }), { command: "ls", cwd: "/tmp" });
  assert.throws(() => schema.parse({ cwd: "/tmp" }));
});

test("converts number, boolean, enum and array", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      count: { type: "number" },
      flag: { type: "boolean" },
      mode: { type: "string", enum: ["fast", "slow"] },
      names: { type: "array", items: { type: "string" } },
    },
    required: ["count", "flag", "mode", "names"],
  });
  const schema = z.object(shape);
  const ok = { count: 2, flag: true, mode: "fast", names: ["a"] };
  assert.deepEqual(schema.parse(ok), ok);
  assert.throws(() => schema.parse({ ...ok, mode: "other" }));
  assert.throws(() => schema.parse({ ...ok, count: "2" }));
});

test("unknown types degrade to unknown instead of failing", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { weird: { type: "null-ish" } },
    required: ["weird"],
  });
  const schema = z.object(shape);
  assert.deepEqual(schema.parse({ weird: { anything: 1 } }), { weird: { anything: 1 } });
});

test("descriptions are preserved on the zod types", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { command: { type: "string", description: "shell command" } },
    required: ["command"],
  });
  assert.equal(shape["command"]!.description, "shell command");
});
