# Skill Best Practices

## Naming

- Use action-oriented names: `deploy-node`, `security-audit`, `refactor-react`
- Avoid generic names: `helper`, `utils`, `stuff`

## Descriptions

Write for the skills list. The agent sees this before loading the skill.

Bad: "A skill for code."
Good: "Review code for null-pointer risks, race conditions, and resource leaks."

## Progressive Disclosure

Respect the agent's context window:

1. **Skills list** (~10 tokens per skill) — name + description only
2. **SKILL.md** (~500 tokens) — entry point, quick workflow
3. **References** (~1000+ tokens) — deep detail, loaded only when needed

## Triggers

Make trigger conditions unambiguous. The agent decides whether to load the skill based on these.

Bad triggers:
- "When working with code" (too broad)
- "Use your judgment" (vague)

Good triggers:
- "When reviewing a PR with >10 files changed"
- "When deploying to production Docker environments"
- "When asked to find memory leaks in C/C++"

## Updating Skills

Use `manage_skills(action="update", name=..., instructions=...)` to modify SKILL.md.

For multi-file skills, use `read` to check current `references/` content, then `write` to update specific files.

## Secrets and Credentials

A skill that talks to an API or an account needs a place for its credentials. This install has
exactly two, decided before your skill exists:

- **Key=value secrets** (API keys, OAuth tokens, service passwords) -> `~/.my-claw/.env`, one
  `KEY=VALUE` per line, mode 0600. Before creating a key, list the names already there
  (`cut -d= -f1 ~/.my-claw/.env`) and **reuse the existing name**: this install stores a Claude
  OAuth token as `CLAUDE_CODE_OAUTH_TOKEN`, and a second name holding the same token is a copy
  that will drift from the original.
- **File secrets** (keystores, JSON keyfiles, cookie jars) -> `~/.my-claw/secrets/`, directory
  mode 0700.
- **Never** in the skill directory, the workspace, `examples/`/`references/`, or a git repo: skill
  files are read by every session and can be synced or published. A key written into a skill is
  read by every future run.
- Code reads secrets from the environment (`loadEnv` / `process.env`), never hardcoded, never
  echoed in output or logs. The skill text names the variable, never the value.
- If the modes have drifted (`.env` is 0600, `secrets/` is 0700), restore them and say so.

## Deleting Skills

`manage_skills(action="delete", name=...)` removes the skill directory. Use this when a skill is obsolete or replaced.

## Versioning

Increment version when:
- Workflow steps change significantly
- Trigger conditions are refined
- New references are added

Do not increment for typo fixes.
