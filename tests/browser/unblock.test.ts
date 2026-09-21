/**
 * What the unlock touches, and what it must never touch.
 *
 * The rules are the whole feature: a window the browser does not own is either a file chooser
 * (close it -- measured 2026-09-21, one of those behind the browser window ate every click on the
 * VNC display) or something else (raise it -- only the owner knows whether it was wanted). Written
 * against a fake X server so the order of the calls can be asserted: the Escape must land on a
 * window that was focused first, or it goes to whatever held the focus and does nothing.
 */

import { test, describe } from "bun:test";
import assert from "node:assert";
import {
  XdotoolMissingError,
  isBrowserWindow,
  isFileChooser,
  parseWindowIds,
  strayWindows,
  unblockDialogs,
  xdotoolRunner,
} from "../../src/browser/unblock.ts";

/** The two windows the incident left behind: the page, and the chooser that hid under it. */
const PAGE = "16777219";
const CHOOSER = "16777223";

function xdotoolWith(
  windows: Record<string, string>,
  /** The ids a `key` closes: everything else survives its Escape, as a window that ignores the key. */
  closes: string[] = [],
): {
  calls: string[][];
  run: (args: string[]) => Promise<string>;
} {
  const calls: string[][] = [];
  const alive = new Map(Object.entries(windows));
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "search") return `${[...alive.keys()].join("\n")}\n`;
      if (args[0] === "getwindowname") return alive.get(args[1] ?? "") ?? "";
      if (args[0] === "key") {
        for (const id of closes) alive.delete(id);
        return "";
      }
      return "";
    },
  };
}

describe("unblock: recognising the windows", () => {
  test("reads the ids xdotool answers with, and nothing else", () => {
    assert.deepEqual(parseWindowIds("543\n0x1f\n\n16777252\n  \n"), ["543", "16777252"]);
  });

  test("the browser's own windows are never candidates", () => {
    assert.equal(isBrowserWindow(""), true, "the root window has no name");
    assert.equal(isBrowserWindow("chromium"), true, "an internal helper");
    assert.equal(isBrowserWindow("Brevo - AI Native Product Engineer - Chromium"), true);
    assert.equal(isBrowserWindow("Open File"), false);
    assert.deepEqual(
      strayWindows([
        { id: "1", name: "" },
        { id: "2", name: "chromium" },
        { id: "3", name: "Brevo - AI Native Product Engineer - Chromium" },
      ]),
      [],
    );
  });

  test("a chooser is named after its action, in the locale GTK runs its own strings in", () => {
    assert.equal(isFileChooser("Open File"), true);
    assert.equal(isFileChooser("Save File"), true);
    assert.equal(isFileChooser("Select Folder"), true);
    assert.equal(isFileChooser("Ouvrir un fichier"), true);
    assert.equal(isFileChooser("Brevo - AI Native Product Engineer - Chromium"), false);
    assert.equal(isFileChooser(""), false);
    assert.equal(isFileChooser("Downloads"), false, "a folder name is not an action");
  });
});

describe("unblock: what gets done", () => {
  test("a chooser is focused first, then closed, then the browser takes the focus back", async () => {
    const x = xdotoolWith(
      { [PAGE]: "Brevo - AI Native Product Engineer - Chromium", [CHOOSER]: "Open File" },
      [CHOOSER],
    );
    const outcome = await unblockDialogs(x.run);

    const sequences = x.calls.map((call) => call.join(" "));
    const raiseChooser = sequences.indexOf(`windowraise ${CHOOSER}`);
    const focusChooser = sequences.indexOf(`windowfocus ${CHOOSER}`);
    const escape = sequences.indexOf("key --clearmodifiers Escape");
    const refocusPage = sequences.lastIndexOf(`windowfocus ${PAGE}`);
    assert.ok(focusChooser > raiseChooser, "raised before focused");
    assert.ok(escape > focusChooser, "the key goes to whoever holds the focus: focus comes first");
    assert.ok(refocusPage > escape, "a session with nothing focused types into nothing");
    assert.deepEqual(outcome.actions, [{ action: "closed", window: "Open File" }]);
    assert.equal(outcome.message, 'closed "Open File"');
    assert.equal(outcome.ok, true);
  });

  test("a chooser that ignores the key is reported as raised, not as closed", async () => {
    // The answer is the button's whole UX: claiming a window was closed when it is still there
    // would send the owner back to a screen that is still dead.
    const x = xdotoolWith({ [PAGE]: "Brevo - Chromium", [CHOOSER]: "Open File" });
    const outcome = await unblockDialogs(x.run);
    assert.deepEqual(outcome.actions, [{ action: "raised", window: "Open File" }]);
    assert.equal(outcome.message, 'raised "Open File"');
  });

  test("another dialog is raised, never closed", async () => {
    const x = xdotoolWith({ [PAGE]: "Brevo - Chromium", "16777230": "Some Alert" });
    const outcome = await unblockDialogs(x.run);

    const sequences = x.calls.map((call) => call.join(" "));
    assert.ok(sequences.includes("windowraise 16777230"));
    assert.ok(sequences.includes("windowfocus 16777230"));
    assert.equal(
      sequences.some((call) => call.startsWith("key ")),
      false,
      "only a chooser is closed: the owner may have opened anything else on purpose",
    );
    assert.deepEqual(outcome.actions, [{ action: "raised", window: "Some Alert" }]);
  });

  test("nothing stuck says so, and closes nothing", async () => {
    const x = xdotoolWith({ [PAGE]: "Brevo - Chromium" });
    const outcome = await unblockDialogs(x.run);
    assert.deepEqual(outcome.actions, []);
    assert.equal(outcome.message, "nothing was stuck behind the browser");
    assert.equal(x.calls.some((call) => call[0] === "key"), false);
  });

  test("a window that dies between the search and the query is skipped, not fatal", async () => {
    const alive = new Set(["10", "20"]);
    const run = async (args: string[]): Promise<string> => {
      if (args[0] === "search") return `${[...alive].join("\n")}\n`;
      if (args[0] === "getwindowname" && args[1] === "10") throw new Error("xdotool getwindowname 10 exited with 1");
      if (args[0] === "getwindowname") return "Open File";
      if (args[0] === "key") alive.delete("20");
      return "";
    };
    const outcome = await unblockDialogs(run);
    assert.deepEqual(outcome.actions, [{ action: "closed", window: "Open File" }]);
  });
});

describe("unblock: the runner", () => {
  test("a missing xdotool is its own error, because it has its own fix", async () => {
    const run = xdotoolRunner(":99");
    // The injection point is the binary itself: a PATH with no xdotool on it is the deployment
    // that never installed one.
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await assert.rejects(() => run(["search", "--onlyvisible", "--name", ".*"]), XdotoolMissingError);
    } finally {
      process.env.PATH = path;
    }
  });
});
