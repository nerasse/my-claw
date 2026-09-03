import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile, readdir, rm, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  spillToolOutput,
  readToolOutput,
  sweepOrphanToolOutput,
  toolOutputDir,
  toolOutputPath,
  SPILL_THRESHOLD,
  MESSAGE_CEILING_CHARS,
} from "../../src/sessions/tool-output.ts";
import { sessionDir, type Entry } from "../../src/sessions/log.ts";

const SESSION = "spill-test";

beforeEach(async () => {
  await rm(sessionDir(SESSION), { recursive: true, force: true });
  await mkdir(sessionDir(SESSION), { recursive: true });
});

/** A settled tool entry, which is the only thing that owns a spilled file. */
const toolEntry = (callId: string): Entry =>
  ({
    id: `e-${callId}`, seq: 0, parentId: null, ts: 0, type: "tool", prompt: true,
    callId, name: "bash", args: {}, output: "", truncated: true, ok: true, runId: "r1",
  }) as Entry;

describe("spillToolOutput", () => {
  test("a short output stays in the entry", async () => {
    const result = await spillToolOutput(SESSION, "c1", "court");
    expect(result).toEqual({ output: "court", message: "court", truncated: false });
    // And nothing is created for it: a directory per conversation that never spilled is noise.
    await expect(readdir(toolOutputDir(SESSION))).rejects.toThrow();
  });

  test("an output exactly at the threshold still fits", async () => {
    const result = await spillToolOutput(SESSION, "c1", "x".repeat(10), 10);
    expect(result.truncated).toBe(false);
    expect(result.outputPath).toBeUndefined();
  });

  test("a long output is split: an extract in the entry, the whole of it on disk", async () => {
    const output = "x".repeat(20_000) + "MIDDLE" + "y".repeat(20_000);
    const result = await spillToolOutput(SESSION, "c1", output, 10);
    expect(result.output.length).toBeLessThan(output.length);
    expect(result.output).toContain("elided");
    expect(result.output).toContain(toolOutputPath(SESSION, "c1"));
    expect(result.output).toContain("read that file");
    // Head and tail, never head alone: the verdict of a command is on its last line.
    expect(result.output.startsWith("x")).toBe(true);
    expect(result.output.endsWith("y")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBe(toolOutputPath(SESSION, "c1"));
    expect(await readToolOutput(SESSION, "c1")).toBe(output);
  });

  test("the run that made the call keeps far more than the entry does", async () => {
    // Two views of one output, and the archive is neither of them: the entry is what every later
    // run replays, the message is what the run that asked still gets to work with.
    const output = "x".repeat(MESSAGE_CEILING_CHARS * 2);
    const result = await spillToolOutput(SESSION, "c3", output, 10);
    expect(result.output.length).toBeLessThan(result.message.length);
    expect(result.message.length).toBeGreaterThan(MESSAGE_CEILING_CHARS - 1);
    expect(result.message).toContain("read that file");
    expect(await readToolOutput(SESSION, "c3")).toBe(output);
  });

  test("a small output above threshold but below the extract keeps full content inline", async () => {
    const output = "x".repeat(25) + "FIN";
    const result = await spillToolOutput(SESSION, "c2", output, 10);
    // Nothing to elide, so no marker: a stub is only worth its cost when it replaces something.
    expect(result.output).toBe(output);
    expect(result.message).toBe(output);
    expect(result.truncated).toBe(true);
    expect(result.outputPath).toBe(toolOutputPath(SESSION, "c2"));
    expect(await readToolOutput(SESSION, "c2")).toBe(output);
  });

  test("the entry is the cheap view and the message the generous one", async () => {
    // A JSONL line is parsed whole, so what the entry keeps is paid on every read of that
    // conversation, forever; what the message keeps is paid by one run.
    expect(SPILL_THRESHOLD).toBeGreaterThan(4000);
    expect(MESSAGE_CEILING_CHARS).toBeGreaterThan(SPILL_THRESHOLD);
  });

  test("a call id cannot walk out of the session", async () => {
    // Ids come from a model. Every one seen so far is alphanumeric; that is not a guarantee.
    const result = await spillToolOutput(SESSION, "../../escape", "y".repeat(20), 5);
    // The separators are what matter, not the dots: `.._.._escape` is a file name, `../../` is a
    // route out. Asserting on the resolved path is the only check that says which one this is.
    expect(resolve(result.outputPath!)).toBe(join(toolOutputDir(SESSION), ".._.._escape"));
    expect(await readToolOutput(SESSION, "../../escape")).toBe("y".repeat(20));
  });

  test("two calls do not share a file", async () => {
    await spillToolOutput(SESSION, "c1", "un".repeat(20), 5);
    await spillToolOutput(SESSION, "c2", "deux".repeat(20), 5);
    expect(await readToolOutput(SESSION, "c1")).toContain("un");
    expect(await readToolOutput(SESSION, "c2")).toContain("deux");
  });

  test("a write that fails still hands back an extract", async () => {
    // A card with a clipped body and no "see all" is degraded; a thrown append would be a lost
    // turn. The session directory is replaced by a file so the mkdir cannot succeed.
    await rm(sessionDir(SESSION), { recursive: true, force: true });
    await mkdir(join(sessionDir(SESSION), ".."), { recursive: true });
    await writeFile(sessionDir(SESSION), "not a directory", "utf-8");
    const result = await spillToolOutput(SESSION, "c1", "z".repeat(20), 5);
    expect(result).toEqual({ output: "zzzzz", message: "z".repeat(20), truncated: true });
    // Neither view may name a path: there is no file at the end of it.
    expect(result.outputPath).toBeUndefined();
    expect(result.message).not.toContain("read that file");
  });
});

describe("readToolOutput", () => {
  test("nothing spilled is null, not an error", async () => {
    expect(await readToolOutput(SESSION, "never")).toBeNull();
  });
});

describe("sweepOrphanToolOutput", () => {
  test("a file an entry names is kept", async () => {
    // No TTL: the file lives exactly as long as its entry. opencode expires theirs because their
    // store is global and a file there has no owner; here it has one.
    await spillToolOutput(SESSION, "c1", "a".repeat(20), 5);
    expect(await sweepOrphanToolOutput(SESSION, [toolEntry("c1")])).toBe(0);
    expect(await readToolOutput(SESSION, "c1")).not.toBeNull();
  });

  test("an old file an entry still names is kept, however old", async () => {
    // The test that fails if anyone reintroduces a clock: deleting this would answer a "see all"
    // button with nothing, which is a broken promise rather than a policy.
    await spillToolOutput(SESSION, "c1", "a".repeat(20), 5);
    const ancient = new Date("2000-01-01T00:00:00Z");
    await utimes(toolOutputPath(SESSION, "c1"), ancient, ancient);
    expect(await sweepOrphanToolOutput(SESSION, [toolEntry("c1")])).toBe(0);
    expect(await readToolOutput(SESSION, "c1")).not.toBeNull();
  });

  test("a file no entry names is the residue of a killed run, and goes", async () => {
    await spillToolOutput(SESSION, "orphan", "b".repeat(20), 5);
    expect(await sweepOrphanToolOutput(SESSION, [])).toBe(1);
    expect(await readToolOutput(SESSION, "orphan")).toBeNull();
  });

  test("the sweep keeps and removes in the same pass", async () => {
    await spillToolOutput(SESSION, "kept", "a".repeat(20), 5);
    await spillToolOutput(SESSION, "gone", "b".repeat(20), 5);
    expect(await sweepOrphanToolOutput(SESSION, [toolEntry("kept")])).toBe(1);
    expect(await readToolOutput(SESSION, "kept")).not.toBeNull();
    expect(await readToolOutput(SESSION, "gone")).toBeNull();
  });

  test("only tool entries own a file", async () => {
    await spillToolOutput(SESSION, "c1", "a".repeat(20), 5);
    const note = { id: "n1", seq: 0, parentId: null, ts: 0, type: "note", prompt: false, text: "c1" } as Entry;
    expect(await sweepOrphanToolOutput(SESSION, [note])).toBe(1);
  });

  test("a conversation that never spilled sweeps nothing", async () => {
    expect(await sweepOrphanToolOutput(SESSION, [toolEntry("c1")])).toBe(0);
  });
});
