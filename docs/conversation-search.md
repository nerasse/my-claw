# Conversation Search

`conversation_search` is the single read-only tool for searching historical
conversation content. Its corpus is global by design: it is not restricted to
the current channel, session, parent session, or sub-agent.

## Storage

Conversation history is stored separately from long-term memory:

```text
$MY_CLAW_DIR/conversations.db
```

The database uses SQLite WAL mode and an FTS5 `messages_fts` index. It stores
normalized provenance for Telegram, Matrix, cron, the main orchestrator, and
sub-agent messages. The file is created with mode `0600`.

`memory.db` remains reserved for curated durable facts and is not used as a
raw transcript archive.

## Tool Contract

The tool has one schema and two actions:

```json
{
  "action": "search",
  "query": "deployment decision",
  "include_context": true
}
```

Search returns bounded snippets and a short context window by default. A
larger window uses the returned opaque `hit_id`:

```json
{
  "action": "read",
  "hit_id": "m_42",
  "before": 10,
  "after": 10
}
```

Optional filters include `platform`, `chat_id`, `from`, `to`, `limit`,
`before`, and `after`. The model cannot provide filesystem paths or select a
parent-only scope.

## Indexing

The first startup backfills current and archived session JSON files once. The
marker is stored in `archive_meta`, so later startups do not duplicate the
backfill.

Live inbound channel messages are indexed after channel normalization. Main
agent responses are indexed after routing. Persistent and one-shot sub-agent
sessions are indexed from their session data before one-shot cleanup.

Slash commands are excluded because command arguments can contain credentials.
Tool results are not indexed in the first version.
There is no automatic conversation purge in this first version; the archive is
intended to retain historical search data until an explicit lifecycle policy is
added.

Telegram history before the bot received an update cannot be recovered through
the generic Bot API. Matrix history can be imported only where the client has
access and, for encrypted rooms, after local decryption.

## Agent Visibility

The tool is available to the main orchestrator and `general`/`research`
sub-agents. It is marked read-only and historical output is treated as
untrusted content before it reaches the model. Cron agents do not receive the
tool by default.

## Future Extensions

The first version is lexical FTS5 search. Local embeddings can be added later
as a second index without changing the tool contract. Semantic recall and
automatic prompt injection should remain separate from exact transcript
search until retrieval quality and data-leak tests are established.
