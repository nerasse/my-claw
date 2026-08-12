# Prompt inheritance across workspaces

Prompt files are resolved per file through one ladder: the workspace's own file, then the
configured source, then the last known good, then the shipped template. A named workspace
therefore only needs the files it actually overrides (typically AGENTS.md) and still gets
the owner's persona and core directives.

## The ladder, in order

1. `<workspace>/<file>` — the file the workspace owns.
2. The configured source for that file (see policies below).
3. The last known good copy of the file (a file that broke is not silently dropped).
4. The shipped template.

A missing file is not an error: it falls through to the next rung.

## `config.workspacePrompts` policies

Keyed by workspace key (including `default`) and prompt file name (CORE.md, SOUL.md,
AGENTS.md, USER.md). Absent policy means the default: fall back to the **default workspace**.

```json
{
  "workspacePrompts": {
    "sofa": {
      "AGENTS.md": { "inherit": "default" },
      "SOUL.md": { "inherit": "none" }
    }
  }
}
```

- `inherit: "default"` — the default behaviour, reads the default workspace's file.
- `inherit: "<named-workspace>"` — reads that workspace's **own** file only, never its own
  inheritance: one hop, so cycles are impossible by construction.
- `inherit: "builtin"` — reads the shipped template as the source.
- `inherit: "none"` — ends the ladder with an empty layer.
- `off: true` — drops the layer even when the workspace owns the file (CORE.md's hardcoded
  fallback included).

The policy is edited by writing `config.workspacePrompts` into `config.json` (hot reloaded)
or through the app's instructions page.

## Practical guidance for scaffolding

- Only create the overrides the owner asked for; everything else should inherit.
- AGENTS.md is the usual per-project override (build commands, project conventions).
- SOUL.md/ USER.md/CORE.md usually stay inherited so the persona remains consistent.
