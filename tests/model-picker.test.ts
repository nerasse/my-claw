import { test } from "bun:test";
import assert from "node:assert/strict";
import { ModelPicker } from "../src/channels/model-picker.ts";

const models = [
  { id: "accounts/fireworks/models/kimi-k2p6-turbo", label: "Kimi K2.6 Turbo" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "llama-3.3-70b", label: "Llama 3.3 70B" },
];

test("find by exact id", () => {
  const picker = new ModelPicker(models);
  const result = picker.find("claude-sonnet-4");
  assert.ok(result);
  assert.equal(result?.id, "claude-sonnet-4");
});

test("find by exact label", () => {
  const picker = new ModelPicker(models);
  const result = picker.find("Claude Sonnet 4");
  assert.ok(result);
  assert.equal(result?.id, "claude-sonnet-4");
});

test("find by partial label", () => {
  const picker = new ModelPicker(models);
  const result = picker.find("sonnet");
  assert.ok(result);
  assert.equal(result?.id, "claude-sonnet-4");
});

test("find by partial id tail", () => {
  const picker = new ModelPicker(models);
  const result = picker.find("k2p6");
  assert.ok(result);
  assert.equal(result?.id, "accounts/fireworks/models/kimi-k2p6-turbo");
});

test("find returns null for unknown", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.find("gpt-4"), null);
});

test("find empty query returns null", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.find(""), null);
});

test("labelFor returns label if known", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.labelFor("claude-sonnet-4"), "Claude Sonnet 4");
});

test("labelFor falls back to id", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.labelFor("unknown"), "unknown");
});

test("hasModels is true when non-empty", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.hasModels(), true);
});

test("hasModels is false when empty", () => {
  const picker = new ModelPicker([]);
  assert.equal(picker.hasModels(), false);
});

test("buildButtons marks current model", () => {
  const picker = new ModelPicker(models);
  const buttons = picker.buildButtons("claude-sonnet-4");
  assert.equal(buttons[0]?.label, "Kimi K2.6 Turbo");
  assert.equal(buttons[1]?.label, "Claude Sonnet 4 [selected]");
});

test("parseCallback returns model id by index", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.parseCallback("mdl:0"), "accounts/fireworks/models/kimi-k2p6-turbo");
  assert.equal(picker.parseCallback("mdl:1"), "claude-sonnet-4");
});

test("parseCallback returns null for invalid", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.parseCallback("mdl:99"), null);
  assert.equal(picker.parseCallback("foo"), null);
});

test("find prefers exact match over partial", () => {
  const picker = new ModelPicker([
    { id: "abc", label: "abc model" },
    { id: "abcd", label: "abcd model" },
  ]);
  const result = picker.find("abc");
  assert.equal(result?.id, "abc");
});
