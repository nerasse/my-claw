import { describe, test, expect, afterEach } from "bun:test";
import { readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readAgentFile,
  writeAgentFile,
  createAgentFile,
  deleteAgentFile,
  serializeAgentFile,
  fieldsOfMeta,
} from "../../src/agents/edit.ts";
import { parseAgentFile } from "../../src/agents/loader.ts";

const DIR = join(process.env["MY_CLAW_DIR"] ?? "/tmp/my-claw-test-agents-edit", "agents");

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("serializeAgentFile", () => {
  test("serializes the flat frontmatter the loader parses back", () => {
    const text = serializeAgentFile(
      {
        description: "Reviews a diff",
        base: "research",
        tools: ["read", "grep"],
        skillsMode: "list",
        skills: ["code-review"],
        mcpMode: "all",
        model: "opus",
        maxIterations: 10,
        contextCap: 0,
        instructions: ["CORE", "USER"],
      },
      "You review code.\n",
    );
    expect(text).toBe(
      "---\ndescription: Reviews a diff\nbase: research\ntools: read, grep\nskills: code-review\nmcp: *\nmodel: opus\nmaxIterations: 10\ncontextCap: 0\ninstructions: CORE, USER\n---\n\nYou review code.\n",
    );
    const parsed = parseAgentFile(text, "reviewer", "/x/reviewer.md");
    expect("rejected" in parsed).toBe(false);
    if ("rejected" in parsed) return;
    expect(parsed.meta).toMatchObject({
      description: "Reviews a diff",
      base: "research",
      tools: ["read", "grep"],
      skills: ["code-review"],
      mcp: "all",
      model: "opus",
      maxIterations: 10,
      contextCap: 0,
      instructions: ["CORE", "USER"],
    });
    expect(parsed.prompt).toBe("You review code.\n");
  });

  test("a description containing a colon survives the round-trip", () => {
    const text = serializeAgentFile({ description: "Checks: the CI gate", skillsMode: "absent", mcpMode: "absent" }, "body");
    const parsed = parseAgentFile(text, "a", "/x/a.md");
    expect("rejected" in parsed).toBe(false);
    if (!("rejected" in parsed)) expect(parsed.meta.description).toBe("Checks: the CI gate");
  });

  test("omitted fields are absent from the frontmatter", () => {
    const text = serializeAgentFile({ description: "Minimal", skillsMode: "absent", mcpMode: "absent" }, "body");
    expect(text).toBe("---\ndescription: Minimal\n---\n\nbody\n");
  });
});

describe("fieldsOfMeta", () => {
  test("maps the loader vocabulary onto the editor fields", () => {
    const fields = fieldsOfMeta({
      description: "x",
      base: "general",
      tools: ["read"],
      skills: ["a", "b"],
      mcp: "all",
      maxIterations: 5,
      instructions: ["CORE"],
    });
    expect(fields).toMatchObject({
      description: "x",
      base: "general",
      tools: ["read"],
      skillsMode: "list",
      skills: ["a", "b"],
      mcpMode: "all",
      maxIterations: 5,
      instructions: ["CORE"],
    });
  });
});

describe("writeAgentFile", () => {
  test("writes and reports the new sha", async () => {
    await mkdir(DIR, { recursive: true });
    const path = join(DIR, "reviewer.md");
    const first = await writeAgentFile(path, serializeAgentFile({ description: "v1", skillsMode: "absent", mcpMode: "absent" }, "body"), undefined, "reviewer");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await writeAgentFile(path, serializeAgentFile({ description: "v2", skillsMode: "absent", mcpMode: "absent" }, "body"), first.sha, "reviewer");
    expect(second.ok).toBe(true);
    expect((await readFile(path, "utf-8")).includes("description: v2")).toBe(true);
  });

  test("refuses a stale sha as a conflict without touching the file", async () => {
    await mkdir(DIR, { recursive: true });
    const path = join(DIR, "reviewer.md");
    const first = await writeAgentFile(path, serializeAgentFile({ description: "v1", skillsMode: "absent", mcpMode: "absent" }, "body"), undefined, "reviewer");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stale = await writeAgentFile(path, serializeAgentFile({ description: "stale", skillsMode: "absent", mcpMode: "absent" }, "body"), "aaaaaaaaaaaa", "reviewer");
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.conflict).toBe(true);
    }
    expect((await readFile(path, "utf-8")).includes("description: v1")).toBe(true);
  });

  test("refuses a file the loader would reject", async () => {
    await mkdir(DIR, { recursive: true });
    const path = join(DIR, "reviewer.md");
    const result = await writeAgentFile(path, "no frontmatter here", undefined, "reviewer");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(false);
      expect(result.error).toMatch(/rejected/);
    }
  });
});

describe("createAgentFile", () => {
  test("creates a custom-tier file the loader accepts", async () => {
    const result = await createAgentFile(DIR, "reviewer", "Reviews a diff");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(DIR, "reviewer.md"));
    const doc = await readAgentFile(result.path);
    expect(doc).not.toBeNull();
    const parsed = doc ? parseAgentFile(doc.text, "reviewer", result.path) : null;
    expect("rejected" in (parsed ?? { rejected: "no-frontmatter" })).toBe(false);
  });

  test("refuses an existing name", async () => {
    await createAgentFile(DIR, "reviewer", "Reviews a diff");
    const again = await createAgentFile(DIR, "reviewer", "Again");
    expect(again.ok).toBe(false);
  });

  test("refuses a name the loader rejects", async () => {
    const result = await createAgentFile(DIR, "Bad Name", "x");
    expect(result.ok).toBe(false);
    expect((await readdir(DIR).catch(() => [] as string[])).length).toBe(0);
  });
});

describe("deleteAgentFile", () => {
  test("removes the file", async () => {
    const created = await createAgentFile(DIR, "reviewer", "Reviews a diff");
    if (!created.ok) throw new Error(created.error);
    await deleteAgentFile(created.path);
    expect(await readAgentFile(created.path)).toBeNull();
  });
});
