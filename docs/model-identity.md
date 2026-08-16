# Model identity

How a model is addressed, and why the address carries a provider and sometimes an endpoint.

## The problem

The identity of a model used to be its bare id. Two providers serving the same name therefore
fought over one key, and the loser vanished from the catalogue: discovery deduped across providers
(first listed won) and a model declared in config hid every discovered copy of that name.

That is not a display detail. The same model costs from 0.05 to 0.22 USD per million input tokens
depending on who serves it, holds a different window, publishes a different uptime and answers to a
different data policy. Measured on the live install: `gpt-5.6-luna` was reachable through OpenCode
Zen and through the ChatGPT subscription, only the second was listed; `mimo-v2.5` was declared for
a LiteLLM gateway that blocks it with a 403, which hid the copy Zen serves and that works.

## The grammar

```
openrouter / openai/gpt-5.6-luna @ azure/eu
    |              |                  |
    |              |                  endpoint pin, the tag OpenRouter returns per endpoint
    |              apiId, what the request carries
    provider key in config.llm.providers
```

One string, parsed in one place (`llm/model-ref.ts`). Every store already holds the identity as a
string: the config default, the tags, a session override, an agent file, a cron job, the analytics
`model` column, the picker's callback digest. A parallel field would have to be threaded through
all of them and kept in sync.

An id can contain a slash of its own (`openai/gpt-5.6-luna` on OpenRouter), so the first segment is
a provider only when a provider by that name exists. That single rule is what keeps every reference
written before this existed resolving exactly as it did.

## Resolution

Three rules, most specific first (`findModel`, `llm/resolver.ts`):

| # | Reference | Answers |
|---|---|---|
| 1 | matches an id verbatim | that entry, config-declared or discovered |
| 2 | names a provider | only that provider's copy of the id |
| 3 | names none | the first provider that serves it, in config order |

Rule 3 is the short form, not a compatibility shim: it is how a `PATH` lookup works, and it is what
`defaultModel`, the tags and every stored session use. Qualify a reference when you want to be sure
which bill you are paying.

A model declared by hand in `config.llm.models` keeps the id its owner wrote, and still wins on an
exact collision: config outranks discovery, as before.

## What the request carries

`ResolvedLlmConfig.model` is the identity, `apiModel` is the wire id. They differ for a tag, for a
qualified reference and for a pinned endpoint. Analytics files a row under `usageModelOf`: the wire
id (so a later tag edit cannot rewrite history) plus the endpoint (because two endpoints of one
model are two different bills).

The price table is keyed by the id a provider publishes, never by our reference:
`modelKeyCandidates` drops the pin, then falls back through the segments. This is the one place a
mistake would be silent, since a missed lookup reads as "no window declared" and lands on the
default.

## Endpoint pinning

OpenRouter serves one model from several endpoints, each with its own price, region, service tier
and health. `llm/openrouter-endpoints.ts` reads them from `/api/v1/models/{id}/endpoints`, and the
provider display names from `/api/v1/providers`. Both are public, both are cached (15 minutes for
the endpoints, a day for the names), and both are fetched lazily when a menu opens on one model:
the catalogue is four hundred models and this is one call each.

A pin resolves to `providerRoute`, which `llm/provider.ts` sends as:

```json
"provider": { "order": ["azure/eu"], "allow_fallbacks": false }
```

Fallbacks are off on purpose: the point of pinning is the price and the policy of that one
endpoint, and a silent reroute would defeat both.

Two traps, both documented by OpenRouter and both load-bearing here:

- a base slug (`azure`) matches every region of that provider, but **not** its service tiers.
  `openai/flex` and `openai/priority` require the suffixed slug, so a pin always carries the `tag`
  the API returned, never a slug we rebuilt;
- the endpoint list is per model, so a pin is only meaningful next to the model it came from.

A pin is only ever set for a provider whose base URL is OpenRouter, recognised by host rather than
by the key it was given in the config. Anything else drops the pin: the field would be an unknown
key in someone else's request body.

## Picking a route

Three surfaces offer the choice, and one helper answers all three (`channels/route-menu.ts`):
`routeChoiceFor` says whether a reference can be pinned and to what it is pinned now, `routesFor`
lists the routes, `referenceWithRoute` spells the result. A menu that built its own list is how
one surface comes to offer a route another refuses.

On Telegram and Matrix the routes sit behind a `Route >` entry of the root `/model` menu, next to
`Context >` and for the same reason: pinning is a standing choice that rarely changes, so it is
one entry away rather than a screen everyone walks through on every model switch. The entry only
appears for a model that has routes. An endpoint tag rides verbatim in `callback_data` (a digest
would need the route list to resolve back, and no menu still holds it when the button is pressed);
a tag that would overflow Telegram's 64 bytes drops out of the menu rather than being truncated
into a button that pins another provider.

In the app the picker is a chained flow instead: model, then route, then effort, then window. The routing step appears only for a model whose provider is served by OpenRouter, which
`model.list.result` marks with `routes: true` (read from the provider key, so the catalogue is not
resolved model by model to build a list). Entering the step sends `model.endpoints`, and the
server answers with the routes of that one model, cheapest first, each carrying its price, window,
health flag and 30-minute uptime.

Everywhere, the pin travels inside the model reference, so pinning a route is the same write as
picking a model: `model.set` on the app, the session override on a channel, the agent's `model:`
in config. Two consequences the app has to honour, both covered by its own tests:

- every catalogue lookup goes through the bare reference, or a pinned conversation reads no
  effort levels and no window;
- re-picking the model already in force keeps its route, so the step is a change of route rather
  than a silent reset to automatic. Any other model starts unpinned.

## Defaults

- Automatic routing unless an endpoint is pinned. A pin is a deliberate act, never an inherited
  state: pinning the last endpoint used would turn a one-off optimisation into an invisible
  permanent policy that outlives the price that justified it.
- An endpoint that disappears from the catalogue falls back to automatic routing with a notice,
  the same `announceModelFallback` path a model fallback uses. Refusing the run would punish the
  owner for someone else's catalogue change; switching in silence would hide a bill.

## Deployment

No data migration: rule 3 means everything already written keeps resolving. The discovery cache
changes shape, so `~/.my-claw/model-catalog.json` is deleted once and rebuilt by the first refresh.
