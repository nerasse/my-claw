# Tags: ordered model routes

A tag is a stable name for an ordered route of concrete model candidates. Every place that accepts
an id accepts the tag reference, while each candidate carries its own effort and context cap.
Candidates are never tags themselves: routes do not nest and cannot form cycles.

```
tags: {
  "Cheap": {
    "route": [
      { "model": "anthropic/claude-sonnet-5", "effort": "max", "contextCap": 512000 },
      { "model": "opencode_go/deepseek-v4-flash", "effort": "max", "contextCap": 512000 },
      { "model": "zai/glm-5.3", "effort": "high", "contextCap": 512000 }
    ],
    "fallbackToGlobalDefault": true
  }
}
```

The route starts at the first candidate for every new run. A provider outage advances to the next
candidate. The optional `fallbackToGlobalDefault` flag is explicit: when enabled, the global
`llm.defaultModel` is tried after the route is exhausted. Otherwise the route fails loudly.

A tag is referenced as `tag:<name>` wherever a model id is expected:

- session override: `/model tag:opus`, or picking it in the app's model picker
- agent pin: `agents.<agent>.llm.defaultModel: "tag:opus"` (or `llm.defaultModel`)
- cron job: `model: "tag:opus"` in the job editor / `job.model`
- agent file frontmatter: `model: tag:opus`

## Resolution

`resolveFromMerged` (`src/llm/resolver.ts`) is the single funnel every run passes through. A
`tag:` reference is expanded there before the model lookup:

- the requested config keeps the tag reference as the run identity, while the selected candidate
  supplies the concrete API model, effort and context cap;
- the API receives the selected candidate's model via `apiModel` (the three call sites:
  `src/llm/provider.ts`, `src/llm/codex.ts`, `src/agent/claude-sdk/backend.ts`);
- effort precedence is session override > candidate effort > the job's own pin > the agent's own
  pin > global (`llm.effort`). A candidate without an effort pin lets the scope decide;
  `llm.models[].effort` no longer exists;
- a tag route contains concrete model ids only; nested `tag:*` candidates are refused;
- each route candidate owns its effort and context cap;
- the reserved name `Default` is a virtual tag that always tracks the current default model
  (`llm.defaultModel`), never stored in the file;
- a reference to a deleted tag follows `tag:Default` at run time. The reference is not rewritten,
  so recreating the same tag name reactivates it. If an agent's own default is the deleted tag,
  the fallback continues to the global `llm.defaultModel` instead of looping back to itself;
- tag cycles remain errors, including a cycle that only appears after a missing tag follows
  `Default`.

### History records the run-time model

Analytics and `/status` do **not** talk about the tag. Every `recordApiCall` row snapshots the
model the API actually received (`apiModel ?? model`), because a tag can be repointed between two
runs: cost, token and duration stats must group by what ran, not by what the config says today.
A later tag edit therefore never rewrites the history — rows already recorded keep the model they
were made with. `/status` shows the same resolution live: `current` names the model, with the tag
in parentheses when the chain went through one (`claude-opus-5 (tag opus)`).

## Context cap

The selected route candidate's `contextCap` is a per-run ceiling applied in
`resolveContextWindow` (`src/llm/context-window.ts`): session override > candidate cap > agent cap
> global cap. It is deliberate per-candidate policy, so it outranks the agent's standing ceiling
for that attempt. The next route candidate may have a different cap.

Because each selected candidate may own both pins, any flow that stages a tag (a session, an
agent default, the global default, a job) offers **neither** the effort step nor the window step
for that tag: the candidate's own values win for the attempt. A session can still pin its own
later (`/effort <level>`, `/cap <tokens|full>`, or the app's tune sheet), and **picking a tag
drops the pins the session already had**, so a value chosen for the previous model never keeps
outranking the tag just picked. See docs/context-window.md.

## Where tags live

`config.json`, top-level `tags` section: a `Record<name, { route, fallbackToGlobalDefault? }>`.
The server still reads the old `{ model, effort?, contextCap? }` shape for migration, but all new app
writes use `route`. Hot-reloadable like every object section; edits go through `setTag`/`deleteTag`
(`src/core/config-edit.ts`), so `/config history|diff|rollback` covers them for free.

Deleting a tag removes only its definition. Existing references in sessions, agent config, cron jobs
and agent files stay untouched and resolve through `Default` until the name is recreated.

The model picker carries tags as synthetic entries under a single `Tags` group
(`syncFromConfig` in `src/channels/model-picker.ts`), which is what every consumer reads: the
app's model list, the chat `/model` menu, and the `unknownModel` flags on jobs/agents. The
provider list gets a matching virtual `tags` provider row at the top. The app's Tags page lists
names only; selecting one opens a route editor where candidates can be added, edited, removed and
reordered. The global-default fallback is an explicit checkbox there.

## The app

`/tag` is handled natively by the app (it opens the tags page / route editor); the phone's
Settings > Providers > Tags page is the CRUD surface. Wire frames: `tags.list`, `tags.upsert`,
`tags.delete`, answered with `tags.result`. A route upsert carries the complete ordered route and
its `fallbackToGlobalDefault` flag. The server validates every concrete candidate against the
picker catalog and its effort against that model's known levels.
