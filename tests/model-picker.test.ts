import { test } from "bun:test";
import assert from "node:assert/strict";
import { ModelPicker, formatGroupedModelList } from "../src/channels/model-picker.ts";

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

// --- Submenu grouping ---

const grouped = [
  { id: "mimo", label: "MiMo" },
  { id: "qwen", label: "Qwen" },
  { id: "claude-sonnet-5", label: "sonnet", group: "Claude" },
  { id: "claude-opus-4-8", label: "opus", group: "Claude" },
  { id: "gemini", label: "Gemini", group: "Google" },
];

test("groupOrder lists distinct groups in first-appearance order", () => {
  const picker = new ModelPicker(grouped);
  assert.deepEqual(picker.groupOrder(), ["Claude", "Google"]);
  assert.equal(picker.hasGroups(), true);
});

test("root buttons show ungrouped models then one entry per group", () => {
  const picker = new ModelPicker(grouped);
  const buttons = picker.buildButtons("mimo");
  assert.deepEqual(buttons, [
    { label: "MiMo [selected]", action: "mdl:0" },
    { label: "Qwen", action: "mdl:1" },
    { label: "Claude >", action: "mdlg:0" },
    { label: "Google >", action: "mdlg:1" },
  ]);
});

test("root marks the group containing the current model", () => {
  const picker = new ModelPicker(grouped);
  const buttons = picker.buildButtons("claude-opus-4-8");
  assert.equal(buttons.find((b) => b.action === "mdlg:0")?.label, "Claude > [selected]");
});

test("group buttons list the group models by absolute index + a back entry", () => {
  const picker = new ModelPicker(grouped);
  const buttons = picker.buildGroupButtons(0, "claude-opus-4-8");
  assert.deepEqual(buttons, [
    { label: "sonnet", action: "mdl:2" },
    { label: "opus [selected]", action: "mdl:3" },
    { label: "< Back", action: "mdlb" },
  ]);
});

test("parseCallbackAction distinguishes select / openGroup / back", () => {
  const picker = new ModelPicker(grouped);
  assert.deepEqual(picker.parseCallbackAction("mdl:3"), { kind: "select", modelId: "claude-opus-4-8" });
  assert.deepEqual(picker.parseCallbackAction("mdlg:1"), { kind: "openGroup", groupIndex: 1 });
  assert.deepEqual(picker.parseCallbackAction("mdlb"), { kind: "back" });
  assert.equal(picker.parseCallbackAction("mdlg:9"), null);
  assert.equal(picker.parseCallbackAction("nope"), null);
});

test("buildGroupButtons falls back to root for an out-of-range group", () => {
  const picker = new ModelPicker(grouped);
  assert.deepEqual(picker.buildGroupButtons(9, "mimo"), picker.buildButtons("mimo"));
});

test("formatGroupedModelList groups under headings with global indices", () => {
  const lines = formatGroupedModelList(grouped, "claude-sonnet-5");
  assert.deepEqual(lines, [
    "1. MiMo (mimo)",
    "2. Qwen (qwen)",
    "Claude:",
    "  3. sonnet (claude-sonnet-5) [selected]",
    "  4. opus (claude-opus-4-8)",
    "Google:",
    "  5. Gemini (gemini)",
  ]);
});

test("no groups keeps a flat root menu", () => {
  const picker = new ModelPicker([{ id: "a", label: "A" }]);
  assert.equal(picker.hasGroups(), false);
  assert.deepEqual(picker.buildButtons("a"), [{ label: "A [selected]", action: "mdl:0" }]);
});
