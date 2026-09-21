/**
 * Getting a VNC session back when a native dialog has taken it hostage.
 *
 * WHAT GOES WRONG, measured 2026-09-21: Chromium opened a GTK "Open File" chooser for a page's
 * `<input type=file>`. The X display runs without a window manager, so nothing raises a dialog
 * above its parent or hands it the input focus: the chooser sat *behind* the browser window --
 * only its 20px edge showed -- while its modal grab swallowed every click. The owner could not
 * click anything, anywhere, and nothing on screen said why.
 *
 * This is the way out, and only that: it is not a guard. A file chooser opened while nobody is
 * looking for one is closed and the browser is put back in front and focused; any other stray
 * window is raised rather than closed, because the page cannot know whether it was wanted.
 *
 * The rules are the whole design, so they are pure functions: what counts as the browser's own
 * window, what counts as a chooser, what to do with each. Only the xdotool calls are injected.
 */

export interface StrayWindow {
  id: string;
  name: string;
}

export interface UnblockActionTaken {
  action: "closed" | "raised";
  window: string;
}

export interface UnblockOutcome {
  ok: boolean;
  /** One line for the page to show as-is. */
  message: string;
  actions: UnblockActionTaken[];
}

/** Runs one xdotool invocation and hands back its stdout. Injected so what gets touched can be
 *  tested without an X server, and so a missing binary is one error to recognise. */
export type XdotoolRunner = (args: string[]) => Promise<string>;

/** xdotool is not installed. Reported as text by the caller rather than thrown at the page. */
export class XdotoolMissingError extends Error {
  constructor() {
    super("xdotool is not installed on the host (apt-get install xdotool)");
  }
}

/** `xdotool search` answers one decimal window id per line; anything else is not a window. */
export function parseWindowIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
}

/**
 * The browser speaks through every window whose name ends in "Chromium": page windows are titled
 * "<page title> - Chromium", and its internal helpers are named "chromium" outright. A window with
 * no name at all is the root window (xdotool's search matches it on `.*`) or a helper. None of
 * those is ever touched.
 *
 * The chooser is *not* in this set: it is named after its action ("Open File"), which is what
 * makes it findable at all -- WM_CLASS is ("chromium", "Chromium") on both.
 */
export function isBrowserWindow(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || /chromium$/i.test(trimmed);
}

export function strayWindows(windows: StrayWindow[]): StrayWindow[] {
  return windows.filter((w) => !isBrowserWindow(w.name));
}

/**
 * The GTK file chooser, in the locales GTK actually runs its own strings in (the system locale,
 * not Chromium's `--lang`): a page opened in French still gets an English chooser on a host whose
 * LANG says C, which is what this install does.
 */
export function isFileChooser(name: string): boolean {
  const trimmed = name.trim();
  return (
    /^(open|save|select) (a |the )?(file|folder)s?$/i.test(trimmed) ||
    /^(ouvrir|enregistrer)/i.test(trimmed) ||
    /^sélectionner un (fichier|dossier)/i.test(trimmed)
  );
}

function describe(actions: UnblockActionTaken[]): string {
  if (actions.length === 0) return "nothing was stuck behind the browser";
  return actions
    .map((a) => (a.action === "closed" ? `closed "${a.window}"` : `raised "${a.window}"`))
    .join(", ");
}

/**
 * Raise what is hiding, close a chooser nobody asked for, put the browser back in front.
 *
 * Order matters: a dialog is focused before the Escape is sent, because the key goes to whoever
 * holds the focus and the grab is exactly what left the click dead. Refocusing the page window at
 * the end is what makes the session usable again -- closing a dialog with `xdotool key` leaves no
 * window focused at all, so the next click would type into nothing.
 */
export async function unblockDialogs(run: XdotoolRunner): Promise<UnblockOutcome> {
  const ids = parseWindowIds(await run(["search", "--onlyvisible", "--name", ".*"]));
  const windows: StrayWindow[] = [];
  for (const id of ids) {
    // A window can die between the search and the query; `xdotool getwindowname` then fails and
    // that failure is not this command's business.
    const name = await run(["getwindowname", id]).catch(() => "");
    windows.push({ id, name });
  }

  const browser = windows.filter((w) => / - Chromium$/i.test(w.name.trim()));
  const strays = strayWindows(windows);
  const actions: UnblockActionTaken[] = [];
  for (const window of strays) {
    await run(["windowraise", window.id]);
    await run(["windowfocus", window.id]);
    if (isFileChooser(window.name)) {
      await run(["key", "--clearmodifiers", "Escape"]);
      // Whether the key closes it is the window's own business -- GTK's chooser does, and a window
      // that ignores Escape is still one that was hiding. Asking the X server again is what keeps
      // the answer from claiming more than what happened.
      const left = parseWindowIds(await run(["search", "--onlyvisible", "--name", ".*"]));
      actions.push({
        action: left.includes(window.id) ? "raised" : "closed",
        window: window.name.trim(),
      });
    } else {
      actions.push({ action: "raised", window: window.name.trim() });
    }
  }
  for (const window of browser) {
    await run(["windowraise", window.id]);
    await run(["windowfocus", window.id]);
  }

  return { ok: true, message: describe(actions), actions };
}

/** The real runner: xdotool against one display, with a wall so a wedged X server cannot hang the
 *  channel that asked. */
export function xdotoolRunner(display: string, timeoutMs = 5000): XdotoolRunner {
  return async (args) => {
    const cmd = ["xdotool", ...args];
    // Bun throws on a binary that is not on PATH; that is the one failure with an obvious fix,
    // so it gets its own error instead of reaching the page as an exec detail. The IIFE keeps the
    // spawn's inferred stream types (a `let` annotated with the return type widens them to a union
    // `Response` refuses).
    const proc = (() => {
      try {
        return Bun.spawn(cmd, {
          env: { ...process.env, DISPLAY: display },
          stdout: "pipe",
          stderr: "ignore",
        });
      } catch (err) {
        if (/Executable not found/i.test(String(err))) throw new XdotoolMissingError();
        throw err;
      }
    })();
    const timer = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(`xdotool ${args.join(" ")} exited with ${code}`);
    return out;
  };
}
