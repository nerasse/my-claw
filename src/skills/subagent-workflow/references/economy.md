# Keeping sub-agents economical

Nothing caps how many sub-agents run at once. What each one costs is real, so the choice is yours
to make deliberately.

- **One precise, bounded task per sub-agent**: "find the Instagram posts of clubs X, Y, Z", not
  "get everything possible". A vague task burns iterations and returns noise.
- **Parallel where the targets are independent**, sequential where one result feeds the next.
- **A parallel batch of the same tool asks the user for approval once**: concurrent prompts are
  coalesced into a single decision.
- **Large web pages**: a sub-agent pages through `fetch` with `offset` (see the web-browsing
  skill) instead of dumping whole pages into its context. One huge page poisons the session and
  inflates every later call.
- **`web_search`**: do not fire several near-identical queries in one batch. The engines behind
  SearXNG rate-limit fast, and one degraded batch suspends them for everyone. One well-phrased
  query beats four variations. If `web_search` reports "backend degraded", stop searching (it is
  in a cooldown): use what you have, or `fetch` known URLs.
- **Browser tasks run in parallel**: each `delegate_browser_task` works in windows of its own on
  the one shared browser, even on the same site. Split independent targets into parallel calls.
