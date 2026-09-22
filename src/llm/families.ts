import type { ReasoningField } from "../core/config.ts";

/**
 * What a model family states about its members, whichever provider serves them.
 *
 * Some facts are the model's own and no endpoint publishes them *for us*: a reseller lists an id
 * and nothing else, and models.dev only describes the providers it knows. MiMo is the case this
 * was written for (measured 2026-09-21): `litellm/mimo-v2.6-pro` resolved with no metadata at all,
 * so the field its reasoning has to be replayed in, the output budget its thinking eats into, and
 * its ability to take an image were left to the owner to declare by hand.
 *
 * A family fills only what is still empty. A declaration, OpenRouter and models.dev all speak
 * first; this is the last rung, and it exists because the alternative is nothing at all.
 * See docs/model-metadata.md.
 */
export interface FamilyDefaults {
  reasoningField?: ReasoningField;
  vision?: boolean;
  limit?: { output?: number };
}

interface FamilyRule {
  match: RegExp;
  defaults: FamilyDefaults;
}

/**
 * The model's own name, without the reference's provider prefix: a family is a fact about the
 * model, and `litellm/mimo-v2.6-pro` and `opencode-go/mimo-v2.6-pro` are the same model. Also
 * strips a marketplace namespace, so `xiaomi/mimo-v2.5` reads the same as a bare id.
 */
function bareIdOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Ordered, first match wins: a version-scoped rule sits above its family's general one.
 *
 * The separator in each pattern is load-bearing -- `mimosa-1` is not a MiMo.
 */
const FAMILIES: readonly FamilyRule[] = [
  {
    // Every v2.6 tier is multimodal (models.dev lists text, image, audio and video for pro, flash
    // and ultraspeed alike), which is what routes an image run here instead of to the vision
    // fallback.
    match: /^mimo-v2\.6([-._]|$)/i,
    defaults: { reasoningField: "reasoning_content", vision: true, limit: { output: 131072 } },
  },
  {
    // The pass-back field is the same across versions: every MiMo row models.dev publishes that
    // names one names `reasoning_content`, and Xiaomi documents it as required once tools are in
    // play ("must completely pass back the reasoning_content field, otherwise the API will return
    // a 400 error"). Vision is deliberately absent here: `mimo-v2-pro` and `mimo-v2-flash` are
    // text-only, so it is not a family fact.
    //
    // The output budget is: "max_completion_tokens limits the total length of thinking content and
    // the final answer [...] it is recommended to set a sufficient max_completion_tokens to avoid
    // answer truncation." 131072 is models.dev's own value for the models that publish one.
    match: /^mimo([-._]|$)/i,
    defaults: { reasoningField: "reasoning_content", limit: { output: 131072 } },
  },
];

export function familyDefaultsOf(id: string): FamilyDefaults | undefined {
  const bare = bareIdOf(id);
  return FAMILIES.find((rule) => rule.match.test(bare))?.defaults;
}
