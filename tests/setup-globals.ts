// Second preload, loaded AFTER tests/setup.ts (bunfig.toml order). Import statements are
// hoisted above a module's own statements, so importing src/ code from setup.ts itself would
// evaluate config.ts before MY_CLAW_DIR is redirected. Keeping the src imports in a separate,
// later preload guarantees the temp dir is already in place.
import { beforeEach } from "bun:test";
import { resetCircuitBreaker } from "../src/llm/provider.ts";

// The LLM circuit breaker is module-level state shared by every test file. A test that
// deliberately drives 5 consecutive failures leaves it open for 60s, which then rejects
// unrelated LLM calls in whatever file happens to run next: an order-dependent failure that
// only shows up under some orderings. No test wants an inherited open breaker (the ones that
// exercise it open it themselves), so clear it before each test.
beforeEach(() => {
  resetCircuitBreaker();
});
