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

// Wipe persisted sessions between every test. Files share one MY_CLAW_DIR and reuse ids
// ("u1", "session-1", ...), so a session left on disk by one test could be read cold by
// the next and create an order-dependent pass/fail. Clearing here makes each test start
// from an empty session store regardless of run order.
afterEach(() => {
  rmSync(join(root, "sessions"), { recursive: true, force: true });
});
