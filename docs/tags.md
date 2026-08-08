# Tags: named aliases for a model combo

A tag pins a provider/model/effort/context combo under a name, and every place that accepts a
model id accepts the tag's reference instead. When the underlying model changes version, the tag
is updated once and every config that referenced it follows.

```
tags: {
  "opus":  { "model": "claude-opus-4-8",  "effort": "xhigh",  "contextCap": 100000 },
  "sonnet": { "model": "claude-sonnet-4-5" }
}
```

A tag is referenced as `tag:<name>` wherever a model id is expected:

- session override: `/model tag:opus`, or picking it in the app's model picker
- agent pin: `agents.<agent>.llm.defaultModel: "tag:opus"` (or `llm.defaultModel`)
- cron job: `model: "tag:opus"` in the job editor / `job.model`
- agent file frontmatter: `model: tag:opus`

## Resolution

`resolveFromMerged` (`src/llm/resolver.ts`) is the single funnel every run passes through. A
`tag:` reference is expanded there before the model lookup:

- the resolved config keeps the tag id as the run's identity (`model`), so status, the app and
  the context cap all talk about the tag;
- the API receives the tag's underlying model via `apiModel` (the three call sites:
  `src/llm/provider.ts`, `src/llm/codex.ts`, `src/agent/claude-sdk/backend.ts`);
- effort precedence: session override > tag effort > the job's own pin > the agent's own pin >
  global (`llm.effort`). The tag is indivisible: referencing it accepts both halves of it, so a
  scope-level pin (job, agent, global default) is only consulted when the tag pins none of its
  own. `llm.models[].effort` no longer exists;
- a tag may point at another tag; the chain is followed to a real model and the outer tag's
  effort/cap win;
- the reserved name `Default` is a virtual tag that always tracks the current default model
  (`llm.defaultModel`), never stored in the file.

## Context cap

The tag's `contextCap` is a per-run ceiling applied in `resolveContextWindow`
(`src/llm/context-window.ts`): session override > tag cap > agent cap > global cap. It is
deliberate per-tag policy, so it outranks the agent's standing ceiling for runs that go through
the tag.

## Where tags live

`config.json`, top-level `tags` section: a `Record<name, { model, effort?, contextCap? }>`.
Hot-reloadable like every object section; edits go through `setTag`/`deleteTag`
(`src/core/config-edit.ts`), so `/config history|diff|rollback` covers them for free.

The model picker carries tags as synthetic entries under a single `Tags` group
(`syncFromConfig` in `src/channels/model-picker.ts`), which is what every consumer reads: the
app's model list, the chat `/model` menu, and the `unknownModel` flags on jobs/agents. The
provider list gets a matching virtual `tags` provider row at the top.

## The app

`/tag` is handled natively by the app (it opens the tags page / tag editor); the phone's
Settings > Agents > Tags page is the CRUD surface. Wire frames: `tags.list`, `tags.upsert`,
`tags.delete`, answered with `tags.result`. The server validates the pinned model against the
picker catalog and the effort against the known levels.
