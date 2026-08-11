import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConfig,
  resolvePromptPolicy,
  findUnknownPromptWorkspaces,
  findShadowingWorkspaceKeys,
  HOT_OBJECT_SECTIONS,
} from "../../src/core/config.ts";
import { loadPromptFile, loadCorePrompt, resolvePromptFile, resetPromptFileCache } from "../../src/agent/prompt/loader.ts";

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prompt-policy-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  resetPromptFileCache();
});

describe("workspacePrompts validation", () => {
  test("a valid section parses", () => {
    const config = parseConfig(
      JSON.stringify({
        workspacePrompts: {
          default: { "SOUL.md": { inherit: "builtin" } },
          sofa: { "CORE.md": { inherit: "none" }, "AGENTS.md": { inherit: "lab", off: true } },
        },
      }),
    );
    expect(config.workspacePrompts?.sofa?.["AGENTS.md"]?.inherit).toBe("lab");
  });

  test("an unknown file name is refused at parse", () => {
    expect(() => parseConfig(JSON.stringify({ workspacePrompts: { sofa: { "FOO.md": { inherit: "none" } } } }))).toThrow(
      /is not a prompt file/,
    );
  });

  test("a non-object policy is refused", () => {
    expect(() => parseConfig(JSON.stringify({ workspacePrompts: { sofa: 42 } }))).toThrow(/must be an object/);
  });

  test("an empty inherit and a non-boolean off are refused", () => {
    expect(() => parseConfig(JSON.stringify({ workspacePrompts: { sofa: { "SOUL.md": { inherit: " " } } } }))).toThrow(
      /inherit/,
    );
    expect(() => parseConfig(JSON.stringify({ workspacePrompts: { sofa: { "SOUL.md": { off: "yes" } } } }))).toThrow(
      /off/,
    );
  });
});

describe("resolvePromptPolicy", () => {
  test("absent policy means inherit from the default workspace, layer on", () => {
    expect(resolvePromptPolicy(undefined, "sofa", "SOUL.md")).toEqual({ inherit: "default", off: false });
    expect(resolvePromptPolicy({}, "sofa", "SOUL.md")).toEqual({ inherit: "default", off: false });
  });

  test("a policy overrides per file, never per workspace", () => {
    const prompts = { sofa: { "SOUL.md": { inherit: "lab" }, "USER.md": { off: true } } };
    expect(resolvePromptPolicy(prompts, "sofa", "SOUL.md")).toEqual({ inherit: "lab", off: false });
    expect(resolvePromptPolicy(prompts, "sofa", "USER.md")).toEqual({ inherit: "default", off: true });
    expect(resolvePromptPolicy(prompts, "sofa", "AGENTS.md")).toEqual({ inherit: "default", off: false });
    expect(resolvePromptPolicy(prompts, "other", "SOUL.md")).toEqual({ inherit: "default", off: false });
  });
});

describe("the resolver honors the configured source", () => {
  test("no policy keeps the pre-existing behavior: fall back to the default workspace", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    expect(await loadPromptFile("SOUL.md", { workspaceDir: sofa, defaultWorkspaceDir: def })).toBe("default soul");
  });

  test("a key source reads that workspace's own file", async () => {
    const sofa = await tmpDir();
    const lab = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(lab, "SOUL.md"), "lab soul");
    await writeFile(join(def, "SOUL.md"), "default soul");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspaces: { sofa, lab },
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "lab" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe("lab soul");
  });

  test("one hop only: the source's own inheritance is never followed", async () => {
    const sofa = await tmpDir();
    const lab = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const template = await readFile(join(import.meta.dir, "..", "..", "docs", "prompt", "SOUL.md"), "utf-8");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspaces: { sofa, lab },
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "lab" } } },
    };
    // lab owns nothing: the ladder stops after one hop and lands on the shipped template, never
    // on lab's own inheritance (which would be default soul).
    expect(await loadPromptFile("SOUL.md", opts)).toBe(template);
  });

  test("inherit: none ends the ladder with nothing", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "none" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe("");
  });

  test("inherit: builtin reads the shipped template", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const template = await readFile(join(import.meta.dir, "..", "..", "docs", "prompt", "SOUL.md"), "utf-8");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "builtin" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe(template);
  });

  test("a source pointing at a removed workspace lands on the shipped template", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const template = await readFile(join(import.meta.dir, "..", "..", "docs", "prompt", "SOUL.md"), "utf-8");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspaces: { sofa },
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "ghost" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe(template);
  });

  test("a workspace cannot be its own source", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const template = await readFile(join(import.meta.dir, "..", "..", "docs", "prompt", "SOUL.md"), "utf-8");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspaces: { sofa },
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "sofa" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe(template);
  });

  test("an own file still wins over any policy", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(sofa, "SOUL.md"), "own soul");
    await writeFile(join(def, "SOUL.md"), "default soul");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "none" } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe("own soul");
  });
});

describe("off drops the layer", () => {
  test("off wins over an own file: nothing is read, not even the template", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(sofa, "SOUL.md"), "own soul");
    await writeFile(join(def, "SOUL.md"), "default soul");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { off: true } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe("");
  });

  test("off is per file: the other layers keep their resolution", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(def, "SOUL.md"), "default soul");
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { off: true } } },
    };
    expect(await loadPromptFile("SOUL.md", opts)).toBe("");
    expect(await loadPromptFile("USER.md", opts)).toBe(
      await readFile(join(import.meta.dir, "..", "..", "docs", "prompt", "USER.md"), "utf-8"),
    );
  });

  test("off on CORE.md suppresses the CORE_PROMPT fallback too", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    const opts = {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "CORE.md": { off: true } } },
    };
    expect(await loadCorePrompt(opts)).toBe("");
  });

  test("off resolves with origin off, so the page can say why", async () => {
    const sofa = await tmpDir();
    const def = await tmpDir();
    await writeFile(join(sofa, "SOUL.md"), "own soul");
    const res = await resolvePromptFile("SOUL.md", {
      workspaceDir: sofa,
      defaultWorkspaceDir: def,
      workspaceKey: "sofa",
      workspacePrompts: { sofa: { "SOUL.md": { off: true } } },
    });
    expect(res.origin).toBe("off");
    expect(res.content).toBe("");
  });
});

describe("boot reports", () => {
  test("policies addressing a workspace that does not exist are reported", () => {
    const config = parseConfig(
      JSON.stringify({
        workspaces: { sofa: "/tmp/sofa" },
        workspacePrompts: { sofa: { "SOUL.md": { inherit: "lab" } }, ghost: { "USER.md": { inherit: "none" } } },
      }),
    );
    expect(findUnknownPromptWorkspaces(config)).toEqual([{ key: "ghost" }]);
  });

  test("a policy keyed by the default workspace is never reported", () => {
    const config = parseConfig(JSON.stringify({ workspacePrompts: { default: { "CORE.md": { inherit: "builtin" } } } }));
    expect(findUnknownPromptWorkspaces(config)).toEqual([]);
  });

  test("workspace keys shadowing a prompt keyword are reported", () => {
    const config = parseConfig(JSON.stringify({ workspaces: { none: "/tmp/none", sofa: "/tmp/sofa" } }));
    expect(findShadowingWorkspaceKeys(config)).toEqual(["none"]);
  });
});

describe("hot reload", () => {
  test("workspacePrompts is a hot section, applied in place with no reboot", () => {
    expect(HOT_OBJECT_SECTIONS).toContain("workspacePrompts");
    const { applyHotReload } = require("../../src/core/config-watcher.ts") as typeof import("../../src/core/config-watcher.ts");
    const current = parseConfig(JSON.stringify({ workspaces: { sofa: "/tmp/sofa" } }));
    const next = parseConfig(
      JSON.stringify({
        workspaces: { sofa: "/tmp/sofa" },
        workspacePrompts: { sofa: { "SOUL.md": { inherit: "builtin" } } },
      }),
    );
    const result = applyHotReload(current, next);
    expect(result.changed).toContain("workspacePrompts");
    expect(result.rebootRequired).not.toContain("workspacePrompts");
    expect(current.workspacePrompts?.sofa?.["SOUL.md"]?.inherit).toBe("builtin");
  });
});
