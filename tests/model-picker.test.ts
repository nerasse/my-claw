import { test } from "bun:test";
import assert from "node:assert/strict";
import { ModelPicker, formatModelGroupSummary } from "../src/channels/model-picker.ts";

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

test("parseCallback resolves a model ref back to its id", () => {
  const picker = new ModelPicker(models);
  const id = "accounts/fireworks/models/kimi-k2p6-turbo";
  assert.equal(picker.parseCallback(`mdl:${picker.refForModel(id)}`), id);
  assert.equal(picker.parseCallback(`mdl:${picker.refForModel("claude-sonnet-4")}`), "claude-sonnet-4");
});

test("parseCallback returns null for invalid", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.parseCallback("mdl:deadbeefdead"), null);
  assert.equal(picker.parseCallback("foo"), null);
});

test("a model ref survives reordering, unlike a position", () => {
  // A menu can outlive a discovery refresh that reorders the list; the button must still mean
  // the model it was rendered for.
  const picker = new ModelPicker(models);
  const data = picker.buildButtons("claude-sonnet-4")[1]?.action ?? "";
  picker.setModels([{ id: "brand-new", label: "New" }, ...models]);
  assert.equal(picker.parseCallback(data), "claude-sonnet-4");
});

test("a ref for a model that is gone reports staleness instead of picking a neighbour", () => {
  const picker = new ModelPicker(models);
  const data = picker.buildButtons("")[1]?.action ?? "";
  picker.setModels([{ id: "only-one", label: "Only" }]);
  assert.equal(picker.parseCallback(data), null);
  assert.deepEqual(picker.parseCallbackAction(data), { kind: "stale" });
  // Data that is not ours still falls through so other features keep their callbacks.
  assert.equal(picker.parseCallbackAction("nope"), null);
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
    { label: "MiMo [selected]", action: `mdl:${picker.refForModel("mimo")}` },
    { label: "Qwen", action: `mdl:${picker.refForModel("qwen")}` },
    { label: "Claude >", action: `mdlg:${picker.refForGroup("Claude")}` },
    { label: "Google >", action: `mdlg:${picker.refForGroup("Google")}` },
  ]);
});

test("root marks the group containing the current model", () => {
  const picker = new ModelPicker(grouped);
  const buttons = picker.buildButtons("claude-opus-4-8");
  assert.equal(buttons.find((b) => b.action === `mdlg:${picker.refForGroup("Claude")}`)?.label, "Claude > [selected]");
});

test("group buttons list the group models + a back entry", () => {
  const picker = new ModelPicker(grouped);
  const buttons = picker.buildGroupButtons("Claude", "claude-opus-4-8");
  assert.deepEqual(buttons, [
    { label: "sonnet", action: `mdl:${picker.refForModel("claude-sonnet-5")}` },
    { label: "opus [selected]", action: `mdl:${picker.refForModel("claude-opus-4-8")}` },
    { label: "< Back", action: "mdlb" },
  ]);
});

test("parseCallbackAction distinguishes select / openGroup / back", () => {
  const picker = new ModelPicker(grouped);
  assert.deepEqual(picker.parseCallbackAction(`mdl:${picker.refForModel("claude-opus-4-8")}`), {
    kind: "select",
    modelId: "claude-opus-4-8",
  });
  assert.deepEqual(picker.parseCallbackAction(`mdlg:${picker.refForGroup("Google")}`), {
    kind: "openGroup",
    groupPath: "Google",
  });
  assert.deepEqual(picker.parseCallbackAction("mdlb"), { kind: "back" });
  assert.deepEqual(picker.parseCallbackAction("mdlg:aaaaaaaaaaaa"), { kind: "stale" });
  assert.equal(picker.parseCallbackAction("nope"), null);
});

test("buildGroupButtons falls back to root for a group that no longer exists", () => {
  const picker = new ModelPicker(grouped);
  assert.deepEqual(picker.buildGroupButtons("Vanished", "mimo"), picker.buildButtons("mimo"));
});

test("formatModelGroupSummary: one line per top-level group with counts + current marker", () => {
  const lines = formatModelGroupSummary(grouped, "claude-sonnet-5");
  assert.deepEqual(lines, [
    "- Claude: 2 models (current here)",
    "- Google: 1 model",
    "- MiMo",
    "- Qwen",
  ]);
});

test("formatModelGroupSummary: nested groups count under their top-level segment", () => {
  const nested = [
    { id: "a", label: "A", group: "Claude/Sonnet" },
    { id: "b", label: "B", group: "Claude/Opus" },
    { id: "c", label: "C", group: "LiteLLM" },
  ];
  assert.deepEqual(formatModelGroupSummary(nested, "b"), [
    "- Claude: 2 models (current here)",
    "- LiteLLM: 1 model",
  ]);
});

test("no groups keeps a flat root menu", () => {
  const picker = new ModelPicker([{ id: "a", label: "A" }]);
  assert.equal(picker.hasGroups(), false);
  assert.deepEqual(picker.buildButtons("a"), [{ label: "A [selected]", action: `mdl:${picker.refForModel("a")}` }]);
});

// --- Nested groups (2-level version submenu) ---

const nested = [
  { id: "mimo", label: "MiMo" },
  { id: "claude-sonnet-5", label: "Sonnet", group: "Claude" },
  { id: "claude-opus-4-8", label: "Opus 4.8", group: "Claude/Opus" },
  { id: "claude-opus-4-5", label: "Opus 4.5", group: "Claude/Opus" },
];

test("nested: groupOrder includes intermediate paths", () => {
  const picker = new ModelPicker(nested);
  assert.deepEqual(picker.groupOrder(), ["Claude", "Claude/Opus"]);
});

test("nested: root shows ungrouped model + top-level group only", () => {
  const picker = new ModelPicker(nested);
  assert.deepEqual(picker.buildButtons("mimo"), [
    { label: "MiMo [selected]", action: `mdl:${picker.refForModel("mimo")}` },
    { label: "Claude >", action: `mdlg:${picker.refForGroup("Claude")}` },
  ]);
});

test("nested: Claude node shows its model + Opus subgroup + back-to-root", () => {
  const picker = new ModelPicker(nested);
  const buttons = picker.buildGroupButtons("Claude", "claude-opus-4-8");
  assert.deepEqual(buttons, [
    { label: "Sonnet", action: `mdl:${picker.refForModel("claude-sonnet-5")}` },
    { label: "Opus > [selected]", action: `mdlg:${picker.refForGroup("Claude/Opus")}` },
    { label: "< Back", action: "mdlb" },
  ]);
});

test("nested: Opus node lists versions + back-to-parent-group", () => {
  const picker = new ModelPicker(nested);
  const buttons = picker.buildGroupButtons("Claude/Opus", "claude-opus-4-5");
  assert.deepEqual(buttons, [
    { label: "Opus 4.8", action: `mdl:${picker.refForModel("claude-opus-4-8")}` },
    { label: "Opus 4.5 [selected]", action: `mdl:${picker.refForModel("claude-opus-4-5")}` },
    { label: "< Back", action: `mdlg:${picker.refForGroup("Claude")}` },
  ]);
});

// --- Effort menu ---

const effortPicker = () =>
  new ModelPicker([{ id: "a", label: "A" }], { enabled: true, levels: ["low", "medium", "high", "xhigh", "max"] });

test("effort: root menu has an Effort entry to adjust without re-selecting a model", () => {
  const buttons = effortPicker().buildButtons("a");
  assert.deepEqual(buttons.at(-1), { label: "Effort >", action: "effm" });
});

test("effort: root menu has no effort entry when disabled", () => {
  assert.equal(new ModelPicker([{ id: "a", label: "A" }]).buildButtons("a").some((b) => b.action === "effm"), false);
});

test("effort: header suffix reflects current level when enabled", () => {
  assert.equal(effortPicker().effortHeaderSuffix("high"), " — Effort: high");
  assert.equal(effortPicker().effortHeaderSuffix(), " — Effort: default");
});

test("effort: no header suffix when disabled", () => {
  const picker = new ModelPicker([{ id: "a", label: "A" }]);
  assert.equal(picker.effortHeaderSuffix("high"), "");
  assert.deepEqual(picker.effortLevels(), []);
});

test("effort: submenu marks current level + back to root", () => {
  const buttons = effortPicker().buildEffortButtons("medium");
  assert.deepEqual(buttons, [
    { label: "low", action: "eff:low" },
    { label: "medium [selected]", action: "eff:medium" },
    { label: "high", action: "eff:high" },
    { label: "xhigh", action: "eff:xhigh" },
    { label: "max", action: "eff:max" },
    { label: "< Back", action: "mdlb" },
  ]);
});

test("effort: parseCallbackAction handles openEffort and setEffort", () => {
  const picker = effortPicker();
  assert.deepEqual(picker.parseCallbackAction("effm"), { kind: "openEffort" });
  assert.deepEqual(picker.parseCallbackAction("eff:xhigh"), { kind: "setEffort", level: "xhigh" });
  assert.equal(picker.parseCallbackAction("eff:bogus"), null);
});

test("effort: chained submenu replaces back with a keep-current entry", () => {
  const buttons = effortPicker().buildEffortButtons("medium", { chained: true });
  assert.deepEqual(buttons.at(-1), { label: "Keep current (medium)", action: "effk" });
  assert.equal(buttons.some((b) => b.action === "mdlb"), false);

  const noEffort = effortPicker().buildEffortButtons(undefined, { chained: true });
  assert.deepEqual(noEffort.at(-1), { label: "Keep current (default)", action: "effk" });
});

test("effort: parseCallbackAction handles keepEffort", () => {
  assert.deepEqual(effortPicker().parseCallbackAction("effk"), { kind: "keepEffort" });
});

test("effort: effortLevelsFor falls back to global when model has no override", () => {
  const picker = effortPicker();
  assert.deepEqual(picker.effortLevelsFor("a"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(picker.effortLevelsFor("unknown"), ["low", "medium", "high", "xhigh", "max"]);
});

test("effort: effortLevelsFor returns per-model levels when set", () => {
  const picker = new ModelPicker(
    [
      { id: "full", label: "Full", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "limited", label: "Limited", supportedEffortLevels: ["high", "max"] },
      { id: "none", label: "None" },
    ],
    { enabled: true, levels: ["low", "medium", "high", "xhigh", "max"] },
  );
  assert.deepEqual(picker.effortLevelsFor("full"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(picker.effortLevelsFor("limited"), ["high", "max"]);
  assert.deepEqual(picker.effortLevelsFor("none"), ["low", "medium", "high", "xhigh", "max"]);
});

test("effort: buildEffortButtons filters levels per model when currentModelId given", () => {
  const picker = new ModelPicker(
    [
      { id: "full", label: "Full", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "limited", label: "Limited", supportedEffortLevels: ["high", "max"] },
    ],
    { enabled: true, levels: ["low", "medium", "high", "xhigh", "max"] },
  );
  const fullButtons = picker.buildEffortButtons(undefined, { currentModelId: "full" });
  assert.deepEqual(fullButtons.map((b) => b.action), ["eff:low", "eff:medium", "eff:high", "eff:xhigh", "eff:max", "mdlb"]);

  const limitedButtons = picker.buildEffortButtons(undefined, { currentModelId: "limited" });
  assert.deepEqual(limitedButtons.map((b) => b.action), ["eff:high", "eff:max", "mdlb"]);

  const chainedLimited = picker.buildEffortButtons("max", { chained: true, currentModelId: "limited" });
  assert.deepEqual(chainedLimited.map((b) => b.action), ["eff:high", "eff:max", "effk"]);
});



test("effortLevelsFor: a model the provider says has no effort gets no levels", () => {
  const picker = new ModelPicker(
    [
      { id: "haiku", label: "Haiku 4.5", supportsEffort: false },
      { id: "opus", label: "Opus 4.8", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
      { id: "legacy", label: "Legacy" },
    ],
    { enabled: true, levels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  );
  // Explicit false is a fact from the provider, not a missing value: offering the global list
  // here would propose levels the model rejects.
  assert.deepEqual(picker.effortLevelsFor("haiku"), []);
  assert.deepEqual(picker.effortLevelsFor("opus"), ["low", "max"]);
  // Unknown stays a best guess rather than silently disabling effort.
  assert.deepEqual(picker.effortLevelsFor("legacy"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
});

test("buildEffortButtons: a no-effort model offers navigation only", () => {
  const picker = new ModelPicker(
    [{ id: "haiku", label: "Haiku 4.5", supportsEffort: false }],
    { enabled: true, levels: ["low", "high"] },
  );
  assert.deepEqual(
    picker.buildEffortButtons(undefined, { currentModelId: "haiku" }).map((b) => b.action),
    ["mdlb"],
  );
});
