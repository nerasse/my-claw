import { test } from "bun:test";
import assert from "node:assert/strict";
import { ModelPicker, formatModelGroupSummary } from "../src/channels/model-picker.ts";
import type { EffectiveEffort } from "../src/llm/resolver.ts";
import type { EffortLevel } from "../src/core/config.ts";

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

const at = (level: EffortLevel, source: EffectiveEffort["source"] = "session"): EffectiveEffort => ({ level, source });
const NOT_SET: EffectiveEffort = { source: "provider-default" };
const UNSUPPORTED: EffectiveEffort = { source: "unsupported" };

test("effort: root menu has an Effort entry to adjust without re-selecting a model", () => {
  const buttons = effortPicker().buildButtons("a");
  assert.deepEqual(buttons.at(-1), { label: "Effort >", action: "effm" });
});

test("effort: root menu has no effort entry when disabled", () => {
  assert.equal(new ModelPicker([{ id: "a", label: "A" }]).buildButtons("a").some((b) => b.action === "effm"), false);
});

test("effort: header suffix names the level and where it comes from", () => {
  // "high because you asked" and "high because the SDK falls back to it" are different answers,
  // and the old bare "default" gave neither.
  assert.equal(effortPicker().effortHeaderSuffix(at("high")), " — Effort: high (session)");
  assert.equal(effortPicker().effortHeaderSuffix(at("high", "sdk-default")), " — Effort: high (SDK default)");
  assert.equal(effortPicker().effortHeaderSuffix(at("medium", "config")), " — Effort: medium (config)");
  assert.equal(effortPicker().effortHeaderSuffix(at("low", "model")), " — Effort: low (model default)");
  assert.equal(effortPicker().effortHeaderSuffix(NOT_SET), " — Effort: provider default (nothing sent)");
});

test("effort: no header suffix for a model that discards effort", () => {
  // The line used to show up for every model as soon as any model supported effort, which
  // advertised a setting with no effect on the current one.
  assert.equal(effortPicker().effortHeaderSuffix(UNSUPPORTED), "");
});

test("effort: no header suffix when disabled", () => {
  const picker = new ModelPicker([{ id: "a", label: "A" }]);
  assert.equal(picker.effortHeaderSuffix(UNSUPPORTED), "");
  assert.deepEqual(picker.effortLevels(), []);
});

test("effort: submenu marks current level + back to root", () => {
  const buttons = effortPicker().buildEffortButtons(at("medium"));
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
  const buttons = effortPicker().buildEffortButtons(at("medium"), { chained: true });
  assert.deepEqual(buttons.at(-1), { label: "Keep current: medium (session)", action: "effk" });
  assert.equal(buttons.some((b) => b.action === "mdlb"), false);

  const noEffort = effortPicker().buildEffortButtons(NOT_SET, { chained: true });
  assert.deepEqual(noEffort.at(-1), { label: "Keep current: provider default (nothing sent)", action: "effk" });
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
  const fullButtons = picker.buildEffortButtons(NOT_SET, { currentModelId: "full" });
  assert.deepEqual(fullButtons.map((b) => b.action), ["eff:low", "eff:medium", "eff:high", "eff:xhigh", "eff:max", "mdlb"]);

  const limitedButtons = picker.buildEffortButtons(NOT_SET, { currentModelId: "limited" });
  assert.deepEqual(limitedButtons.map((b) => b.action), ["eff:high", "eff:max", "mdlb"]);

  const chainedLimited = picker.buildEffortButtons(at("max"), { chained: true, currentModelId: "limited" });
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
    picker.buildEffortButtons(NOT_SET, { currentModelId: "haiku" }).map((b) => b.action),
    ["mdlb"],
  );
});

test("syncFromConfig hides effort for a model the parameter never reaches", () => {
  // The picker cannot see the backend on its own, so this projection is the only place that knows
  // an OpenAI-compatible model with no opt-in silently discards effort.
  const picker = new ModelPicker([]);
  picker.syncFromConfig({
    defaultProvider: "litellm",
    defaultModel: "mimo",
    providers: { litellm: { baseUrl: "https://x/v1" }, anthropic: { type: "claude-sdk" } },
    models: [
      { id: "mimo", label: "MiMo", provider: "litellm" },
      { id: "grok", label: "Grok", provider: "litellm", supportsEffort: true },
      { id: "sonnet", label: "Sonnet", provider: "anthropic" },
    ],
  });

  assert.deepEqual(picker.effortLevelsFor("mimo"), []);
  assert.equal(picker.buildButtons("mimo").some((b) => b.action === "effm"), false);

  assert.ok(picker.effortLevelsFor("sonnet").length > 0);
  assert.equal(picker.buildButtons("sonnet").some((b) => b.action === "effm"), true);
  assert.equal(picker.buildButtons("grok").some((b) => b.action === "effm"), true);
});

test("syncFromConfig keeps the model list and effort options in step", () => {
  const picker = new ModelPicker([{ id: "stale", label: "Stale" }], { enabled: true, levels: ["low"] });
  picker.syncFromConfig({
    defaultProvider: "litellm",
    defaultModel: "mimo",
    providers: { litellm: { baseUrl: "https://x/v1" } },
    models: [{ id: "mimo", label: "MiMo", provider: "litellm" }],
  });
  assert.equal(picker.labelFor("stale"), "stale");
  assert.equal(picker.labelFor("mimo"), "MiMo");
  // No model can honor effort and no global default is set, so the whole effort UI stays off.
  assert.deepEqual(picker.effortLevels(), []);
});

/** Context step: chained after effort, and also reachable from the root.
 *  See docs/context-window.md. */

const tiers = [
  { tokens: 1_048_576, label: "Full: 1,048,576", selected: false },
  { ceiling: 512_000, tokens: 512_000, label: "512,000 (cap)", selected: true },
  { ceiling: 128_000, tokens: 128_000, label: "128,000", selected: false },
];

test("the context entry appears only when there is more than one ceiling to choose", () => {
  const picker = new ModelPicker(models);
  assert.ok(picker.buildButtons("llama-3.3-70b", undefined, { contextChoice: true }).some((b) => b.label === "Context >"));
  // A lone option is not a choice, so the entry stays hidden.
  assert.ok(!picker.buildButtons("llama-3.3-70b", undefined, { contextChoice: false }).some((b) => b.label === "Context >"));
  assert.ok(!picker.buildButtons("llama-3.3-70b").some((b) => b.label === "Context >"));
});

test("the context entry is offered on an agent menu too, unlike effort", () => {
  const picker = new ModelPicker(models);
  // A research sub-agent and a cron job do not want the same window, and each is set independently.
  const buttons = picker.buildButtons("llama-3.3-70b", "research", { contextChoice: true });
  assert.ok(buttons.some((b) => b.label === "Context >"));
});

test("every tier is rendered and the active one is marked", () => {
  const picker = new ModelPicker(models);
  const buttons = picker.buildContextButtons(tiers);
  assert.deepEqual(buttons.map((b) => b.label), ["Full: 1,048,576", "512,000 (cap) [selected]", "128,000", "< Back"]);
  assert.deepEqual(buttons.map((b) => b.action), ["ctx:full", "ctx:512000", "ctx:128000", "mdlb"]);
});

test("chained after effort, the escape keeps the current window instead of going back", () => {
  const picker = new ModelPicker(models);
  const buttons = picker.buildContextButtons(tiers, { chained: true });
  // Returning to the model menu mid-flow would undo the point of the chain.
  assert.equal(buttons.at(-1)?.label, "Keep current: 512,000 (cap)");
  assert.equal(buttons.at(-1)?.action, "ctxk");
});

test("an agent target rides along on every context action, or the submenu edits the wrong thing", () => {
  // The picker has to be told which agents exist: targets are now names from `agents/`, not a
  // closed union, so a code it cannot resolve is refused rather than guessed.
  const picker = new ModelPicker(models, undefined, () => ["general", "research"]);
  for (const button of picker.buildContextButtons(tiers, { target: "research" })) {
    const parsed = picker.parseCallbackAction(button.action);
    assert.ok(parsed && "target" in parsed && parsed.target === "research", button.action);
  }
});

test("a target the picker does not know is refused, never resolved to another agent", () => {
  const picker = new ModelPicker(models, undefined, () => ["general"]);
  const stale = new ModelPicker(models, undefined, () => ["general", "research"])
    .buildContextButtons(tiers, { target: "research" })[0]!.action;
  // `research` vanished from `agents/` while the menu was open. Writing config for whichever
  // agent happened to share the slot is the outcome this must make impossible.
  assert.equal(picker.parseCallbackAction(stale), null);
});

test("the orchestrator keeps its historic one-letter code", () => {
  const picker = new ModelPicker(models, undefined, () => []);
  const action = picker.buildContextButtons(tiers, { target: "orchestrator" })[0]!.action;
  assert.ok(action.endsWith("@o"), action);
  assert.deepEqual(picker.parseCallbackAction(action), { kind: "setContext", choice: "full", target: "orchestrator" });
});

test("context callbacks round-trip through the parser", () => {
  const picker = new ModelPicker(models);
  assert.deepEqual(picker.parseCallbackAction("ctxm"), { kind: "openContext" });
  assert.deepEqual(picker.parseCallbackAction("ctxk"), { kind: "keepContext" });
  assert.deepEqual(picker.parseCallbackAction("ctx:full"), { kind: "setContext", choice: "full" });
  assert.deepEqual(picker.parseCallbackAction("ctx:128000"), { kind: "setContext", choice: 128_000 });
});

test("a zero or unparsable ceiling is refused rather than meaning no window at all", () => {
  const picker = new ModelPicker(models);
  assert.equal(picker.parseCallbackAction("ctx:0"), null);
  assert.equal(picker.parseCallbackAction("ctx:abc"), null);
});

test("every context action fits Telegram's 64-byte callback budget", () => {
  const picker = new ModelPicker(models);
  for (const button of picker.buildContextButtons(tiers, { target: "research" })) {
    assert.ok(Buffer.byteLength(button.action) <= 64, button.action);
  }
});

test("every button the context submenu renders parses back into an intent", () => {
  const picker = new ModelPicker(models);
  // Asserting the parser accepts the literals is not enough: a typo in a button's action would
  // ship a dead key that answers nothing when pressed.
  assert.deepEqual(
    picker.buildContextButtons(tiers).map((b) => picker.parseCallbackAction(b.action)?.kind),
    ["setContext", "setContext", "setContext", "back"],
  );
  assert.deepEqual(
    picker.buildContextButtons(tiers, { chained: true }).map((b) => picker.parseCallbackAction(b.action)?.kind),
    ["setContext", "setContext", "setContext", "keepContext"],
  );
});

test("syncFromConfig prepends the virtual Default tag and one entry per tag under Tags", () => {
  const picker = new ModelPicker(models);
  picker.syncFromConfig(
    {
      defaultModel: "claude-sonnet-4",
      providers: {},
      models,
    },
    { opus: { model: "claude-opus-4-8" }, sonnet: { model: "claude-sonnet-4" } },
  );
  const options = picker.options();
  assert.equal(options.length, models.length + 3);
  assert.deepEqual(options.slice(0, 3).map((m) => m.id), ["tag:Default", "tag:opus", "tag:sonnet"]);
  assert.ok(options.every((m) => m.group === "Tags" || m.group === undefined));
  assert.equal(options[0]?.provider, "tags");
  assert.equal(picker.providerFor("tag:opus"), "tags");
  assert.equal(picker.labelFor("tag:opus"), "opus");
});

test("syncFromConfig with no tags still rows the virtual Default tag", () => {
  const picker = new ModelPicker(models);
  picker.syncFromConfig({ defaultModel: "claude-sonnet-4", providers: {}, models });
  assert.equal(picker.options()[0]?.id, "tag:Default");
  assert.equal(picker.options().length, models.length + 1);
});
