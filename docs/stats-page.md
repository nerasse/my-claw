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

## The 90-day wall, and the rollup that survives it

`pruneOldRecords()` deletes every `api_calls` row older than `RETENTION_DAYS` (90) at boot. A page
claiming to show everything would be short by however much history the purge has already taken, and
would never say so.

The design is one sentence: **the rollup covers exactly the rows the purge deletes, and nothing
else.**

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
7. **Reconciliation** -- one entry per provider that publishes a ledger (OpenRouter alone today),
   with the balance when there is one. A host we can only compare with itself is a row of the
   provider ranking, not a reconciliation, so it is not listed here.
8. **Callers** -- `orchestrator`, `subagent`, `browser`, `compaction`, `compaction-speculative`.

The first two, and 5, 6, 7 are all folded in TypeScript from **one** query (`usageByModel`), which
is why the page costs four round trips to SQLite and not eight.

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

export interface MyClawAppStatsGet { type: "stats.get"; period: MyClawAppStatsPeriod }
export interface MyClawAppStatsResult { type: "stats.result"; stats: MyClawAppStatsPayload }
```

An unknown period is **refused** (`error`, scope `stats`), never coerced to one the server does
offer: a page that asked for six months and was quietly shown seven days would be believed.
`stats.result` carries no `threadId`, because the answer is about the install.

The payload and its rows are listed in full in `types.ts`; the fields that are not self-evident:

- `unpriced` -- calls counted, money not. Present on every totals-shaped row.
- `deleted` / `labelSource` on a session row.
- `detailSince` / `totalsSince` / `rollupIncluded`, above.
- `providerUnread` on a reconciliation entry: the ledger was not read. A cold cache and a dead API
  are the same statement, because the page never waits on a third party.

### Nothing identifying travels

`refreshOpenRouterAccount` reads `data.usage` and `total_credits - total_usage` and nothing else, so
the key's `label` (`sk-or-v1-...`), its `limit` and its `limit_remaining` have no path to a payload.
Neither has an absolute path of this machine: the payload carries model ids, base URLs, session ids
and numbers. Tested on the serialized JSON rather than on the object, which is what actually crosses
the socket.

## Where the purge runs at boot

`pruneOldRecords()` used to sit with the other boot sweeps (logs, old sessions), before the price
table existed. It now runs **immediately after `setSharedPricing(pricing)`** in `src/index.ts`, and
that ordering is load-bearing: run earlier it would find no table, roll every condemned month up at
zero, and write that down permanently. A rollup is never recomputed, so a purge that ran too early
is not a delay, it is a loss.

## A boot with no price table

`sharedPricing()` is published at boot, before the purge runs. When it is absent -- a first boot that
has not fetched models.dev yet, or a fetch that failed -- the purge still folds and still deletes:
the condemned calls are counted, their tokens are kept, and their money goes to `unpriced_calls`.
Nothing is lost that was not already unknown, and the page says so instead of implying a zero.

That is the only degradation, and it is the honest one. The alternative would be skipping the purge
and letting `api_calls` grow without bound because a third party's price list was unreachable.
