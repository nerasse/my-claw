import test from "node:test";
import assert from "node:assert/strict";
import { ModelPicker } from "../src/channels/model-picker.ts";

const picker = new ModelPicker([
  { id: "accounts/fireworks/models/kimi-k2p5-turbo", label: "Kimi K2.5 Turbo" },
  { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B" },
  { id: "accounts/fireworks/models/deepseek-v3", label: "DeepSeek V3" },
]);

test("ModelPicker builds buttons and parses callbacks", () => {
  const buttons = picker.buildButtons("accounts/fireworks/models/llama-v3p3-70b-instruct");

  assert.equal(picker.hasModels(), true);
  assert.equal(buttons.length, 3);
  assert.match(buttons[1]?.label ?? "", /selected/);
  assert.equal(buttons[1]?.action, "mdl:1");
  assert.equal(picker.parseCallback("mdl:1"), "accounts/fireworks/models/llama-v3p3-70b-instruct");
  assert.equal(picker.parseCallback("mdl:99"), null);
  assert.equal(picker.parseCallback("bad"), null);
});

test("ModelPicker finds models by id label and fuzzy short name", () => {
  assert.equal(picker.find("Kimi K2.5 Turbo")?.id, "accounts/fireworks/models/kimi-k2p5-turbo");
  assert.equal(picker.find("llama-v3p3-70b-instruct")?.id, "accounts/fireworks/models/llama-v3p3-70b-instruct");
  assert.equal(picker.find("deepseek")?.id, "accounts/fireworks/models/deepseek-v3");
  assert.equal(picker.find("unknown"), null);
  assert.equal(picker.labelFor("missing-model"), "missing-model");
});
