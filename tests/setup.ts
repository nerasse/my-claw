// Test preload (wired in bunfig.toml). Runs before any test module is imported,
// so it can redirect every filesystem root away from the real ~/.my-claw BEFORE
// config.ts evaluates MY_CLAW_DIR. Without this, running `bun test` writes session
// files into the user's real ~/.my-claw/sessions and can mutate production data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

// Redirect MY_CLAW_DIR (sessions, store, config path) to a throwaway temp dir.
// MY_CLAW_WORKSPACE is deliberately left unset: tool tests rely on the unsandboxed
// fallback, and the workspace default already derives from MY_CLAW_DIR.
const root = mkdtempSync(join(tmpdir(), "my-claw-test-"));
process.env["MY_CLAW_DIR"] = root;

// Drop ambient provider credentials. Model discovery falls back to process.env when no token
// file exists, so a developer's real token would otherwise turn a mocked-fetch test into a live
// call against the provider (and make the suite pass or fail depending on the shell it ran in).
delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
delete process.env["GEOAPIFY_API_KEY"];

// Same hazard on the config side: parseConfig() overwrites the token/password fields with these
// (applySecretOverrides), so a developer running the suite with the real orchestrator's env got a
// config whose telegram token never changed between two fixtures -- and the hot-reload test then
// read an identity swap as a plain behavioral change. Green on CI, red on the machine that has
// the secrets: exactly the failure mode this block exists to prevent.
delete process.env["MY_CLAW_TELEGRAM_TOKEN"];
delete process.env["MY_CLAW_MATRIX_ACCESS_TOKEN"];
delete process.env["MY_CLAW_MATRIX_PASSWORD"];
delete process.env["MY_CLAW_WEB_SEARCH_TOKEN"];

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
