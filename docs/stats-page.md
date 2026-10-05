# The statistics page

`/status` answers "what is this conversation doing, and what has it cost". This answers "what has
this install cost", which is a different question with different scoping rules: a provider bills a
key and not a chat, a conversation that was deleted still spent money, and a ninety-day retention
wall hides most of the history unless something survived it.

One request, one answer: `stats.get` with a period, `stats.result` with the whole payload. Nothing
pushes it. A conversation moves and its status page is pushed a fresh report; nothing "moves" an
install-wide total in a way a session event could name, so the page asks when the owner opens it.

## Why the reconciliation left `/status`

It was a line at the foot of the usage card of one conversation, and both of its figures were
account-wide. That is the contradiction: `/status` is scoped to a chat, and a provider's ledger is
scoped to the key. A conversation running entirely on `api.anthropic.com` was shown an OpenRouter
line, because the reconciliation never had anything to do with the conversation it was drawn under.

It is the same code and the same three states here, on a page whose scope is the install --
`MyClawAppStatsReconciliation`, one entry per provider that publishes a ledger. What is gone for
good is `reconciliationSegment`: the chat line of `/status` is per-conversation too, and the
statistics page is not a chat line.

`src/llm/openrouter-account.ts` is untouched: the 5-minute cache, the single-flight and the
3-second deadline are what keep a page from hanging on somebody else's API, and they matter here for
the same reason. The one thing unwired is the push it used to trigger: `llm:account:refreshed` had
exactly one listener, `myClawApp.statusRefreshed()` -> `StatusWatch.refreshed()`, whose only job was
to refill a status page that was still saying "provider not reached". No status page says that any
more, so the listener, the adapter method and `StatusWatch.refreshed()` are gone. The event itself
still fires from `refreshOpenRouterAccount`, and `tests/llm/openrouter-account.test.ts` still proves
it fires on a successful read and on nothing else.

## Nothing is ever swept

**Every `api_calls` row stays, forever** (decided 2026-09-17: the owner deleted old conversations,
watched the ranking they had disappeared from, and asked for "rien perdre"). There is no retention
wall, no `RETENTION_DAYS`, and nothing at boot folds or deletes a call. The ranking and the daily
graph therefore reach back to the first recorded row, and a global reading is `api_calls` itself.

What an earlier policy already folded is not recoverable: the rollup key carries no session and no
day, so those months count in the totals and in no conversation. The rollup is still read, and this
section is kept for what it explains -- why a rolled month adds up instead of overlapping.

### The purge that used to run (retired 2026-09-17)

`pruneOldRecords()` deleted every `api_calls` row older than `RETENTION_DAYS` (90) at boot, after
folding them into `usage_monthly`. Its design was one sentence: **the rollup covers exactly the rows
the purge deletes, and nothing else.** That is what made `rollup + live` a safe global total, and it
is the property the readers downstream still rely on.

```
BEGIN
  SELECT substr(timestamp,1,7), model, base_url, platform, caller, SUM(...)
  FROM api_calls WHERE timestamp < $cutoff
  GROUP BY substr(timestamp,1,7), model, base_url, platform, caller

  for each group:                        -- price what carries no cost, see below
    INSERT INTO usage_monthly (...) VALUES (...)
    ON CONFLICT (month, model, base_url, platform, caller) DO UPDATE SET calls = calls + excluded.calls, ...

  DELETE FROM api_calls WHERE timestamp < $cutoff
COMMIT
```

The read is inside the transaction with the writes and the delete, so a call recorded while the
purge runs is condemned by all three or by none.

Two properties follow, and they are the whole point:

- **No double count.** A call is in `api_calls` or in `usage_monthly`, never in both. The read and
  the DELETE use the same `$cutoff`, in one transaction, so no row can be caught by one and missed
  by the other. A global reading is therefore `rollup + live`, added, with no overlap to subtract.
- **No loss.** A rollup that landed without its delete would double-count its months at the next
  boot; a delete that landed without its rollup is the loss this exists to prevent. The transaction
  makes both impossible, and a test proves it by breaking the INSERT and checking the DELETE did not
  happen (`a rollup that cannot be written takes its delete down with it`).

### The schema

```sql
CREATE TABLE IF NOT EXISTS usage_monthly (
  month       TEXT NOT NULL,   -- YYYY-MM, substr of the ISO timestamp
  model       TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  platform    TEXT NOT NULL,
  caller      TEXT NOT NULL,

  calls              INTEGER NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,

  billed_usd     REAL    NOT NULL DEFAULT 0,
  reference_usd  REAL    NOT NULL DEFAULT 0,
  unpriced_calls INTEGER NOT NULL DEFAULT 0,

  errors      INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (month, model, base_url, platform, caller)
);
```

`substr(timestamp, 1, 7)` rather than `strftime('%Y-%m', ...)`: the month is the first seven
characters of an ISO timestamp, and reading them is not a date parse that can fail on a row written
by an older shape. (`strftime` does parse this format correctly -- measured -- it is simply not
needed.)

`CREATE TABLE IF NOT EXISTS` is enough here, and the comment above `ensureColumn` is about
something else: a *column* added after the table shipped needs an `ALTER`, because the CREATE never
runs again on a database that already has the table. A brand new *table* has no such problem, and
the test `the rollup table appears on an analytics database that predates it` measures both halves
rather than asserting the claim.

`proxy_cost_usd` is deliberately not a column of its own. A row that carries one is priced by it at
write time and arrives here inside `cost_usd`; measured on the live database, no row has ever
carried one.

Two columns more, both about *where the call happened* and both written at call time:
`workspace` (a `config.workspaces` key, `default`, or a directory belonging to none of them) and
`folder_id` (the folder the paying conversation was filed in when the call ran). A conversation
switches workspace and gets re-filed, so only a column keeps the past where it was. Both are NULL
on rows written before they existed, and the filters name those populations instead of hiding them
-- see "Where a call is filed" below.

### The purge prices what it condemns

The rule at the purge, per group:

- **The calls frozen with a cost keep it**, split into `billed_usd` (what was charged) and
  `reference_usd` (what it would have cost at list price). A provider raising its tariff must not
  restate a closed month, which is why those columns exist.
- **The calls carrying none are priced from their own tokens** through the live ladder, in the last
  moment those rows exist. Their tokens are summed apart from the frozen ones, so pricing them
  cannot charge a frozen call twice.
- **That computed price lands in `reference_usd`, never in `billed_usd`.** A catalogue rate is what
  the traffic would have cost if rented; it is not a statement from whatever billed the call. Only a
  provider states a charge, and the purge is not a provider.
- **What the ladder cannot price either** keeps its calls and gets no money. `unpriced_calls` now
  means exactly one thing: nothing anywhere knows what this cost.

Why it is done at all: 43 031 of 47 080 rows carry no frozen cost, because the cost columns shipped
in September 2026. Rolling those months up at zero would turn three quarters of this install's
history into a permanent hole on the page whose whole job is to show it. The decision is one-way --
a rollup is never recomputed -- so it is taken in the direction that keeps information.

**A rolled-up line priced at the purge was priced with the price table of the day the purge ran, not
of the day the call was made.** That is the same approximation the live page already makes for those
same rows every time it draws them, and it beats a zero. It is also why a rolled-up month is read as
**settled**: `usageByModel` hands it over with its money already decided, and `pricedTotals` never
re-prices a group whose `origin` is `rollup`. Re-pricing it would charge tokens that were already
accounted for, and would make a closed month move every time a tariff does.

What a purge may do to the totals, measured by
`rollup plus live equals the total from before the purge, column by column`:

| | Across a purge |
| --- | --- |
| calls, tokens, errors, duration | conserved exactly |
| `billed_usd` | conserved exactly -- the purge never states a charge |
| `reference_usd` | may grow, by exactly what the ladder could price on the way out |
| `unpriced_calls` | may only shrink, and only together with the above |

With every row already frozen there is nothing left to compute and nothing moves at all, which is
its own test (`a purge of rows that all carry a frozen cost changes no column whatsoever`).

### The live side, unchanged

A group still on disk is priced at read time, by the same rule the purge applies: the frozen money
when every call carries one, the ladder over the whole group's tokens when any call does not (the
partial frozen sum is dropped rather than added, or the frozen calls are charged twice), and
`unpriced` when the ladder cannot answer either.

## Two horizons, and why the page must show both

The rollup key has no session on it and no day in it. So the payload carries two dates and the page
must use them both:

| Field | What it bounds | Views |
| --- | --- | --- |
| `detailSince` | oldest `api_calls` row still on disk | `sessions`, `daily` |
| `totalsSince` | first month in `usage_monthly` | `totals`, `models`, `providers`, `reliability`, `cache`, `callers` |

"Detail since 15 June, totals since always" is a true sentence. "Everything since always", drawn
over a per-session ranking that silently starts in June, is not -- and that is exactly what the
screen of today was doing. `rollupIncluded` says whether this particular answer crossed the wall;
only `all` ever does, and only once a purge has run.

## The eight views

All of them answer on a period: `7d`, `30d`, `90d`, `all`. A bounded period reads live rows alone --
the purge only removes rows older than 90 days, so a bounded window and the rollup cannot describe
the same call. `all` adds the rollup.

1. **Totals** -- calls, tokens (prompt, completion, cache read, cache write), billed and reference
   money, unpriced calls, cumulative API time.
2. **Models and providers** -- ranked by spend. `provider` is the endpoint pin when the model
   reference carries one (`z-ai/glm-5.2@streamlake/fp8` -> `streamlake`, variant `fp8`), else the
   host. Same `routeOf` as `/status`, now in `src/channels/usage-route.ts` so the two screens cannot
   disagree about a call they both cover.
3. **Sessions, deleted ones included** -- 189 of this install's 315 recorded sessions no longer
   exist on disk and their 9 000-odd calls are intact. Dropping them would make the ranking add up
   to less than the total above it. See "Labelling a session that is gone".
4. **Daily timeline** -- one bucket per `YYYY-MM-DD`, bounded by `detailSince`.
5. **Reliability** -- error rate and mean latency, per model and per host, worst first.
   `avgDurationMs` and nothing finer: the rollup keeps sums, not distributions, so a percentile
   would exist for the live window and be silently missing for everything older.
6. **Cache** -- read and write tokens as a share of the prompt tokens they are a part of.
7. **Reconciliation** -- one entry per ledger: per OpenRouter API key (two providers naming the
   same variable are one account, one entry), set against the calls of the providers using that
   key, with the balance when there is one. A host we can only compare with itself is a row of the
   provider ranking, not a reconciliation, so it is not listed here.
8. **Callers** -- `orchestrator`, `subagent`, `browser`, `compaction`, `compaction-speculative`.

The first two, and 5, 6, 7 are all folded in TypeScript from **one** query (`usageByModel`), which
is why the page costs four round trips to SQLite and not eight.

## Which provider served a call (2026-10-05)

Two accounts of one service share an address: two OpenRouter keys, a Claude plan and a Claude API
key on `api.anthropic.com`. `base_url` cannot tell them apart, so the spend of both landed on one
row and the OpenRouter ledger was read for the first key only. Owner: "si je colle lui, c'est lui".

- Every call records `provider_key`, the key of the configured provider that served it
  (`ResolvedLlmConfig.provider`), from the five writers (three in the bridge, the summary call,
  the compaction).
- The calls recorded before the column are placed **once** (`attributeCallsToProviders`, guarded by
  `PRAGMA user_version`), and only where exactly one provider of the config of that boot has the
  address. Two providers on one address leave the rows `NULL`: a guess would put one account's
  spend on the other. A later config never re-files the past. On this install: 80 867 of 97 481
  rows placed; `claude-sdk`, a removed CommandCode and old test rows stay `(unknown)`.
- Every live group is `(model, base_url, provider_key)`. The page gets `providerKeys` (one row per
  configured provider, by the name the owner gave it: `group`, else the key, `<key> (removed)` for
  one gone since, `(unknown)` for `NULL`), and each model row carries `providerKey` and
  `providerLabel`. `providers` stays the endpoint view (pin or host), which folds accounts together.
- The reconciliation sets each key's ledger against its own providers' calls. `NULL` rows on
  OpenRouter are counted only when there is one ledger: with two they cannot be split.
- `/status` groups a conversation's rows the same way, with the same label (`providerLabels` in
  `usage-route.ts`).

## Filtering

One filter, eight dimensions, applied **in SQL before the aggregation**. That is the whole design: a
filtered report is a smaller population, not a smaller answer to the same question, so the totals
are recomputed over the rows that survive and every view describes the same rows.

The alternative -- filtering the folded groups in the app -- cannot work, and not because it would
be slower. A model ranking carries no caller on it, and no amount of summing the rows it has can
answer "which models did the sub-agents use". The predicate runs where the rows are, and each view
is folded from what is left.

| Dimension | Column | Notes |
| --- | --- | --- |
| `workspace` | `workspace` | where the call ran from: a workspace key, `default`, or `(unknown)` for the rows before the column |
| `folderId` | `folder_id` | the folder the call was filed as at call time, `(none)` for the unfolder ones |
| `model` | `model` | exact, endpoint pin included: `z-ai/glm-5.2@streamlake/fp8` is one bill |
| `provider` | `provider_key` | a configured provider, `(unknown)` for the rows nothing could place. The endpoint pin lives in the model id, so the `model` filter narrows to it |
| `caller` | `caller` | orchestrator, subagent, browser, compaction |
| `sessionId` | `session_id` | one conversation |
| `errorsOnly` | `error IS NOT NULL` | the calls that failed, not the routes that failed once |
| `unpricedOnly` | `cost_usd IS NULL` | the calls no rung could price |

The three sentinels (`(unknown)` workspace, `(none)` folder, `(unknown)` provider) are matched as `IS NULL`, never as a string: the pre-column history and the calls
nobody filed are populations worth asking after, and a filter that cannot select them has no way
back to a quarter of the window.

`errorsOnly` and `unpricedOnly` are row predicates for a reason worth stating: the group-level
version of the same filter would report the whole spend of a route with one error on it, which is a
different number wearing the same name.

### A filter the rollup cannot answer drops it

`usage_monthly` is keyed by `(month, model, base_url, platform, caller)`. Two of the dimensions
above are columns of it; six are not -- no session, no workspace, no folder and no provider on that key, and
`errors`/`unpriced_calls` are counters rather than rows, so "only the failures" is not a question a
monthly fold can answer.

Those six drop the rollup (`filterReachesRollup`), and `rollupIncluded` goes false with them. The
alternative -- adding months no filter ever touched -- would make a filtered page report history it
had excluded, which is worse than reporting less. (Extending the rollup key instead was priced and
refused: it rebuilds the table, and every folded month predates the two columns, so it would gain
nothing but `(unknown)`.)

### Where a call is filed

The owner, 2026-09-22: "il faut traquer les requetes depuis quel workspace" and "un filtre par
dossier [...] un snapshot par appel". Both fields answer at call time:

- **`workspace`** is where the run works, named as its config key (`workspaceNameForDir`): the
  directory a sub-agent was spawned into maps to the workspace whose tree holds it -- a worker
  pinned to `/home/me/dev/my-claw` runs work of `dev` -- and anything outside every workspace keeps
  its raw path. Read per call, so a switch ("applies from the next run onward") is exact.
- **`folder_id`** is the folder of the **paying** conversation (`usageFolderOf`): a chat's folder
  holds its whole spend, delegation included. For the payer itself that is its own live `folderId`,
  so a filing gesture mid-run applies to the calls after it; for a worker run it is the folder the
  drive that started the work saw, stamped beside `invokedBy` at every spawn/send -- a worker is
  never filed as itself, even if it ever carried the field.

A row therefore never moves when the owner re-files or switches: the future moves, the past stays
where it was spent.

### The option lists ignore the filter

The payload carries `facets`: the values that exist over the window, computed **without** the filter
on screen. A list built from the current answer would keep the one choice already made and drop
every alternative, which is a filter nobody can undo.

With nothing narrowed the lists come from the rows the report is already made of, at no extra cost.
With something narrowed they come from `usageFacets` -- four `DISTINCT`s, measured below -- plus the
same label lookup the ranking uses, which `labelsOf` now shares with it.

### A filter that is not one is refused

The frame's filter is validated field by field in the adapter (`statsFilterOf`): a wrong type, an
empty string or an unknown key is refused with an `error` frame rather than coerced. `model = 42`
in SQLite matches nothing, and a report narrowed by a mistake reads on the page as an empty window;
a misspelt dimension, silently ignored, is a filter that appears to do nothing. An absent filter
and an empty one are the same thing -- the whole window -- and the payload echoes back what was
applied, so the page can never claim a filter the server did not get.

## Labelling a session that is gone

Two databases, and the join is done in TypeScript. Never in SQL: `analytics.db` and
`conversations.db` are attached to nothing in common, and a cross-database query would tie the
analytics to an archive that can be absent.

1. The session exists and the owner named it -> its title.
2. Otherwise -> the opening user message from `conversations.db`, read as the thread drawer reads it
   (attachment block split off, location block stripped, whitespace collapsed, 60 characters).
3. Nothing there -> the session id, plainly. An invented title is worse than an ugly one.

`labelSource` (`title` / `first-message` / `id`) and `deleted` both travel, so the page can render
an id as an id and mark what no longer exists.

The archive has two writers and therefore two keys. A turn written back from a session log carries
`session_id`; a message written as it arrived on a channel carries `(platform, chat_id, thread_id)`
and no session at all, which is where most of an app conversation's opening line lives. Measured on
the live archive, over the 189 sessions the analytics hold and the disk does not:

| Key | Sessions labelled |
| --- | --- |
| `session_id` alone | 22 / 189 |
| both keys | 51 / 189 |
| both keys, app conversations only | **29 / 30** |

The remaining 138 are mostly sub-agent runs (102 of them) whose transcripts were never archived
under a user role. Their ids are already readable (`subagent/global-stats-server-ab97`), which is
what case 3 hands back.

A live conversation the owner never renamed goes down the same path as a deleted one -- it is
labelled from the archive -- because the alternative is opening one session log per conversation,
and there are three hundred of them.

## What it costs

Measured on a copy of the live database (47 186 rows, 24 MB), median of five runs after a warm-up:

| View | 7d | 30d | 90d | all |
| --- | --- | --- | --- | --- |
| `usageByModel` | 19 ms | 54 ms | 62 ms | 53 ms |
| `usageByCaller` | 11 ms | 65 ms | 72 ms | 66 ms |
| `usageBySession` | 13 ms | 76 ms | 82 ms | 76 ms |
| `usageByDay` | 10 ms | 63 ms | 66 ms | 63 ms |
| `usageHorizon` | < 1 ms | < 1 ms | < 1 ms | < 1 ms |

`firstUserTextBySession` over all 315 ids: 22 ms. The session store lookups (315 ids, 126 found on
disk): 21 ms. Whole `statsReport`, end to end: **64 ms (7d), 297 ms (30d), 332 ms (90d), 314 ms
(all)**.

`all` is not the slowest, because the rollup is empty on this install and the live table is the same
table a 90-day window scans.

### What a filter costs

Same database, median of five runs. The unfiltered column is the row above; the other three are the
same query with one dimension narrowed:

| Query | 30d, no filter | `model` | `provider` | `errorsOnly` |
| --- | --- | --- | --- | --- |
| `usageByModel` | 47 ms | 0.7 ms | 17 ms | 11 ms |
| `usageByCaller` | 56 ms | 0.6 ms | -- | -- |
| `usageBySession` | 66 ms | 0.6 ms | -- | -- |
| `usageByDay` | 55 ms | -- | -- | -- |
| `usageFacets` (four `DISTINCT`s) | -- | 43 ms | 43 ms | 43 ms |

A model filter is nearly free: `idx_api_calls_model` turns the window scan into a lookup of one
value's rows. A host filter cannot be -- there is no index on `base_url`, and none is worth adding
(see below) -- so it scans the window with the predicate and drops most of it, which is still three
times cheaper than the aggregate it replaces.

`usageFacets` is four `DISTINCT`s at 10-12 ms each: the model, caller and session columns are
indexed, so each is a walk of the index that never touches a row. It replaces the three unfiltered
aggregates (~170 ms) that an earlier version ran for the same lists, and it removed the need to
price rows nothing was going to show.

### There is no index on `base_url`, and there should not be

Every view here is a full aggregate over a window, which SQLite answers by scanning that window and
building a temp B-tree for the `GROUP BY`. An index on a column that appears only in `GROUP BY`
never enters the plan. Measured:

| | `byModel all` | `byModel 90d` | `byModel 7d` | `bySession 90d` |
| --- | --- | --- | --- | --- |
| today | 41 ms | 41 ms | 5.7 ms | 62 ms |
| `+ INDEX (base_url)` | 37 ms | 38 ms | 5.5 ms | 59 ms |
| `+ INDEX (timestamp, model, base_url)` | 41 ms | 39 ms | 5.4 ms | **78 ms** |

`EXPLAIN QUERY PLAN` is identical in all three: `SCAN ... USING INDEX idx_api_calls_model` for `all`,
`SEARCH ... USING INDEX idx_api_calls_timestamp` for a bounded window, plus `USE TEMP B-TREE FOR
GROUP BY`. The 4 ms is noise, and the covering index makes the session view 25 % worse. **No index
is added**: it would cost write latency on every recorded call and a megabyte of the file, for
nothing the planner would use.

## The wire

`src/channels/my-claw-app/types.ts`, beside `status.watch`/`status.result`. The app holds a typed
allow-list, so these are the exact shapes.

```ts
export type MyClawAppStatsPeriod = "7d" | "30d" | "90d" | "all";

export interface MyClawAppStatsGet { type: "stats.get"; period: MyClawAppStatsPeriod; filter?: MyClawAppStatsFilter }
export interface MyClawAppStatsResult { type: "stats.result"; stats: MyClawAppStatsPayload }
```

An unknown period is **refused** (`error`, scope `stats`), never coerced to one the server does
offer: a page that asked for six months and was quietly shown seven days would be believed. A
filter that is not one is refused the same way. `stats.result` carries no `threadId`, because the
answer is about the install.

The payload and its rows are listed in full in `types.ts`; the fields that are not self-evident:

- `unpriced` -- calls counted, money not. Present on every totals-shaped row.
- `deleted` / `labelSource` on a session row.
- `detailSince` / `totalsSince` / `rollupIncluded`, above.
- `providerUnread` on a reconciliation entry: the ledger was not read. A cold cache and a dead API
  are the same statement, because the page never waits on a third party.
- `filter` -- what was applied, echoed back. Never inferred from the request on the app side: a
  page that drew its own filter could show a chip the server never honoured.
- `facets` -- the values a filter may be set to over the window, computed without it.

### Nothing identifying travels

`refreshOpenRouterAccount` reads `data.usage` and `total_credits - total_usage` and nothing else, so
the key's `label` (`sk-or-v1-...`), its `limit` and its `limit_remaining` have no path to a payload.
Neither has an absolute path of this machine: the payload carries model ids, base URLs, session ids
and numbers. Tested on the serialized JSON rather than on the object, which is what actually crosses
the socket.

## Where the sweep used to run at boot

Nothing runs there any more. The boot publishes the price table (`setSharedPricing(pricing)`) and
then logs the horizon it holds (`analytics kept in full`, with `since`). The order that mattered --
price first, then condemn -- went with the purge it protected.

## A boot with no price table

Unchanged in substance, and simpler now: a boot that has not fetched models.dev yet prices nothing
and deletes nothing. The rows stay, and `/status` and the page price them from the table the moment
it lands.
