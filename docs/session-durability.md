# Session durability

When a message reaches the disk, and who is allowed to read the file instead of the session.

## The shape of the problem

A session is a JSON file, but a run mutates the object the `SessionManager` keeps in its LRU
cache. Everything a turn produces (the question, each assistant block, each tool result) is
pushed onto that object and reaches the file only when someone writes it.

Two failures come out of that, and both were reported as "my message disappeared":

- **A reader that goes to the file** sees a conversation as it stood before the current turn
  started. The app replaces the thread on screen with what `session.history` returns, so
  leaving a conversation and coming back mid-run wiped the question and every card already
  streamed.
- **A process that exits** takes the cache with it. Seven adapter restarts in one day, and any
  message a run had not written yet was gone for good.

## The rules

**Reading.** Anything that serves a conversation back to a client reads
`SessionManager.read(id)`: the cached object when a run holds it, the file otherwise. `loadSession`
stays for the places that genuinely want the stored copy (the sub-agent runner, the manager
itself). `read` deliberately does not cache a miss, unlike `peek`: listing two hundred threads
would otherwise churn a hundred-entry LRU and evict the sessions that are actually live.

**Writing.** Four moments, in order of how much they cover:

| Moment | Who | Covers |
|---|---|---|
| End of a run | `router.routeInternal` | the normal case |
| Run aborted, run failed | same, both catch paths | a stopped or exploded turn |
| Every 2 s | `SessionManager.startAutosave` | a crash or a kill mid-turn |
| Shutdown | `SessionManager.flushAll`, after the adapters stop | SIGINT, SIGTERM, config health restart |

The autosave writes a cached session only when its message count moved since its last write
(`savedCounts`), so an idle process writes nothing and a conversation created but never used
leaves no file. The shutdown flush ignores that check: it is the last chance, and a title or a
token counter changed without a new message must survive too.

**Worst case.** A `SIGKILL` loses at most two seconds of a turn. Anything cleaner loses nothing.

## History paging

`history()` returns a page of messages, walked back to the user message that opened the turn so
a page never starts in the middle of the work (`turnAlignedStart`). The walk is bounded by
`MAX_TURN_LOOKBACK` (400 messages), not by the page size: one agentic turn is easily two hundred
messages, and a bound of one page put the question above the first page, which reads exactly
like a lost message.
