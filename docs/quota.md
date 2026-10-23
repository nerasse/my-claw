# Quotas: what a provider says about its own limits

One module answers "how much is left, and when does it reset" for the providers that publish
it. It feeds two surfaces: the quota card on a provider page, and the reset a session waits for
when a run dies on a spent quota (`docs/quota-retry.md`).

## Sources

| Source | Request | Credential | Notes |
|---|---|---|---|
| `claude` | `GET https://api.anthropic.com/api/oauth/usage` | the account's OAuth access token | Undocumented: the endpoint Claude Code itself calls. Needs `anthropic-beta: oauth-2025-04-20` and a Claude client `User-Agent`; without it the bucket rate-limits hard. Returns `limits[]` (`session`, `weekly_all`, `weekly_scoped`), `five_hour`, `seven_day`, `extra_usage`. A scoped weekly limit names its model in `scope.model.display_name` ("Fable"); the label carries it, so two weekly rows never read the same. |
| `codex` | `GET https://chatgpt.com/backend-api/wham/usage` | the account's access token + `ChatGPT-Account-Id` | Undocumented: the endpoint the Codex app calls. `rate_limit.primary_window` / `secondary_window` are identified **by `limit_window_seconds`** (18000 = 5 h, 604800 = week, 2628000 = month), never by their slot. `credits.balance` is a count of credits, not money. `rate_limit_reset_credits.available_count` is the banked resets. |
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage` | the provider's API key | Undocumented but official (same origin as inference). `usage.rolling`, `weekly`, `monthly`, each `{status, percent, resetsAt}`; `status` is `ok` or `rate-limited`. The key names nobody, so the email comes from the console's member list (`/console/api/v1/budgets/members`): a Go workspace has one member, and a list with several names none of them. |
| `openrouter` | `GET /api/v1/key` and `GET /api/v1/credits` | the provider's API key | `credits` is documented as management-key only but answers an ordinary key. `total_credits - total_usage` is the balance; the key's own `usage` and `limit` are separate. |

No source: Groq (only `x-ratelimit-*` on a billed response), Gemini (AI Studio only), LiteLLM
(a virtual key is refused on `/key/info`). Those providers draw no card rather than an empty one.

The two subscription endpoints are undocumented. Read them as read-only extras: a change on the
vendor side must degrade to "usage unavailable", never throw into a page or a run. Cache per
provider, keep the last good snapshot with its age, and never let one provider's failure affect
another.

## Cadence

| Source | Minimum interval |
|---|---|
| `claude` | 300 s |
| `codex` | 120 s |
| `opencode-go` | 120 s |
| `openrouter` | 120 s |

A probe is a read, not a run: it costs no tokens. The Claude bucket is per access token and
punishes a caller without the claude User-Agent, which is why the interval is the longest of the
four. `Retry-After` wins over the schedule; a 429 parks the provider with an exponential cooldown
(30 s doubling, 15 min ceiling) and the last good snapshot is served as stale.

`quotaFor(config, provider, { force })` is the only entry point: it dispatches on the provider's
type, collapses concurrent probes, and caches. `force` bypasses the TTL, not a 429 cooldown.

## Snapshot

```ts
interface QuotaSnapshot {
  provider: string;
  source: "claude" | "codex" | "opencode-go" | "openrouter";
  plan?: string;
  email?: string;
  windows: { id: string; label: string; usedPercent: number; resetAt?: string; windowSeconds?: number }[];
  balances: { id: string; label: string; currency?: string; remaining?: number; total?: number; count?: number }[];
  extras: { label: string; value: string }[];
  fetchedAt: string;
}
```

Windows carry **used** percent. A balance is money or a count of credits, never a percentage.
Spend that my-claw recorded itself is not a quota and does not belong here.

## The reset a retry waits for

When a run dies on a spent quota, the same module is the reset oracle: ask the provider (fresh,
bypassing the TTL) for the earliest window still ahead whose remaining is zero, and wait for it
plus a one-minute buffer. This is what makes OpenCode Go waitable at all: its 429 body says
nothing, its usage endpoint names every reset.

The decision and the UI of that wait live in `docs/quota-retry.md`.

## Tests

`tests/llm/quota.test.ts`: each adapter against a response captured from the live endpoint
(assainie: emails, account ids and tokens removed), the window identified by duration rather than
slot, 401 and 429 paths, the TTL, `force`, the stale-on-429 rule, and a provider with no source.
