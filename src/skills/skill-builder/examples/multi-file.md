---
name: multi-file-example
description: Complex skill with references and examples split across files
---

## When to Use

- Multi-step deployment with environment-specific variations
- Need for detailed configuration examples

## Quick Workflow

1. Detect environment from `NODE_ENV` or `.env` files
2. Load the correct config profile (see `references/profiles.md`)
3. Run pre-deploy checks (`references/checklist.md`)
4. Execute deployment
5. Verify health endpoints

## References

- `references/profiles.md` — dev, staging, production config differences
- `references/checklist.md` — Pre-deploy validation steps
- `references/rollback.md` — Emergency rollback procedure

## Examples

- `examples/deploy-dev.md` — Full dev deployment transcript
- `examples/deploy-prod.md` — Production deployment with approvals
