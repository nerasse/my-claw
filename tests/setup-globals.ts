// Second preload, loaded AFTER tests/setup.ts (bunfig.toml order). Import statements are
// hoisted above a module's own statements, so importing src/ code from setup.ts itself would
// evaluate config.ts before MY_CLAW_DIR is redirected. Keeping the src imports in a separate,
// later preload guarantees the temp dir is already in place.
import { beforeEach } from "bun:test";
import { resetCircuitBreaker } from "../src/llm/provider.ts";
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
import { resetFallbackNotices } from "../src/llm/fallback-notice.ts";
import { resetEffortClampNotices } from "../src/llm/effort-ladder.ts";
import { resetPairing } from "../src/channels/my-claw-app/pairing.ts";
import { resetWebSessions } from "../src/channels/my-claw-app/web-session.ts";
import { resetDeviceSeenCache } from "../src/channels/my-claw-app/devices.ts";
import { clearOpenRouterCache } from "../src/llm/openrouter-endpoints.ts";
import { closeApprovalStore } from "../src/approvals/store.ts";

// Module-level state in src/ outlives a single test file, so anything a test writes here is
// readable by every file that runs after it. Order-dependent pass/fail is the result, and a
// per-file reset only ever protects the files that remember to call it. Everything reset here
// is either a pure cache (clearing it only forces recomputation) or per-run bookkeeping that
// no test should inherit; nothing semantic is dropped.
beforeEach(() => {
  // Opened by the retry tests on purpose, then rejects unrelated LLM calls for 60s.
  resetCircuitBreaker();
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
  // Endpoint lists are keyed by model id and cached for fifteen minutes, including the empty list
  // a failed lookup leaves: a later file would read another file's mock, or no call at all.
  clearOpenRouterCache();
  // The approvals DB handle is module-level and MY_CLAW_DIR moves per run: a retained handle
  // would keep writing into the previous file's temp dir, or read its rows back.
  closeApprovalStore();
});
