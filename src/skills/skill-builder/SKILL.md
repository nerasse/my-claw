---
name: skill-builder
description: Build high-quality reusable skills with progressive disclosure and multi-file references
agents: main
---

# Skill Builder

A skill is a reusable instruction set the agent loads on demand. This skill teaches you how to build them.

## When to Build a Skill

- You repeat the same multi-step workflow
- A task domain is complex enough to need structured guidance
- You want to share a pattern across sessions or sub-agents

## Structure

```
skill-name/
├── SKILL.md              # Entry point (required)
├── references/           # Optional: detailed docs
│   ├── format.md
│   └── best-practices.md
├── examples/             # Optional: sample outputs
│   └── minimal.md
└── scripts/              # Optional: executable helpers
```

## Progressive Disclosure

Keep SKILL.md under 80 lines. Move deep detail to `references/` files.

SKILL.md holds four things: **what** the skill does (2-3 sentences), **when** to use it (triggers),
the **quick workflow** (the 80/20 path), and **pointers** to deeper docs. The agent reads SKILL.md
first, then pulls a reference only when needed.

## Writing SKILL.md

Frontmatter is `name` + one-line `description` (single-line fields only). The body template with
the four sections in order: read `references/format.md`.

## Referencing Files

Paths are relative to the skill root and the agent resolves them automatically. A script needs
its absolute path: use the `${SKILL_DIR}` placeholder, replaced at load time.

```markdown
Run the helper: `bash python3 ${SKILL_DIR}/scripts/helper.py`
```

## Secrets and Credentials

Two homes for secrets, never a third: key=value secrets (API keys, OAuth tokens, passwords) in
`~/.my-claw/.env` (0600), file secrets (keystores, keyfiles, cookie jars) in `~/.my-claw/secrets/`
(0700). Reuse the key names already in use. Never in the skill directory, the workspace, or a repo.

Details: read `references/best-practices.md` (Secrets and Credentials).

## Creating a Skill

Call `skills(action="create", name=..., description=..., instructions=...)` to write SKILL.md to `workspace/skills/`.

For multi-file skills, use `write` to create `references/` and `examples/` files after creating SKILL.md.

## Examples

- Minimal skill: read `examples/minimal.md`
- Multi-file skill: read `examples/multi-file.md`
