// Second preload, loaded AFTER tests/setup.ts (bunfig.toml order). Import statements are
// hoisted above a module's own statements, so importing src/ code from setup.ts itself would
// evaluate config.ts before MY_CLAW_DIR is redirected. Keeping the src imports in a separate,
// later preload guarantees the temp dir is already in place.
import { beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../src/core/config.ts";
import { resetCircuitBreaker } from "../src/llm/provider.ts";
import { resetLearnedRepairs } from "../src/llm/request-repair.ts";
import { resetBashScopeProbe, setBashLimits } from "../src/tools/bash.ts";
import { resetPromptFileCache } from "../src/agent/prompt/loader.ts";
import { resetSkillVectorCache } from "../src/skills/retrieval.ts";
import { clearRecallCache } from "../src/memory/cache.ts";
import { resetEmbeddingState } from "../src/memory/embedding.ts";
import { runRegistry } from "../src/core/run-registry.ts";
import { resetBinaryCache } from "../src/voice/tts.ts";
import { resetSkillLastGood } from "../src/skills/loader.ts";
import { resetAgentLastGood } from "../src/agents/loader.ts";
import { resetPushState } from "../src/notifications/push.ts";
import { resetAvailabilityWorld } from "../src/llm/world.ts";
import { resetSessionLogResolver } from "../src/sessions/log-access.ts";
import { resetFallbackNotices } from "../src/llm/fallback-notice.ts";
import { resetEffortClampNotices } from "../src/llm/effort-ladder.ts";
import { resetPairing } from "../src/channels/my-claw-app/pairing.ts";
import { resetWebSessions } from "../src/channels/my-claw-app/web-session.ts";
import { resetDeviceSeenCache } from "../src/channels/my-claw-app/devices.ts";
import { resetAppUpdateCache } from "../src/channels/my-claw-app/updates.ts";
import { clearOpenRouterCache } from "../src/llm/openrouter-endpoints.ts";
import { resetOpenRouterAccount } from "../src/llm/openrouter-account.ts";
import { setSharedPricing } from "../src/llm/pricing.ts";
import { closeApprovalStore } from "../src/approvals/store.ts";
import { questionManager } from "../src/questions/manager.ts";
import { resetSpeculations } from "../src/sessions/compaction-speculative.ts";
import { resetEnvFileHotReload } from "../src/core/config.ts";

// Module-level state in src/ outlives a single test file, so anything a test writes here is
// readable by every file that runs after it. Order-dependent pass/fail is the result, and a
// per-file reset only ever protects the files that remember to call it. Everything reset here
// is either a pure cache (clearing it only forces recomputation) or per-run bookkeeping that
// no test should inherit; nothing semantic is dropped.
beforeEach(() => {
  // Published at boot only, so a test that registers one would price every later file's rows.
  setSharedPricing(null);
  // An armed background summary outlives its session file: claimed by the next test that
  // compacts, it commits a boundary naming an entry that conversation never had.
  resetSpeculations();
  // Opened by the retry tests on purpose, then rejects unrelated LLM calls for 60s.
  resetCircuitBreaker();
  // Keyed on baseUrl + model, so one file's refusing endpoint would silence another file's
  // cache-breakpoint assertions without any visible link between them.
  resetLearnedRepairs();
  // Kept browser windows are persisted: a BrowserSession built by one test would find the windows
  // another test kept, and refuse its own run the window it asked for.
  rmSync(join(MY_CLAW_DIR, "browser", "holds.json"), { force: true });
  // Keyed on MY_CLAW_WORKSPACE, which tests move around; mtime equality is also blind to two
  // writes inside one tick.
  resetPromptFileCache();
  // A leftover vector is reused instead of re-embedded, so a fetch mock counting calls sees
  // fewer than it expects, and skillVectorCacheSize() assertions see foreign entries.
  resetSkillVectorCache();
  // Recall keys are short and generic, so a hit can return another file's result without ever
  // touching sqlite.
  clearRecallCache();
  // warmupEmbedding() flips a process-wide latch: once any file warms up, later files silently
  // take the embedding path instead of the keyword fallback.
  resetEmbeddingState();
  // Session ids are reused across files ("s1", "sess-A"), so a leaked controller makes
  // isRunning() true and leaves a mailbox accepting injections.
  runRegistry.clear();
  // Session ids are reused across files ("s1", "sess-A"): a leaked pending question would
  // block the same session's next ask or be answered by a later file's reply.
  questionManager.clear();
  // A stored push endpoint would keep deliver()ing to it and a stored foreground state would
  // skip notifications for a whole file.
  void resetPushState();
  // A binary path resolved by an earlier file would defeat a test that simulates edge-tts or
  // piper being absent.
  resetBinaryCache();
  // Keyed by SKILL.md path, and skill names/paths repeat across files: a retained version would
  // make a deliberately broken skill still resolve.
  resetSkillLastGood();
  // Same hazard on the agent side, and a retained agent carries a tool set as well as a prompt.
  resetAgentLastGood();
  // A world installed by one file would decide which models are runnable in every later file,
  // and "this model cannot run" is the one verdict that changes what a run resolves to.
  resetAvailabilityWorld();
  resetSessionLogResolver();
  // Keyed by message id, and ids repeat across files ("m1", "msg-1"): a leftover would swallow
  // the one notice a later test is asserting.
  resetFallbackNotices();
  // Keyed by model and rungs, both of which repeat across files: a leftover would swallow the one
  // clamp warning a later test asserts on.
  resetEffortClampNotices();
  // Pairing codes and browser sessions are credentials held in memory, and a leaked one would
  // authenticate a later file's request. The pairing clock is restored with them.
  resetPairing();
  resetWebSessions();
  // The lastSeen throttle would silently skip the write a later test asserts on.
  resetDeviceSeenCache();
  // The five-minute forge cache is module state: a later file would read the previous file's
  // release info without ever touching its own mock.
  resetAppUpdateCache();
  // Endpoint lists are keyed by model id and cached for fifteen minutes, including the empty list
  // a failed lookup leaves: a later file would read another file's mock, or no call at all.
  clearOpenRouterCache();
  // The account figures of one file's key would be read as another file's, and the cached failure
  // would keep a later file's mock from ever being called.
  resetOpenRouterAccount();
  // The approvals DB handle is module-level and MY_CLAW_DIR moves per run: a retained handle
  // would keep writing into the previous file's temp dir, or read its rows back.
  closeApprovalStore();
  // The .env hot-reload mtime cache would carry one file's edit over the next one: a later test
  // would see its own .env already "applied" and never re-read it.
  resetEnvFileHotReload();
});

// The bash scope probe and its limits are module state shared by every test file.
resetBashScopeProbe();
setBashLimits(undefined);

// A unit test never reaches the network: what it calls is mocked (tests/helpers/mock-fetch.ts) or
// served on loopback. One that slipped out used to pass or fail on whatever answered, `example.com`
// included (CI, 2026-09-14). Off for the gated suites, which exist to reach it.
const NETWORK_SUITES = ["BROWSER_E2E", "CONTINUE_E2E", "INSTALL_E2E", "VOICE_E2E", "BASH_CGROUP_E2E", "LIVE_E2E", "MODELS_DEV_E2E"];
if (!NETWORK_SUITES.some((name) => process.env[name] === "1")) {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
  const real = globalThis.fetch;
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    if ((url.protocol === "http:" || url.protocol === "https:") && !loopback.has(url.hostname)) {
      throw new Error(`a unit test tried to reach the network (${url.host}): mock it with tests/helpers/mock-fetch.ts`);
    }
    return real(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(guarded, real);
}
