# Declaring models from the app

Every model in this house arrives one of two ways: a provider listed it (discovery), or its owner
wrote it down (`config.llm.models`). Discovery is automatic and self-correcting. Declarations were
hand-edited JSON, invisible from every surface, and silently authoritative. This document is how
they become editable, visible and reversible from the app.

## What went wrong, once, concretely

Three models sat in `config.llm.models` on the `litellm` provider. The gateway renamed its whole
catalogue (`Qwen3.6-35B-A3B-uncensored` became `Qwen3.6-35B-A3B-uncensored-MTP-Q3_K_M`) and dropped
the two others. From then on:

- the picker stopped offering them, correctly: `availabilityOf` returns `stale` for an id a
  provider answered about and did not list, and `runnableModels` filters those out;
- the owner had no way to see *why* three models he had declared were absent, because a filtered
  list cannot say what it removed;
- the utility fallback did not filter, so every compaction of a `claude-sdk` session resolved to a
  dead id and answered HTTP 400. The symptom was "compaction does nothing", never "that model is
  gone".

The fallback is fixed (docs/model-resolution.md). What remains is the visibility hole: a
declaration that outlives its model must be **shown and deletable**, not hidden.

## Two lists, and they are not the same list

| Question | Answer | Surface |
|---|---|---|
| What may I run right now? | `runnableModels`, availability `ready` only | every picker |
| What is declared, and what is its state? | everything, `stale` included, with a reason | the management view |

Conflating them is the whole bug. A picker that offers a dead model wastes a run; a management view
that hides one is a config you cannot fix from the app. So `model.list.result` carries both:
`models` stays exactly what it is today (offered, runnable) and gains an origin flag, and a second
array carries what exists but cannot run.

```ts
interface MyClawAppModelOption {
  // ... unchanged
  /** Set when a `config.llm.models` entry contributes this model, wholly or partly. */
  declared?: boolean;
}

interface MyClawAppModelListResult {
  type: "model.list.result";
  models: MyClawAppModelOption[];      // offered: unchanged semantics, no app can regress
  defaultModel: string;
  /** Declared or discovered, known and not runnable. Never offered, always shown in management. */
  unavailable: Array<{
    id: string;
    label: string;
    provider?: string;
    declared?: boolean;
    /** Why, in the words of run-model.ts: stale | no-key | no-auth. */
    state: "stale" | "no-key" | "no-auth";
    /** Ready to print: "litellm no longer lists it", "LITELLM_API_KEY is not set". */
    reason: string;
  }>;
}
```

The app's existing pickers read `models` and are untouched. Only the new screen reads `unavailable`.
That is deliberate: enriching `models` with dead entries would have required auditing every consumer
in the app, and one missed filter turns into a 400 the owner cannot explain.

## An override is a declaration that shares an id

`mergeModels` puts config entries ahead of discovery, so declaring `litellm/zai-glm-5-2` while the
provider also lists it makes the declaration win. That is the mechanism behind "edit a discovered
model": there is no separate override concept, only a declaration with the same id.

**The merge becomes field-level.** Today a colliding declaration *replaces* the discovered entry
outright. That never mattered while declarations used bare ids and discovery used qualified ones, so
no id ever actually collided. It matters the moment the app can write a qualified declaration: an
owner fixing a context window would silently drop `apiId`, `family`, `supportsEffort`,
`supportedEffortLevels` and `thinkingTypes` for that model, and losing `thinkingTypes` on an
Anthropic model is an HTTP 400 (`thinking.type` is per-model, docs/anthropic-backend.md).

So: **declared fields win, discovered fields fill the rest.** Which means the app stores only what
the owner actually changed, and everything untouched keeps following discovery. A gateway that bumps
a context window still propagates; the one field you pinned stays pinned. Freezing a full copy
instead would be simpler to write and wrong for exactly the reason this document opens with.

Removing the declaration is therefore also the "reset to discovered" action. One verb, no second
concept.

## The frames

```ts
{ type: "models.upsert", entry: LlmModelConfig }   // create or replace one declaration, by id
{ type: "models.remove", id: string }              // delete the declaration (reset to discovered)
```

Both answer with a broadcast `model.list.result`, the same way `providers.upsert` answers with the
provider list: the app never patches its own copy, it re-reads the truth. Both go through
`config-edit.ts`, so both get the snapshot, the health gate and `/config rollback` for free.

### Validation, refused before the write

| Rule | Why |
|---|---|
| `id` non-empty, no whitespace, no `@` | `@` is the endpoint separator of the reference grammar (docs/model-identity.md) |
| `id` is not `tag:<name>` | tag references are synthetic picker entries, not models |
| `provider` names a declared provider | a declaration on a provider that does not exist can never run |
| `apiId` required when `id` is provider-qualified and differs | otherwise the wire id is a guess |
| `limit.context`, `limit.output` positive integers when present | a 0 window trims every message to nothing |
| `supportedEffortLevels` within `none low medium high xhigh max` | an unknown rung is a 400 on the first call |
| `thinkingTypes` carries both booleans when present | half a capability is not a capability |

A refusal answers `settings.refused` with the field and the reason, like every other settings write.

## The app

Models belong to a provider, so they live in the provider's page. `ProviderScreen` already lists
that provider's models with a search box; it gains:

- a **Déclarés** section at the top: the `config.llm.models` entries for this provider, each with a
  badge (`custom` when discovery does not know the id, `override` when it does), plus the
  `unavailable` ones for this provider with their state badge and reason line;
- **+ Ajouter un modèle**, which opens the editor empty with `provider` pinned;
- a tap on any model in the discovered list opens the editor **prefilled with the effective values**
  (what the resolver would use), so "modifier" is one gesture and the form always shows the truth;
- **Supprimer** on a declaration, worded as "réinitialiser" when the id is also discovered, because
  that is what it does.

The editor exposes every field of `LlmModelConfig`: `id`, `label`, `apiId`, `provider`, `group`,
`family`, `vision`, `limit.context`, `limit.output`, `supportsEffort`, `supportedEffortLevels`,
`thinkingTypes.adaptive`, `thinkingTypes.enabled`. A field left at its discovered value is not
written (field-level merge, above). `contextFrom` is display-only, never editable: it records where
a window came from and writing it by hand would lie about that.

## Tests

- `config-edit`: upsert creates, upsert by same id replaces, remove deletes, remove of an unknown id
  is a refusal not a silent success, and each write lands in the snapshot store.
- validation: one test per row of the table above.
- `mergeModels`: a colliding declaration keeps the discovered `thinkingTypes` and `apiId` while its
  own `limit` wins. This is the regression that the field-level merge exists to prevent.
- `model.list`: a `stale` declaration appears in `unavailable` with its reason and never in `models`.
- app: the whitelist in `parseServerFrame` must hold the new frames (its `FRAME_TYPES` is typed
  `Record<ServerFrame['type'], true>`, so the compiler enforces it), and the new section renders
  from a fixture carrying one custom, one override and one stale entry.

## Release

Server and app ship together: the app reads `unavailable` and sends `models.*`, neither of which an
older peer knows. my-claw and my-claw-app, one version each, in that order.
