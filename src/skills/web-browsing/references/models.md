# Naming a model for a browsing run

`delegate_browser_task(url, instructions, model?)` takes the same `model` a `spawn` does. Left out,
the run uses the browser agent's own pin (`config.agents.browser.llm.defaultModel`).

Nothing here is a static list: the catalog moves with discovery, and the tool definitions never
enumerate it (hundreds of ids would be thousands of tokens on every request). Ask the config.

## What can be named right now

```sh
# The tags: stable names for a route the owner maintains.
jq -r '.tags | keys[] | "tag:\(.)"' ~/.my-claw/config.json

# The agent's own pin, which is the default when `model` is omitted.
jq -r '.agents.browser.llm.defaultModel' ~/.my-claw/config.json

# The models declared in the config (the curated set; discovery adds to it at runtime).
jq -r '.llm.models[].id' ~/.my-claw/config.json
```

The app's model picker shows the same thing, filtered to what can run *now*: a provider that lost
its key, or one that answered discovery without the model, is not offered. Config entries that are
missing from it are exactly the ones a run would refuse.

## Tag or bare id

| Name | Use when |
|---|---|
| `tag:<Name>` | The default choice. Carries its route, its effort and its fallbacks; survives a model being retired. |
| `<provider>/<model>` | The task needs that model specifically, not a route. Pinned for the run, with no fallback under it. |

A wrong id comes back as a refusal naming the five ids that look most like it plus the tags. Read
that refusal instead of guessing again: it is the whole point of not enumerating the catalog.

## Picking by task shape

- **Ordinary work** (fill a form, read one page, log in): omit `model`. The owner already chose
  the browser agent's pin for that.
- **A long mechanical sweep** (forty listings to read, a paginated table): `tag:Cheap`. Volume, not
  reasoning, is what it costs.
- **A branched flow** (booking with options, a dashboard with a decision at each step):
  `tag:Smart`. Every wrong turn is a round trip.
- **Vision matters**: screenshots travel to the run, so the model must take images. A text-only
  pick reroutes to `llm.visionFallback` and, failing that, drops the picture with a warning. Both
  models in a tag's route should have vision if the task relies on screenshots.

## What the pick does afterwards

The runner records it on the sub-agent's session, so `send` to that run keeps the same model, and
the app shows it as the run's model. It is not a config change: nothing else starts using it.
