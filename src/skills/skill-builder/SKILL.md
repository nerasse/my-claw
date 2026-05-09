---
name: skill-builder
description: Build high-quality reusable skills with progressive disclosure and multi-file references
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

SKILL.md should contain:
1. **What** the skill does (2-3 sentences)
2. **When** to use it (triggers)
3. **Quick workflow** (the 80/20 path)
4. **References** to deeper docs

The agent reads SKILL.md first, then pulls references only when needed.

## Writing SKILL.md

```markdown
---
name: my-skill
description: One-line description for the skills list
---

## When to Use

- Trigger condition 1
- Trigger condition 2

## Quick Workflow

1. Step one
2. Step two
3. Step three

## References

- Detailed format: read `references/format.md`
- Best practices: read `references/best-practices.md`
```

## Referencing Files

Use relative paths from the skill root. The agent resolves them automatically.

For scripts, use the `${SKILL_DIR}` placeholder. It is replaced with the absolute skill directory path when the skill is loaded:

```markdown
Run the helper: `bash python3 ${SKILL_DIR}/scripts/helper.py`
```

The agent sees the resolved absolute path and can execute it directly.

## Creating a Skill

Call `create_skill(name, description, instructions)` to write SKILL.md to `workspace/skills/`.

For multi-file skills, use `write` to create `references/` and `examples/` files after creating SKILL.md.

## Examples

- Minimal skill: read `examples/minimal.md`
- Multi-file skill: read `examples/multi-file.md`
