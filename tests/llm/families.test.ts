/**
 * What a model family states about its members, whichever provider serves them.
 *
 * Written for MiMo (measured 2026-09-21): `litellm/mimo-v2.6-pro` resolved with no metadata at
 * all -- no table describes a local gateway -- so the field its reasoning has to come back in and
 * the output budget its thinking eats into were left to a hand-written declaration.
 */

import { test, expect } from "bun:test";
import { familyDefaultsOf } from "../../src/llm/families.ts";

test("a v2.6 tier takes images, reads reasoning_content back and gets room for its thinking", () => {
  for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]) {
    expect(familyDefaultsOf(id)).toEqual({
      reasoningField: "reasoning_content",
      vision: true,
      limit: { output: 131072 },
    });
  }
});

test("the provider prefix and the marketplace namespace are not part of the model", () => {
  // The reference's provider is a local key; the model is the same one either way.
  expect(familyDefaultsOf("litellm/mimo-v2.6-pro")).toEqual(familyDefaultsOf("mimo-v2.6-pro"));
  expect(familyDefaultsOf("openrouter/xiaomi/mimo-v2.6-flash")).toEqual(familyDefaultsOf("mimo-v2.6-flash"));
  // A marketplace that spells the vendor into the name, in its own casing.
  expect(familyDefaultsOf("XiaomiMiMo/MiMo-V2.5-Pro")).toEqual({
    reasoningField: "reasoning_content",
    limit: { output: 131072 },
  });
});

test("vision is a v2.6 fact, not a family one: the text-only tiers do not get it", () => {
  // `mimo-v2-pro` and `mimo-v2-flash` take text only, so claiming otherwise would route an image
  // run to a model that cannot read it instead of to the vision fallback.
  const older = familyDefaultsOf("mimo-v2.5-pro");
  expect(older?.vision).toBeUndefined();
  expect(older?.reasoningField).toBe("reasoning_content");
});

test("a name that merely starts the same way is not a MiMo", () => {
  expect(familyDefaultsOf("mimosa-1")).toBeUndefined();
  expect(familyDefaultsOf("mimosa/1")).toBeUndefined();
  expect(familyDefaultsOf("gpt-5.6-luna")).toBeUndefined();
  expect(familyDefaultsOf("qwen3.8-max")).toBeUndefined();
});
