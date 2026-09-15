/**
 * Storing a run's produced files before its marker is written -- docs/attachments.md.
 *
 * The marker is born able to name the copy or it never can: the log appends and never rewrites.
 * These tests hold the three things that make that work: one call per file, the id pinned back
 * onto the attachment the frame will carry, and a hole rather than a lost run when a store fails.
 */

import { describe, test, expect } from "bun:test";
import { storeRunMedia } from "../../src/agent/media-store.ts";
import type { Attachment } from "../../src/channels/types.ts";

const shot = (over: Partial<Attachment> = {}): Attachment => ({
  type: "image",
  path: "/tmp/browser-shot.png",
  ...over,
});

describe("storeRunMedia", () => {
  test("stores each file once and pins the id on the attachment the frame carries", async () => {
    const asked: string[] = [];
    const store = async (_sessionId: string, path: string) => {
      asked.push(path);
      return "f9929fee-16d2-4daf-8808-2212ec99d778";
    };
    const attachments = [shot(), shot({ path: "/tmp/other.png" })];

    const media = await storeRunMedia(attachments, "my-claw-app/thread/neras/t1", store);

    expect(asked).toEqual(["/tmp/browser-shot.png", "/tmp/other.png"]);
    expect(media.paths).toEqual(["/tmp/browser-shot.png", "/tmp/other.png"]);
    expect(media.ids).toEqual([
      "f9929fee-16d2-4daf-8808-2212ec99d778",
      "f9929fee-16d2-4daf-8808-2212ec99d778",
    ]);
    // The objects are the registry's own: the router sends these very attachments, and the frame
    // must name the copy the marker names.
    expect(attachments[0]!.id).toBe("f9929fee-16d2-4daf-8808-2212ec99d778");
    expect(attachments[1]!.id).toBe("f9929fee-16d2-4daf-8808-2212ec99d778");
  });

  test("a file already stored is not stored twice", async () => {
    let calls = 0;
    const store = async () => {
      calls += 1;
      return "second-copy";
    };
    const attachments = [shot({ id: "first-copy" })];
    const media = await storeRunMedia(attachments, "s", store);
    expect(calls).toBe(0);
    expect(media.ids).toEqual(["first-copy"]);
    expect(attachments[0]!.id).toBe("first-copy");
  });

  test("a store that fails leaves a hole, and the run keeps its paths", async () => {
    const store = async () => {
      throw new Error("disk full");
    };
    const media = await storeRunMedia([shot()], "s", store);
    expect(media.paths).toEqual(["/tmp/browser-shot.png"]);
    expect(media.ids).toEqual([null]);
  });

  test("a run with nowhere to store records the paths alone", async () => {
    // Every marker before this existed, and what a channel without files still gets: the sweep at
    // boot pairs those later, and a channel that never reads them is not worse off.
    const media = await storeRunMedia([shot()], "s", undefined);
    expect(media).toEqual({ paths: ["/tmp/browser-shot.png"] });
  });

  test("an attachment with no bytes is not part of the marker", async () => {
    const media = await storeRunMedia([{ type: "file", filename: "notes.md" }, shot()], "s", async () => "id");
    expect(media.paths).toEqual(["/tmp/browser-shot.png"]);
    expect(media.ids).toEqual(["id"]);
  });
});
