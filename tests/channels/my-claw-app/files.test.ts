/**
 * Which stored copies are one content under two names.
 *
 * Measured on the starter-kit thread, 2026-09-23: the run's TTS produced `output.mp3`, the answer
 * delivered it with `MEDIA:/home/neras/dev/reponse-vocale-my-claw.mp3` after copying it out of the
 * scratch dir, and the bubble drew the voice note twice -- one player with its duration and one
 * without. The store keeps both copies by contract (every named file keeps its own), so identity
 * is not the store's question: this answers it once, for the readers that must not draw one
 * content twice.
 */
import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionFileStore } from "../../../src/channels/my-claw-app/files.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("SessionFileStore.duplicatesAmong", () => {
  test("two names for one content resolve to one id", async () => {
    const store = new SessionFileStore();
    const first = await store.save("neras", "t-dup-map", "reponse-vocale-my-claw.mp3", bytes("the voice"));
    const dir = await mkdtemp(join(tmpdir(), "dup-source"));
    const source = join(dir, "output.mp3");
    await writeFile(source, bytes("the voice"));
    const second = await store.saveFromPath("neras", "t-dup-map", source);

    // The contract: both copies are kept, under their own names.
    expect(second.id).not.toBe(first.id);
    expect(await store.list("neras", "t-dup-map")).toHaveLength(2);

    // And the verdict: they are one content, resolved to one of the two.
    const duplicates = await store.duplicatesAmong("neras", "t-dup-map");
    expect(duplicates.size).toBe(1);
    const [from, to] = [...duplicates.entries()][0]!;
    expect([from, to].sort()).toEqual([first.id, second.id].sort());
  });

  test("different bytes are never each other's duplicate", async () => {
    const store = new SessionFileStore();
    await store.save("neras", "t-dup-distinct", "take-1.mp3", bytes("first take"));
    await store.save("neras", "t-dup-distinct", "take-2.mp3", bytes("second take"));

    expect((await store.duplicatesAmong("neras", "t-dup-distinct")).size).toBe(0);
  });

  test("a file is classified by its name, and by its bytes when the name settles nothing", async () => {
    const store = new SessionFileStore();
    const notes = await store.save("neras", "t-kind", "notes.md", bytes("# Title"));
    expect(notes.kind).toBe("markdown");
    expect(notes.type).toBe("file");
    expect(notes.mimeType).toBe("text/markdown");

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const shot = await store.save("neras", "t-kind", "shot.png", png);
    expect(shot.kind).toBe("image");
    expect(shot.type).toBe("image");

    // No extension at all: the bytes are the only thing that can answer, and they do.
    const bare = await store.save("neras", "t-kind", "capture", png);
    expect(bare.kind).toBe("image");
    expect(bare.mimeType).toBe("image/png");

    // The listing agrees with what the write decided, without opening anything.
    const listed = await store.list("neras", "t-kind");
    expect(listed.find((f) => f.filename === "notes.md")?.kind).toBe("markdown");
    expect(listed.find((f) => f.filename === "shot.png")?.kind).toBe("image");
    expect(listed.find((f) => f.filename === "capture")?.kind).toBe("image");
  });

  test("the same bytes in another thread are none of its business", async () => {
    const store = new SessionFileStore();
    await store.save("neras", "t-dup-scope-a", "voice.mp3", bytes("the voice"));
    await store.save("neras", "t-dup-scope-b", "voice.mp3", bytes("the voice"));

    expect((await store.duplicatesAmong("neras", "t-dup-scope-a")).size).toBe(0);
  });
});
