import { describe, test, expect } from "bun:test";
import { displayOf, placeAnchoredCommands, type DisplayResolvers } from "../../../src/channels/my-claw-app/display.ts";
import type { Entry, Provisioned } from "../../../src/sessions/log.ts";

/**
 * A slash command is journalled when it *answers*, which for a `/compact` sent mid-run is minutes
 * later: its record lands after the run, after the boundary it wrote, after the messages queued
 * behind it. These pin where its bubbles have to appear instead -- where the owner typed it.
 */

let seq = 0;
function chain(bodies: Array<Provisioned<Entry>>): Entry[] {
  const entries: Entry[] = [];
  let parent: string | null = null;
  for (const body of bodies) {
    const n = seq++;
    const made = { ...body, id: `e${n}`, seq: n, parentId: parent, ts: 1_800_000_000_000 + n * 1000 } as unknown as Entry;
    entries.push(made);
    parent = made.id;
  }
  return entries;
}

const user = (text: string) => ({ type: "user", prompt: true, text }) as Provisioned<Entry>;
const phase = (text: string, extra: Record<string, unknown> = {}) =>
  ({ type: "phase", prompt: true, text, runId: "r1", ...extra }) as Provisioned<Entry>;
const command = (extra: Record<string, unknown> = {}) =>
  ({ type: "command", prompt: false, input: "/compact", output: "Context compacted", ...extra }) as Provisioned<Entry>;

const resolvers: DisplayResolvers = {
  attachmentsOf: (attachments) => attachments.map((a, i) => ({ id: `att-${i}`, type: "image", name: a.path, size: 1 })),
  attachmentsOfBlock: (entries) => entries.map((e, i) => ({ id: `blk-${i}`, type: e.type as "image", filename: e.source, sizeBytes: 1 })),
  mediaOf: (refs) => refs.map((r, i) => ({ id: `media-${i}`, type: "file", name: r.path, size: 1 })),
};
const show = (entries: readonly Entry[]) => displayOf(entries, resolvers, 1000);

describe("placeAnchoredCommands", () => {
  test("a command journalled at the end comes back to the entry it was typed under", () => {
    const path = chain([user("question"), phase("je regarde"), phase("voilà"), command()]);
    const anchor = path[1]!.id;
    const moved = placeAnchoredCommands([...path.slice(0, 3), { ...path[3]!, afterId: anchor } as Entry]);

    expect(moved.map((entry) => entry.type)).toEqual(["user", "phase", "command", "phase"]);
    expect(moved[2]!.id).toBe(path[3]!.id);
  });

  test("two commands sent under the same leaf keep the order they were typed in", () => {
    const path = chain([user("question"), phase("voilà")]);
    const anchor = path[0]!.id;
    const first = { ...path[1]!, id: "c1", type: "command", input: "/cap", output: "720000", afterId: anchor } as Entry;
    const second = { ...path[1]!, id: "c2", type: "command", input: "/effort", output: "low", afterId: anchor } as Entry;

    const moved = placeAnchoredCommands([path[0]!, path[1]!, first, second]);
    expect(moved.map((entry) => entry.id)).toEqual([path[0]!.id, "c1", "c2", path[1]!.id]);
  });

  test("a command whose anchor sits above the window opens it", () => {
    const path = chain([phase("a"), phase("b"), command()]);
    const moved = placeAnchoredCommands([...path.slice(0, 2), { ...path[2]!, afterId: "gone-from-this-page" } as Entry]);
    expect(moved.map((entry) => entry.type)).toEqual(["command", "phase", "phase"]);
  });

  test("a command with no anchor stays where the log put it", () => {
    const path = chain([user("question"), phase("voilà"), command()]);
    expect(placeAnchoredCommands(path).map((entry) => entry.id)).toEqual(path.map((entry) => entry.id));
  });

  test("an entry that is not a command is never moved", () => {
    const path = chain([user("question"), phase("voilà")]);
    // A `user` entry carrying an unrelated `afterId`-shaped field is not a command.
    const withField = [{ ...path[0]!, afterId: "nope" } as Entry, path[1]!];
    expect(placeAnchoredCommands(withField).map((entry) => entry.id)).toEqual([path[0]!.id, path[1]!.id]);
  });
});

describe("displayOf: a command carries the instant it was sent", () => {
  test("both bubbles are stamped with the anchor, not with the journal's write time", () => {
    const sentAt = 1_800_000_000_500;
    const path = chain([user("question"), phase("voilà"), command({ anchorTs: sentAt, sourceId: "send-1" })]);

    const [input, output] = show(path).slice(-2);
    expect(input!.ts).toBe(new Date(sentAt).toISOString());
    expect(output!.ts).toBe(new Date(sentAt).toISOString());
  });

  test("without an anchor the entry keeps its own write time", () => {
    const path = chain([user("question"), command({ sourceId: "send-1" })]);
    const [input] = show(path).slice(-2);
    expect(input!.ts).toBe(new Date(path[1]!.ts).toISOString());
  });

  /**
   * The adjacency rule used to drop the answer bubble whenever a compaction boundary stood right
   * above the command in the file. Anchored, the boundary is no longer its neighbour on screen:
   * the pair a reader sees is the command and its own answer, so the answer stays.
   */
  test("an answer stops being dropped once the boundary is no longer its neighbour", () => {
    const path = chain([
      user("question"),
      { type: "compaction", prompt: true, summary: "résumé", firstKeptEntryId: "", tokensBefore: 1, count: 3 } as Provisioned<Entry>,
      command({ input: "/compact", output: "Context compacted · 3 turns" }),
    ]);
    const anchor = path[0]!.id;
    const window = placeAnchoredCommands([...path.slice(0, 2), { ...path[2]!, afterId: anchor } as Entry]);

    // On screen: question, /compact, its answer, then the boundary the command wrote.
    const shown = show(window);
    expect(shown.map((entry) => (entry.role === "tool" || entry.role === "run" ? entry.role : entry.text))).toEqual([
      "question",
      "/compact",
      "Context compacted · 3 turns",
      "résumé",
    ]);
  });
});
