/**
 * One player per content, however the turn carried it.
 *
 * The bubble of 2026-09-23 (the starter-kit thread): a voice note the run's TTS produced and the
 * answer delivered with `MEDIA:` reached a reopened thread as two refs and two copies, and
 * `displayOf` concatenates a turn's own refs with what its tools attached -- so the bubble drew
 * two players for the same voice, one with its duration and one without. The live frame carries
 * the refs and the run's media side by side now too (the adapter asks the same store), so this
 * resolver and that path are one rule: the refs' names, then what nothing named yet.
 *
 * What must survive the fix is what is *not* a duplicate: the screenshots a tool produced beside a
 * PDF the agent delivered ride the same bubble and belong to the owner (measured on thread
 * 3fad6e60: a delivered PDF plus 3 to 6 browser captures per turn).
 */
import { test, expect, describe } from "bun:test";
import { mediaRefAttachments } from "../../../src/channels/my-claw-app/sessions.ts";
import type { MediaRef } from "../../../src/channels/my-claw-app/display.ts";
import type { SessionFile } from "../../../src/channels/my-claw-app/files.ts";

const file = (id: string, filename: string, sizeBytes = 10): SessionFile => ({
  id,
  filename,
  storedName: `${id}__${filename}`,
  type: "audio",
  mimeType: "audio/mpeg",
  sizeBytes,
  ts: "2026-09-23T20:00:00.000Z",
});

describe("mediaRefAttachments", () => {
  test("a voice note its answer names is one player, not two", () => {
    const refs: MediaRef[] = [
      // The answer's own ref, resolved to the copy its name kept.
      { path: "/home/neras/dev/reponse-vocale-my-claw.mp3" },
      // What the run's tools attached, already paired with its own copy by its end marker.
      { path: "/tmp/tts-pphoL9/output.mp3", id: "run-copy" },
    ];
    const files = [
      file("named-copy", "reponse-vocale-my-claw.mp3"),
      file("run-copy", "output.mp3"),
    ];
    // The store's verdict: the two copies are one content.
    const duplicates = new Map([["run-copy", "named-copy"]]);

    const out = mediaRefAttachments(refs, files, duplicates);
    expect(out).toHaveLength(1);
    // The name the answer gave it wins.
    expect(out[0]).toMatchObject({ id: "named-copy", filename: "reponse-vocale-my-claw.mp3" });
  });

  test("a run's media the answer does not name stays: captures beside a delivered file", () => {
    const refs: MediaRef[] = [
      { path: "/home/neras/career/rapport.pdf" },
      { path: "/tmp/browser-1.png", id: "shot-1" },
      { path: "/tmp/browser-2.png", id: "shot-2" },
    ];
    const files = [file("report", "rapport.pdf"), file("shot-1", "browser-1.png"), file("shot-2", "browser-2.png", 20)];

    const out = mediaRefAttachments(refs, files, new Map());
    expect(out.map((a) => a.id)).toEqual(["report", "shot-1", "shot-2"]);
  });

  test("two copies of one content anywhere on the bubble draw once", () => {
    const refs: MediaRef[] = [
      { path: "/tmp/a.png", id: "X" },
      { path: "/tmp/b.png", id: "Y" },
    ];
    const duplicates = new Map([["Y", "X"]]);

    expect(mediaRefAttachments(refs, [], duplicates)).toHaveLength(1);
  });

  test("a marker naming one copy twice draws it once", () => {
    const refs: MediaRef[] = [
      { path: "/tmp/a.png", id: "X" },
      { path: "/tmp/b.png", id: "X" },
    ];

    expect(mediaRefAttachments(refs, [])).toHaveLength(1);
  });
});
