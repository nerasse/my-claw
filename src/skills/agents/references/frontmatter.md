# Agent frontmatter fields

All fields are flat `key: value` lines inside the `---` block. Only `description` is
required. Comma-separated values, never YAML lists.

| Field | Example | Meaning |
| --- | --- | --- |
| `description` | `Reviews a diff and reports risks` | One line, required. What the orchestrator reads to decide whether to spawn the agent. Max 1024 chars. |
| `base` | `general` / `research` | The tool baseline to narrow from. Unknown value falls back to `general` with a warning. |
| `tools` | `read, grep, find, ls` | Tool allowlist, intersected with the baseline. Absent = whole baseline. Naming a tool outside the baseline drops it rather than widening. |
| `skills` | `code-review` / `*` / `none` | Skill scope, same semantics as `agents.<key>.skills`. |
| `mcp` | `gitlab` / `*` / `none` | MCP server scope, same semantics as `agents.<key>.mcp`. |
| `model` | `anthropic/claude-sonnet-4` | A model id from the configured providers. Unknown id = dropped with a warning, the default applies. |
| `workspace` | `sofa` | A workspace key from `config.workspaces`. The agent runs there. |
| `maxIterations` | `10` | Positive integer iteration budget. |
| `contextCap` | `200000` | Context ceiling in tokens; `0` lifts the cap. Flat — there is no `context.cap` nesting in a file. |
| `instructions` | `CORE, SOUL` | Which prompt layers to include: `CORE`, `SOUL`, `AGENTS`, `USER`, or `none` for no layers. Default: all four, in the builder's fixed order regardless of how the file spells them. |

The body after the frontmatter is the agent's prompt.

## Rejection reasons

A file in an `agents/` tier does not become an agent when:

- the filename is not a valid name (`^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars)
- the name is reserved (`orchestrator`, `cron`, `main`)
- the file is larger than 64 KB
- there is no frontmatter
- there is no `description`

Each rejection is logged with a warning naming the file; the previous good version is kept
when a file that used to parse stops parsing.
