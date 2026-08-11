import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_INSTRUCTION_BYTES,
  instructionPath,
  listInstructions,
  readInstruction,
  readNestedInstruction,
  scanNestedInstructions,
  writeInstruction,
  workspaceRoots,
  type InstructionRoots,
} from "../src/channels/my-claw-app/instructions.ts";
import { PROMPT_FILES } from "../src/agent/prompt/files.ts";
import { resetPromptFileCache, loadPromptFile } from "../src/agent/prompt/loader.ts";
import { contentSha, history, readSnapshot } from "../src/core/config-store.ts";

let base: string;
let roots: InstructionRoots;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "instructions-"));
  await mkdir(join(base, "default"), { recursive: true });
  await mkdir(join(base, "sofa"), { recursive: true });
  roots = { defaultDir: join(base, "default"), workspaces: { sofa: join(base, "sofa") } };
  for (const f of PROMPT_FILES) {
    await writeFile(join(base, "default", f), `default ${f}\n`, "utf-8");
  }
  // readInstruction now shares the loader's mtime cache: two writes inside one millisecond would
  // otherwise be invisible to it. Fresh cache per test, like the loader's own tests.
  resetPromptFileCache();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("path resolution", () => {
  test("the four prompt files resolve, nothing else does", async () => {
    for (const f of PROMPT_FILES) {
      expect(instructionPath(roots, "default", f)).toBe(join(base, "default", f));
    }
    // MEMORY.md is generated from the DB and SYSTEM/TOOLS are read by no line of src/.
    for (const f of ["MEMORY.md", "SYSTEM.md", "TOOLS.md", "SKILL.md", "config.json"]) {
      expect(instructionPath(roots, "default", f)).toBeNull();
    }
  });

  test("a crafted name cannot escape the workspace", () => {
    for (const name of [
      "../config.json",
      "../../etc/passwd",
      "sub/AGENTS.md",
      "AGENTS.md/../../CORE.md",
      "/etc/passwd",
      "",
      ".",
    ]) {
      expect(instructionPath(roots, "default", name)).toBeNull();
    }
  });

  test("an unknown workspace is refused instead of falling back to the default one", () => {
    // Falling back would edit the default workspace's prompt while the app showed another name.
    expect(instructionPath(roots, "ghost", "AGENTS.md")).toBeNull();
    expect(instructionPath(roots, "", "AGENTS.md")).toBeNull();
  });

  test("workspaceRoots always leads with default and never duplicates it", () => {
    const dup: InstructionRoots = { defaultDir: "/d", workspaces: { default: "/other", a: "/a" } };
    expect(workspaceRoots(dup).map((w) => w.key)).toEqual(["default", "a"]);
    expect(workspaceRoots(dup)[0]?.dir).toBe("/d");
  });
});

describe("inheritance", () => {
  test("a workspace without the file reads the default one, and says so", async () => {
    const read = await readInstruction(roots, "sofa", "SOUL.md");
    expect(read?.origin).toBe("inherited");
    expect(read?.from).toBe("default");
    expect(read?.content).toBe("default SOUL.md\n");
  });

  test("its own file wins over the inherited one", async () => {
    await writeFile(join(base, "sofa", "SOUL.md"), "sofa soul\n", "utf-8");
    const read = await readInstruction(roots, "sofa", "SOUL.md");
    expect(read?.origin).toBe("own");
    expect(read?.from).toBe("sofa");
    expect(read?.content).toBe("sofa soul\n");
  });

  test("with no file anywhere the shipped default is shown rather than an empty editor", async () => {
    await rm(join(base, "default", "CORE.md"));
    const read = await readInstruction(roots, "sofa", "CORE.md");
    expect(read?.origin).toBe("fallback");
    expect(read?.from).toBe("");
    expect(read?.content.length).toBeGreaterThan(0);
  });

  test("the list covers every file of every workspace, with no hole", async () => {
    const entries = await listInstructions(roots);
    expect(entries.length).toBe(PROMPT_FILES.length * 2);
    expect(entries.filter((e) => e.workspace === "sofa").every((e) => e.origin === "inherited")).toBe(true);
    expect(entries.every((e) => e.sha.length > 0)).toBe(true);
  });

  test("the listed sha is the sha of the content that applies", async () => {
    const entries = await listInstructions(roots);
    const entry = entries.find((e) => e.workspace === "sofa" && e.file === "USER.md");
    expect(entry?.sha).toBe(contentSha("default USER.md\n"));
  });
});

describe("writing", () => {
  test("a write needs the sha the editor loaded", async () => {
    const before = await readInstruction(roots, "default", "AGENTS.md");
    const res = await writeInstruction(roots, "default", "AGENTS.md", "edited\n", before!.sha);
    expect(res.ok).toBe(true);
    expect(await readFile(join(base, "default", "AGENTS.md"), "utf-8")).toBe("edited\n");
  });

  test("a stale sha is refused as a conflict, and the file is left alone", async () => {
    const before = await readInstruction(roots, "default", "AGENTS.md");
    // What the agent doing its own write to AGENTS.md looks like from the editor's side.
    await writeFile(join(base, "default", "AGENTS.md"), "written by the agent\n", "utf-8");

    const res = await writeInstruction(roots, "default", "AGENTS.md", "editor content\n", before!.sha);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.conflict).toBe(true);
    expect(await readFile(join(base, "default", "AGENTS.md"), "utf-8")).toBe("written by the agent\n");
  });

  test("creating an override needs no sha and pre-existing content refuses it", async () => {
    const created = await writeInstruction(roots, "sofa", "AGENTS.md", "sofa rules\n", undefined);
    expect(created.ok).toBe(true);
    expect(await readFile(join(base, "sofa", "AGENTS.md"), "utf-8")).toBe("sofa rules\n");

    const again = await writeInstruction(roots, "sofa", "AGENTS.md", "other\n", undefined);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.conflict).toBe(true);
    expect(await readFile(join(base, "sofa", "AGENTS.md"), "utf-8")).toBe("sofa rules\n");
  });

  test("creating an override with the inherited content changes nothing for the agent", async () => {
    // The whole point of pre-filling: the file becomes editable without moving a single layer.
    const before = await readInstruction(roots, "sofa", "USER.md");
    await writeInstruction(roots, "sofa", "USER.md", before!.content, undefined);
    const after = await readInstruction(roots, "sofa", "USER.md");
    expect(after?.content).toBe(before!.content);
    expect(after?.origin).toBe("own");
  });

  test("a sha on a file that no longer exists is a conflict, not a silent create", async () => {
    const before = await readInstruction(roots, "default", "SOUL.md");
    await rm(join(base, "default", "SOUL.md"));
    const res = await writeInstruction(roots, "default", "SOUL.md", "x\n", before!.sha);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.conflict).toBe(true);
  });

  test("an oversized payload is refused before anything is written", async () => {
    const before = await readInstruction(roots, "default", "USER.md");
    const res = await writeInstruction(roots, "default", "USER.md", "x".repeat(MAX_INSTRUCTION_BYTES + 1), before!.sha);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("too large");
    expect(await readFile(join(base, "default", "USER.md"), "utf-8")).toBe("default USER.md\n");
  });

  test("a write outside the four names is refused", async () => {
    const res = await writeInstruction(roots, "default", "../config.json", "{}", undefined);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.conflict).toBeUndefined();
  });

  test("a write to an unknown workspace is refused", async () => {
    const res = await writeInstruction(roots, "ghost", "AGENTS.md", "x", undefined);
    expect(res.ok).toBe(false);
  });

  test("the returned sha matches what a reader gets next", async () => {
    const before = await readInstruction(roots, "default", "CORE.md");
    const res = await writeInstruction(roots, "default", "CORE.md", "new core\n", before!.sha);
    // readInstruction shares the loader's mtime cache: the write and the read could land in the
    // same millisecond, and mtimeMs equality would serve the pre-write content. Pin a later stamp,
    // like the loader's own tests do, so the assertion is about the write, not the clock.
    const later = new Date(Date.now() + 2000);
    await utimes(join(base, "default", "CORE.md"), later, later);
    const after = await readInstruction(roots, "default", "CORE.md");
    expect(res.ok === true && res.sha).toBe(after!.sha);
  });

  test("the previous content is snapshotted, so a bad edit is undoable", async () => {
    // This is what makes editing a prompt file from a phone acceptable: /config rollback can
    // put back what was there, through the same store that protects config.json.
    const before = await readInstruction(roots, "default", "SOUL.md");
    await writeInstruction(roots, "default", "SOUL.md", "replaced\n", before!.sha);

    const path = join(base, "default", "SOUL.md");
    const snaps = await history(path);
    expect(snaps.length).toBeGreaterThan(0);
    expect(await readSnapshot(path, snaps[snaps.length - 1]!.ref)).toBe("default SOUL.md\n");
  });

  test("a refused write leaves no snapshot behind", async () => {
    const path = join(base, "sofa", "AGENTS.md");
    await writeInstruction(roots, "sofa", "AGENTS.md", "x".repeat(MAX_INSTRUCTION_BYTES + 1), undefined);
    expect(await history(path)).toEqual([]);
  });

  test("two writes in a row work when the second uses the fresh sha", async () => {
    const first = await readInstruction(roots, "default", "AGENTS.md");
    const w1 = await writeInstruction(roots, "default", "AGENTS.md", "one\n", first!.sha);
    const w2 = await writeInstruction(roots, "default", "AGENTS.md", "two\n", w1.ok === true ? w1.sha : "");
    expect(w2.ok).toBe(true);
    expect(await readFile(join(base, "default", "AGENTS.md"), "utf-8")).toBe("two\n");
  });
});

describe("nested AGENTS.md", () => {
  test("they are found under a workspace, root excluded", async () => {
    await mkdir(join(base, "default", "svc", "api"), { recursive: true });
    await writeFile(join(base, "default", "svc", "AGENTS.md"), "svc\n", "utf-8");
    await writeFile(join(base, "default", "svc", "api", "AGENTS.md"), "api\n", "utf-8");

    const found = await scanNestedInstructions(roots);
    const paths = found.map((n) => n.path).sort();
    expect(paths).toEqual([join("svc", "AGENTS.md"), join("svc", "api", "AGENTS.md")]);
    // The workspace root's own AGENTS.md is layer 2 and already listed as an entry.
    expect(paths).not.toContain("AGENTS.md");
  });

  test("node_modules and dotted directories are never walked", async () => {
    for (const dir of ["node_modules", ".git", ".cache", "dist"]) {
      await mkdir(join(base, "default", dir, "pkg"), { recursive: true });
      await writeFile(join(base, "default", dir, "pkg", "AGENTS.md"), "noise\n", "utf-8");
    }
    expect(await scanNestedInstructions(roots)).toEqual([]);
  });

  test("the scan stops below a bounded depth", async () => {
    const deep = join(base, "default", "a", "b", "c", "d", "e");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "AGENTS.md"), "too deep\n", "utf-8");
    expect(await scanNestedInstructions(roots)).toEqual([]);
  });

  test("reading one goes through the workspace root, never a client path", async () => {
    await mkdir(join(base, "default", "svc"), { recursive: true });
    await writeFile(join(base, "default", "svc", "AGENTS.md"), "svc rules\n", "utf-8");
    expect(await readNestedInstruction(roots, "default", join("svc", "AGENTS.md"))).toBe("svc rules\n");

    for (const bad of ["../sofa/AGENTS.md", "../../etc/passwd", "svc/../../../etc/passwd", "svc/SKILL.md", "CORE.md"]) {
      expect(await readNestedInstruction(roots, "default", bad)).toBeNull();
    }
  });

  test("a symlinked escape resolves outside the root and is refused", async () => {
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "AGENTS.md"), "secret\n", "utf-8");
    await symlink(outside, join(base, "default", "link"), "dir");
    expect(await readNestedInstruction(roots, "default", join("..", "outside", "AGENTS.md"))).toBeNull();
  });
});

describe("the page and the runtime resolve through the same ladder", () => {
  test("own and inherited content agree with loadPromptFile", async () => {
    for (const f of ["SOUL.md", "AGENTS.md", "USER.md"]) {
      const page = await readInstruction(roots, "sofa", f);
      expect(page?.origin).toBe("inherited");
      expect(page?.from).toBe("default");
      const runtime = await loadPromptFile(f, {
        workspaceDir: join(base, "sofa"),
        defaultWorkspaceDir: roots.defaultDir,
      });
      expect(page?.content.trim()).toBe(runtime.trim());
    }
  });

  test("the fallback state agrees too: both read the shipped template", async () => {
    await rm(join(base, "default", "SOUL.md"));
    await rm(join(base, "default", "AGENTS.md"));
    await rm(join(base, "default", "USER.md"));
    for (const f of ["SOUL.md", "AGENTS.md", "USER.md"]) {
      const page = await readInstruction(roots, "sofa", f);
      expect(page?.origin).toBe("fallback");
      const runtime = await loadPromptFile(f, {
        workspaceDir: join(base, "sofa"),
        defaultWorkspaceDir: roots.defaultDir,
      });
      // The ladder's terminal template step is runtime behavior since the divergence was closed:
      // the page shows exactly what the agent reads, or nothing at all.
      expect(page?.content.trim()).toBe(runtime.trim());
    }
  });

  test("an own file agrees between the page and the runtime", async () => {
    await writeFile(join(base, "sofa", "SOUL.md"), "sofa soul\n", "utf-8");
    const page = await readInstruction(roots, "sofa", "SOUL.md");
    expect(page?.origin).toBe("own");
    expect(page?.from).toBe("sofa");
    const runtime = await loadPromptFile("SOUL.md", {
      workspaceDir: join(base, "sofa"),
      defaultWorkspaceDir: roots.defaultDir,
    });
    expect(page?.content.trim()).toBe(runtime.trim());
  });

  test("a configured source agrees between the page and the runtime", async () => {
    await mkdir(join(base, "lab"), { recursive: true });
    await writeFile(join(base, "lab", "SOUL.md"), "lab soul\n", "utf-8");
    roots = {
      defaultDir: roots.defaultDir,
      workspaces: { sofa: join(base, "sofa"), lab: join(base, "lab") },
      workspacePrompts: { sofa: { "SOUL.md": { inherit: "lab" } } },
    };
    const page = await readInstruction(roots, "sofa", "SOUL.md");
    expect(page?.origin).toBe("inherited");
    expect(page?.from).toBe("lab");
    const runtime = await loadPromptFile("SOUL.md", {
      workspaceDir: join(base, "sofa"),
      defaultWorkspaceDir: roots.defaultDir,
      workspaceKey: "sofa",
      workspaces: roots.workspaces,
      workspacePrompts: roots.workspacePrompts,
    });
    expect(page?.content.trim()).toBe(runtime.trim());
  });
});
