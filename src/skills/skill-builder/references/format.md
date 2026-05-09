# Skill Format Reference

## Frontmatter (YAML)

Required fields:
- `name`: lowercase-with-hyphens, max 64 chars
- `description`: one line, max 1024 chars

Optional:
- `version`: semantic version (e.g., 1.2.0)

```yaml
---
name: deploy-docker
description: Build, tag, and push Docker images with proper caching
version: 1.0.0
---
```

## Body Structure

### Section 1: When to Use

Bullet list of trigger conditions. Be specific.

Bad: "Use this for Docker."
Good: "Use when you need to build a multi-stage Dockerfile, tag with git SHA, and push to a registry."

### Section 2: Workflow

Numbered steps. The agent follows these literally.

Keep to 3-7 steps. If more are needed, move detail to `references/`.

### Section 3: References

List files in `references/` with one-line descriptions of what each contains.

```markdown
## References

- `references/dockerfile-patterns.md` — Multi-stage build examples
- `references/registry-auth.md` — Login and token management
```

### Section 4: Examples (optional)

Short example of expected input/output, or point to `examples/`.

## Length Limits

| Component | Recommended Max |
|---|---|
| SKILL.md | 80 lines |
| references/*.md | 200 lines each |
| Total skill directory | 500 lines |

## File Paths

Always use paths relative to the skill root:

```markdown
Read `references/api.md` for endpoint details.
```

The agent resolves these against the skill directory automatically.
