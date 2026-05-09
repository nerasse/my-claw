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

Use `update_skill(name, instructions)` to modify SKILL.md.

For multi-file skills, use `read` to check current `references/` content, then `write` to update specific files.

## Deleting Skills

`delete_skill(name)` removes the skill directory. Use this when a skill is obsolete or replaced.

## Versioning

Increment version when:
- Workflow steps change significantly
- Trigger conditions are refined
- New references are added

Do not increment for typo fixes.
