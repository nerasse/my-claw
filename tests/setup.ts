// Test preload (wired in bunfig.toml). Runs before any test module is imported,
// so it can redirect every filesystem root away from the real ~/.my-claw BEFORE
// config.ts evaluates MY_CLAW_DIR. Without this, running `bun test` writes session
// files into the user's real ~/.my-claw/sessions and can mutate production data.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "bun:test";

// Captured before TMPDIR moves: everything below that reasons about the real /tmp (the run root
// itself, and the sweep of older roots) has to keep pointing at it.
const systemTmp = tmpdir();

// Redirect MY_CLAW_DIR (sessions, store, config path) to a throwaway temp dir.
// MY_CLAW_WORKSPACE is deliberately left unset: tool tests rely on the unsandboxed
// fallback, and the workspace default already derives from MY_CLAW_DIR.
const root = mkdtempSync(join(systemTmp, "my-claw-test-"));
process.env["MY_CLAW_DIR"] = root;
// Production keeps config snapshots outside MY_CLAW_DIR; tests keep them inside the run root.
process.env["MY_CLAW_BACKUP_DIR"] = join(root, "backups");

// Move os.tmpdir() itself inside the run root, so scratch directories land somewhere that is
// already deleted with the run. Sweeping /tmp by prefix does not scale: the suite calls mkdtemp
// from 94 places under ~30 prefixes, plus the production code it exercises (video-frames-, img-,
// tts-, prompt-), and a sweep only ever knows the prefixes someone remembered to list -- one of
// them did, and the other 29 had left 13000 directories in a 5.7 GB tmpfs. os.tmpdir() re-reads
// the environment on every call, so this covers every site without touching one of them.
process.env["TMPDIR"] = join(root, "tmp");
mkdirSync(process.env["TMPDIR"], { recursive: true });

// The root is thrown away with the run. Nothing used to remove it: every `bun test` left a few
// megabytes in /tmp, and 238 of them had taken 900 MB of a 5.7 GB tmpfs -- on the machine where a
// full /tmp is already known to break the browser sidecar.
//
// `afterAll` from the preload is global, and it is what actually fires: an `exit` listener alone
// left the directory behind (measured), because the runner does not always reach a clean exit.
// The listener stays as the second net for a run that ends outside the test lifecycle.
afterAll(() => rmSync(root, { recursive: true, force: true }));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// A run killed with Ctrl-C never reaches that hook, so older roots are swept on the way in. An
// hour is well past any suite and far short of a concurrent run's lifetime, which is what keeps
// this from deleting the directory of a test process running beside this one.
const STALE_MS = 60 * 60 * 1000;
try {
  for (const name of readdirSync(systemTmp)) {
    if (!name.startsWith("my-claw-test-") || join(systemTmp, name) === root) continue;
    const path = join(systemTmp, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Someone else's directory, or gone already: not this run's problem.
    }
  }
} catch {
  // No /tmp to read is not a reason to fail a test run.
}

// Drop ambient provider credentials. Model discovery falls back to process.env when no token
// file exists, so a developer's real token would otherwise turn a mocked-fetch test into a live
// call against the provider (and make the suite pass or fail depending on the shell it ran in).
delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];

// The search tool acquires a pinned ripgrep on first use when none is installed; a unit test
// must never reach the network for it (a machine without rg exercises the grep fallback).
process.env["MY_CLAW_RG_NO_DOWNLOAD"] = "1";
delete process.env["GEOAPIFY_API_KEY"];
delete process.env["GEMINI_API_KEY"];

// Same hazard on the config side: parseConfig() overwrites the token/password fields with these
// (applySecretOverrides), so a developer running the suite with the real orchestrator's env got a
// config whose telegram token never changed between two fixtures -- and the hot-reload test then
// read an identity swap as a plain behavioral change. Green on CI, red on the machine that has
// the secrets: exactly the failure mode this block exists to prevent.
delete process.env["MY_CLAW_TELEGRAM_TOKEN"];
delete process.env["MY_CLAW_MATRIX_ACCESS_TOKEN"];
delete process.env["MY_CLAW_MATRIX_PASSWORD"];
delete process.env["MY_CLAW_WEB_SEARCH_TOKEN"];

// The forge credential the web-bundle installer reads. Same hazard, one layer up: with it in the
// shell, `authHeaders` returns a real header and "no token configured means no header" fails --
// but only when the randomized order puts it before the test that sets and then deletes one.
// Green on CI, red on the maintainer's machine, and only on some seeds.
delete process.env["FORGEJO_TOKEN"];
delete process.env["FORGEJO_URL"];
delete process.env["MY_CLAW_RELEASE_URL"];
delete process.env["MY_CLAW_RELEASE_KEY"];

// Wipe persisted sessions between every test. Files share one MY_CLAW_DIR and reuse ids
// ("u1", "session-1", ...), so a session left on disk by one test could be read cold by
// the next and create an order-dependent pass/fail. Clearing here makes each test start
// from an empty session store regardless of run order.
afterEach(() => {
  rmSync(join(root, "sessions"), { recursive: true, force: true });
  // Same hazard, one directory over: a test that stores a Claude token (a `/claude set-token`
  // command test) leaves it in the shared MY_CLAW_DIR, and `loadClaudeToken()` then returns it
  // for the rest of the run. That silently turns anthropic model discovery into a fetch in every
  // later file -- which is how `catalog.test.ts` started failing under some `--randomize` seeds
  // and passing under others. Cleared centrally: a per-file afterEach only protects the files
  // that remember to write one.
  rmSync(join(root, "claude"), { recursive: true, force: true });
});
