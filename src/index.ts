import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { attributeCallsToProviders, closeDb, usageHorizon } from "./analytics/usage-db.ts";
import { pruneOldSessions, cronSessionToThread, subagentSessionToThread, subagentThreadToSession, loadSession, loadLegacySession } from "./sessions/store.ts";
import { sessionLogOf } from "./sessions/log-access.ts";
import { promptOf } from "./sessions/projection.ts";
import { gcShadows } from "./snapshots/store.ts";
import { migrateSessions } from "./sessions/migrate.ts";
import { migrateRunMarkers } from "./sessions/migrate-run-markers.ts";
import { migrateMediaIds } from "./sessions/migrate-media-ids.ts";
import type { CommandEntry } from "./sessions/log.ts";
import { setSessionLogResolver } from "./sessions/log-access.ts";
import { recordSpawnLifecycle } from "./sessions/spawn-state.ts";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  agentConfigOf,
  resolveAgentLlm,
  resolveAgentMcp,
  resolveAgentSkills,
  isMyClawAppChannelEnabled,
  findUnknownScopeEntries,
  findUnknownAgentWorkspaces,
  findUnknownPromptWorkspaces,
  findShadowingWorkspaceKeys,
  findUnknownAgents,
  CONFIG_PATH,
  MY_CLAW_DIR,
  parseConfig,
  providerRetryDelays,
  DEFAULT_CONTEXT_CAP,
  resolveWorkspaceDir,
  resolveWorkspaceKey,
  tagNameOf,
  type AgentToolType,
  type EffortLevel,
  type LlmProviderConfig,
  type MyClawConfig,
  refreshEnvFile,
} from "./core/config.ts";
import {
  loadConfigOrFallback,
  snapshotProtected,
  confirmProtected,
  snapshot as snapshotConfigFile,
  latestConfirmed,
  recordConfirmedSha,
  clearStrikes,
  clearQuarantine,
  setQuarantine,
  contentSha,
  HEALTH_GATE_MS,
} from "./core/config-store.ts";
import { isHealthy, decideAfterHealthGate, MAX_STRIKES } from "./core/config-health.ts";
import { writeFileAtomically } from "./utils/atomic-write.ts";
import { briefError } from "./utils/errors.ts";
import { MyClawAppAdapter } from "./channels/my-claw-app/adapter.ts";
import type { MyClawAppStreamer } from "./channels/my-claw-app/stream.ts";
import { defaultOwner } from "./channels/my-claw-app/devices.ts";
import type { MyClawAppSubAgentHandoffOutcome, MyClawAppAgentsConfigResult, MyClawAppAgentFileResult, MyClawAppJobEntry, MyClawAppJobsRunEntry, MyClawAppJobScope, MyClawAppMcpEntry, MyClawAppNestedInstruction, MyClawAppSkillEntry, MyClawAppProviderEnvResult, MyClawAppTagsResult, MyClawAppToolEntry, MyClawAppWorkspaceEntry } from "./channels/my-claw-app/types.ts";
import { DEFAULT_THREAD } from "./channels/my-claw-app/types.ts";
import type { CronDeliver } from "./cron/types.ts";
import { applyRunLimits, deliverOfSave, deliveryThreadOf, runLimitsOfJob } from "./channels/my-claw-app/job-fields.ts";
import { MyClawAppSessionStoreImpl, sanitizeThreadId } from "./channels/my-claw-app/sessions.ts";
import { SessionFileStore } from "./channels/my-claw-app/files.ts";
import { GeoapifyReverseGeocoder } from "./channels/my-claw-app/location.ts";
import { resolveSkillFile, transferSkill } from "./channels/my-claw-app/skills.ts";
import {
  MAX_INSTRUCTION_BYTES,
  listInstructions,
  readInstruction,
  readNestedByPath,
  readNestedInstruction,
  resolveNestedTarget,
  scanNestedInstructions,
  writeInstruction,
  writeNestedInstruction,
  type InstructionRoots,
} from "./channels/my-claw-app/instructions.ts";
import { sessionInstructionsReport } from "./channels/session-instructions.ts";
import { PROMPT_FILES } from "./agent/prompt/files.ts";
import { ModelPicker } from "./channels/model-picker.ts";
import { contextChoiceFor } from "./channels/context-menu.ts";
import { ModelCatalog, mergeModels, applyProviderGroups, applyModelWindows, applyModelMetadata } from "./llm/catalog.ts";
import { openRouterModels } from "./llm/openrouter-endpoints.ts";
import { ModelPricing, setSharedPricing } from "./llm/pricing.ts";
import { statsReport } from "./channels/stats-command.ts";
import { startConfigWatcher, type ConfigWatcherHandle } from "./core/config-watcher.ts";
import { managesUnits, scheduleReconcile } from "./services/on-demand.ts";
import { createAccounts } from "./llm/subscription-accounts.ts";
import { choicesOf, installKind, probeService, serviceStates } from "./services/catalog.ts";
import { diskBytes, transformersRuntime, whisperRuntime } from "./services/local-engines.ts";
import { createMyClawAppCommandHandler } from "./channels/my-claw-app/commands.ts";
import { askUndoMode } from "./channels/branch-commands.ts";
import { effectiveEffort, EFFORT_LEVELS, leafModelId } from "./llm/resolver.ts";
import { SessionManager } from "./sessions/manager.ts";
import { readMeta } from "./sessions/meta.ts";
import { MessageRouter, type RouteResult } from "./core/router.ts";
import { FoldedRunError, RerouteSignal, runRegistry } from "./core/run-registry.ts";
import type { StopOutcome } from "./core/stop.ts";
import { isAbort } from "./core/aborted.ts";
import { runErrorBubble, setRunBubbles, withRunContext } from "./utils/run-context.ts";
import type { UnifiedMessage } from "./channels/types.ts";
import { BackendDispatcher } from "./agent/dispatcher.ts";
import { ToolRegistry, mcpServerOf, baselineToolNames } from "./tools/registry.ts";
import { bashTool, setBashEnvPassthrough, setBashLimits } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { fetchTool } from "./tools/fetch.ts";
import { searchTool } from "./tools/search.ts";
import { applyPatchTool } from "./tools/apply-patch.ts";
import { lsTool } from "./tools/ls.ts";
import { createMemoryTool } from "./tools/memory.ts";
import { createConversationSearchTool } from "./tools/conversation-search.ts";
import { createSpawnTool, spawnModelIds } from "./tools/spawn.ts";
import { createSendTool } from "./tools/send.ts";
import { createAgentsTool } from "./tools/agents.ts";
import { createSkillsTool } from "./tools/skills.ts";
import { createAudioTool } from "./tools/audio.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { BrowserSession, createDelegateBrowserTool, registerBrowserTools } from "./tools/browser/index.ts";
import { runReasoningSink } from "./channels/my-claw-app/run-sink.ts";
import { subAgentStreamFor } from "./channels/my-claw-app/subagent-stream.ts";
import { createCronTool } from "./tools/cron.ts";
import { createNotifyTool } from "./tools/notify.ts";
import { createQuestionTool } from "./tools/question.ts";
import { questionManager } from "./questions/manager.ts";
import { createWorkspacesTool } from "./tools/workspaces.ts";
import { CronScheduler, DEFAULT_ALERT_AFTER_MS } from "./cron/scheduler.ts";
import { parseDurationMs } from "./utils/duration.ts";
import { createJob, loadJobs, mutateJobs, removeJob, updateJob } from "./cron/store.ts";
import { apnsStore, registeredAPNsDevices, relayURL, setAPNsDeviceAuthorization } from "./notifications/apns.ts";
import { endpointStore, foregroundStore, loadOrCreateVapid, publishNotification, isForegroundOn, cleanNotificationText } from "./notifications/push.ts";
import { targetOfSession } from "./notifications/target.ts";
import { registerRunNotifications } from "./notifications/run-notifications.ts";
import { SubAgentRunner, type SubAgentStream } from "./subagents/runner.ts";
import { SubAgentRegistry } from "./subagents/registry.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { loadAllSkills } from "./skills/loader.ts";
import { syncBuiltIn } from "./skills/sync.ts";
import { startSkillsWatcher } from "./skills/watcher.ts";
import { reloadSkills, editableTierDirs, type SkillDirs } from "./skills/reload.ts";
import { AgentRegistry } from "./agents/registry.ts";
import { loadAllAgents } from "./agents/loader.ts";
import type { FileAgent } from "./agents/types.ts";
import { PROMPT_LAYERS, type PromptLayerName } from "./agent/prompt/files.ts";
import { syncBuiltInAgents } from "./agents/sync.ts";
import { startAgentsWatcher } from "./agents/watcher.ts";
import { reloadAgents, editableAgentTierDirs, type AgentDirs } from "./agents/reload.ts";
import { McpManager } from "./mcp/manager.ts";
import { PluginLoader } from "./tools/plugins.ts";
import { backfillConversationArchive } from "./conversations/store.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "./voice/index.ts";
import { extractMediaRefs, cleanupGeneratedTempFiles, cleanupAttachments, mediaTypeForPath } from "./utils/media.ts";
import { llmCompleteStream } from "./llm/transport.ts";
import { occupiedContextTokens, standingContextCap } from "./llm/context-window.ts";
import { codexLoginDeviceCode, loadCodexCredential, codexLogout, codexIsLoggedIn } from "./llm/codex-auth.ts";
import { runClaudeSetupToken, setClaudeToken, clearClaudeToken, claudeTokenStatus } from "./llm/claude-auth.ts";
import {
  accountKindOf,
  adoptLegacyAccounts,
  freeProviderKey,
  freeProviderName,
  PLAN_PROVIDER,
  watchAccounts,
  removeAccount,
  subscriptionProviders,
  type AccountKind,
} from "./llm/accounts-store.ts";
import { resolveLlmConfig, resolveAgentLlmConfig, findModel, isOpenRouterBaseUrl, providerBaseUrl } from "./llm/resolver.ts";
import type { ChatMessage } from "./llm/provider.ts";
import { tagRouteOf } from "./core/config.ts";
import { resolveUtilityLlmConfig } from "./llm/utility-model.ts";
import { referenceWithRoute, routesFor, sortRoutes } from "./channels/route-menu.ts";
import { availabilityOf, describe as describeAvailability, overrideForPick, resetPinsOnPick, runnableModels, tryResolveRunModel } from "./llm/run-model.ts";
import { chatModel } from "./llm/chat-model.ts";
import { fallbackNoticeText } from "./llm/fallback-notice.ts";
import { setAvailabilityWorld, availabilityWorld } from "./llm/world.ts";
import { buildDiagnostics, readLogEntries, formatLogEntries, collectSecrets } from "./core/diagnostics.ts";
import {
  warmupEmbedding,
  backfillEmbeddings,
  importHandEdits,
  migrateLegacyFiles,
  exportToMarkdown,
  purgeOldMemory,
  consolidateMemory,
  closeMemoryDb,
  type LlmCaller,
} from "./memory/index.ts";
import {
  setVoiceSttMode,
  setService,
  oneEditAtATime,
  engineInUse,
  setUiPrefs,
  setDefaultModel,
  clearAgentModel,
  setAgentModel,
  setVisionFallback,
  setProviderRetry,
  setAgentScope,
  setAgentWorkspace,
  setAgentMaxIterations,
  setAgentContextCap,
  setDefaultContextCap,
  setToolDisabled,
  setToolConfirm,
  addMcpServer,
  removeMcpServer,
  setMcpEnabled,
  addWorkspace,
  removeWorkspace,
  renameWorkspace,
  setWorkspacePath,
  setWorkspacePromptPolicy,
  setTag,
  deleteTag,
  upsertProvider,
  removeProvider,
  repointEnvKey,
  upsertModel,
  removeModel,
} from "./core/config-edit.ts";
import { previewProviderRename, renameProviderEverywhere } from "./core/provider-rename.ts";
import type { ConfigEditResult } from "./core/config-edit.ts";
import { envKeys, setEnvValue, renameEnvKey, removeEnvKey } from "./core/env-edit.ts";
import { runReleaseKeyCli } from "./core/release-key.ts";
import { claudeClaim } from "./llm/anthropic-release.ts";
import { quotaFor, quotaSourceOf, redeemQuota } from "./llm/quota/index.ts";
import {
  readAgentFile,
  writeAgentFile,
  createAgentFile,
  deleteAgentFile,
  serializeAgentFile,
  fieldsOfMeta,
} from "./agents/edit.ts";
import { parseAgentFile } from "./agents/loader.ts";
import { log, pruneOldLogs, setLogLevelSource } from "./utils/logger.ts";
import { hooks } from "./hooks/index.ts";

const DAY_MS = 86_400_000;
/** Raw config.json editor ceiling, generous for a hand-edited file with a 28-provider catalog. */
const MAX_CONFIG_BYTES = 512 * 1024;

// A mid-run injected message whose run ended without addressing it (forced close) is rerouted
// here as a fresh, non-injectable run so it is never lost.
async function routeWithReroute(
  router: MessageRouter,
  msg: UnifiedMessage,
  opts: Parameters<MessageRouter["route"]>[1],
): Promise<RouteResult | undefined> {
  try {
    return await router.route(msg, opts);
  } catch (err) {
    if (err instanceof RerouteSignal) return await router.route(msg, { ...opts, noInject: true });
    throw err;
  }
}

/**
 * At most this many conversations per hand-back. Each `ask` target opens a real run somewhere else,
 * so one tap in a menu must not be able to start an unbounded fan-out.
 */
const MAX_HANDOFF_TARGETS = 3;

/** The owner and thread behind an app conversation id, or null for anything that is not one. */
function splitAppSession(sessionId: string): { owner: string; threadId: string } | null {
  const prefix = "my-claw-app/thread/";
  if (!sessionId.startsWith(prefix)) return null;
  const rest = sessionId.slice(prefix.length);
  const cut = rest.indexOf("/");
  if (cut <= 0) return null;
  const owner = rest.slice(0, cut);
  const threadId = rest.slice(cut + 1);
  return owner && threadId ? { owner, threadId } : null;
}

function appThreadOfSession(sessionId: string): string | undefined {
  return splitAppSession(sessionId)?.threadId;
}

function ownerOfAppSession(sessionId: string): string | undefined {
  return splitAppSession(sessionId)?.owner;
}

/** What the target conversation reads. Attributed, so the orchestrator knows it is not the owner. */
function renderHandoff(label: string, body: string, note?: string): string {
  const head = `Result handed back from sub-agent ${label}:`;
  return note ? `${head}\n\n${note}\n\n---\n\n${body}` : `${head}\n\n${body}`;
}

async function main() {
  const { config, fallback } = await loadConfigOrFallback();
  if (fallback) {
    log("error", "config.json unusable, started from a snapshot", { ref: fallback.ref, error: fallback.error });
    hooks.emit("config:fallback", fallback);
  }
  // Live read: a hot-reloaded logging.level applies to the next line written, no restart.
  setLogLevelSource(() => config.logging?.level);
  void pruneOldLogs();
  void pruneOldSessions();
  const workspacePath = config.workspace!;
  process.env["MY_CLAW_WORKSPACE"] = workspacePath;
  await snapshotProtected(workspacePath, { origin: "boot" });

  // A/B confirmation. Channels are tracked live rather than from a one-shot list, because a
  // recreate that fails mid-life has to count as "down" too.
  const liveChannels = new Set<string>();
  hooks.on("channel:started", ({ platform }) => void liveChannels.add(platform));
  hooks.on("channel:stopped", ({ platform }) => void liveChannels.delete(platform));
  hooks.on("channel:error", ({ platform }) => void liveChannels.delete(platform));

  // Out-of-band statements that belong to a chat but not to the agent's answer -- today, a run
  // that had to fall back off a configured model. Registered per channel where the adapter is
  // built, so one subscriber serves all three and a disabled channel simply has no sender.
  const noticeSenders = new Map<string, (chatId: string, text: string, threadId?: string) => Promise<void>>();
  hooks.on("model:fallback", (event) => {
    const send = noticeSenders.get(event.platform);
    if (!send) return;
    // Never let a notice failure touch the run it is about.
    void send(event.chatId, fallbackNoticeText(event), event.threadId).catch((err) =>
      void log("warn", "model fallback notice not delivered", { platform: event.platform, error: String(err) }),
    );
  });

  const confirmHealthyConfig = async (): Promise<void> => {
    const healthy = isHealthy({
      expectsChannel: isMyClawAppChannelEnabled(config),
      liveChannels: liveChannels.size,
    });
    const raw = await readFile(CONFIG_PATH, "utf-8").catch(() => "");
    const good = await latestConfirmed(CONFIG_PATH);
    const outcome = await decideAfterHealthGate({
      healthy,
      currentSha: contentSha(raw),
      confirmedSha: good ? contentSha(good.content) : null,
      underServiceManager: Boolean(process.env["INVOCATION_ID"]),
    });

    if (outcome.action === "confirm") {
      const n = await confirmProtected(workspacePath).catch(() => 0);
      await recordConfirmedSha(contentSha(raw)).catch(() => {});
      await clearStrikes().catch(() => {});
      await clearQuarantine().catch(() => {});
      log("info", "config snapshots confirmed", { artifacts: n });
      return;
    }
    if (outcome.action === "warn") {
      log("warn", "config never became healthy, but leaving it in place", { reason: outcome.reason });
      return;
    }
    if (outcome.action === "retry") {
      log("error", "config never became healthy, restarting to retry", { reason: outcome.reason });
      await restartForHealth(`retry ${outcome.strikes}/${MAX_STRIKES}`);
      return;
    }
    log("error", "config quarantined, restarting on the last confirmed version", { reason: outcome.reason });
    await setQuarantine(contentSha(raw), outcome.reason).catch(() => {});
    await restartForHealth("quarantine");
  };
  // Late-bound: the command handlers are wired before the watcher exists, and `/config rollback`
  // needs the watcher's own apply path rather than an fs.watch event that may never come.
  let restartForHealth: (reason: string) => Promise<void> = async () => {};
  let configWatcher: ConfigWatcherHandle | undefined;
  const reloadConfigNow = async (): Promise<{ changed: string[]; rebootRequired: string[] }> =>
    (await configWatcher?.reloadNow()) ?? { changed: [], rebootRequired: [] };
  const memoryPurgeTimer = initMemory(config);
  // The calls recorded before each one named its provider, placed once by the address they reached.
  try {
    const providers = config.llm.providers ?? {};
    const attributed = attributeCallsToProviders(Object.fromEntries(Object.entries(providers).map(([key, p]) => [key, providerBaseUrl(p)])));
    if (attributed > 0) void log("info", "past calls attributed to their provider", { attributed });
  } catch (err) {
    void log("warn", "past calls could not be attributed to their provider", { error: String(err) });
  }
  // A capture writes blobs and trees and no commit, so nothing in a shadow is reachable from a
  // ref and nothing ever pruned them: 247 MB of objects for snapshots long expired. Daily, and
  // never on the path of a run.
  const shadowGcTimer = setInterval(() => void gcShadows(), 24 * 60 * 60 * 1000);
  shadowGcTimer.unref?.();
  // Left empty on purpose: applyModelCatalog() below is the single place that projects the merged
  // model list into the picker, and it runs synchronously before anything can read the menu.
  // The agent list is a closure, not a snapshot: the registry is built further down and its
  // contents change with the files, while a menu is only ever parsed long after boot.
  const modelPicker = new ModelPicker([], undefined, () => agentRegistry.names());

  // Reads the live config so a hot-reloaded provider is priced without a restart, and the live
  // model list so an alias resolves to whatever version discovery last reported. Declared ahead of
  // the catalog because the same table also fills in the context windows discovery left blank.
  const pricing = new ModelPricing(() => config.llm.providers ?? {}, () => config.llm.models ?? []);
  // Every recorded call keeps the cost it was charged, so the analytics do not re-price the past
  // against a table that has been refetched since. `recordApiCall` runs deep in the agent loop, in
  // files that hold no table of their own, so the one instance is published here.
  setSharedPricing(pricing);

  // Nothing is ever swept: every call stays in `api_calls` for good, so the ranking and the daily
  // graph reach back to the first recorded row. The monthly rollup still counts the months an
  // earlier retention policy folded away, with no session and no day in them (docs/stats-page.md).
  log("info", "analytics kept in full", { since: usageHorizon().detailSince });

  // Dynamic model catalog: discovered models (Claude SDK + OpenAI /v1/models) merge into the
  // curated config.models. Everything (resolver, dispatcher, picker) reads config.llm.models,
  // so the merge writes there; baseModels is the curated disk set re-merged on each refresh.
  let baseModels = [...(config.llm.models ?? [])];
  for (const entry of baseModels) {
    const leftover = (entry as unknown as Record<string, unknown>)["effort"];
    if (leftover !== undefined) {
      log("warn", "llm.models[].effort is gone: effort now belongs to the tag, job, agent or global scope", {
        model: entry.id,
        effort: leftover,
      });
    }
  }
  const modelCatalog = new ModelCatalog(() => config.llm);
  const applyModelCatalog = () => {
    const merged = mergeModels(baseModels, modelCatalog.discovered());
    // Provider-first: models with no explicit group nest under their provider's group label.
    const grouped = applyProviderGroups(merged, config.llm.providers ?? {});
    const windowed = applyModelWindows(grouped, config.llm.providers ?? {}, pricing);
    // A provider that lists ids and nothing else gets its capabilities from the same download the
    // windows come from, so the effort menu describes the model rather than our fallback list.
    config.llm.models = applyModelMetadata(windowed, config.llm.providers ?? {}, pricing);
    config.llm.tags = config.tags;
    // The picker offers what can run; `config.llm.models` keeps everything, because the resolver
    // needs the unavailable entries to say *why* a pinned model cannot run. Filtering the config
    // instead would turn "removed by the provider" into "unknown id", which is a different fault
    // with a different fix.
    modelPicker.syncFromConfig(
      { ...config.llm, models: runnableModels(config.llm, availabilityWorld()) },
      config.tags,
    );
  };
  // Whether a model can run at all: what each provider last listed, plus the two subscription
  // auth states (docs/model-resolution.md). Installed *before* the first projection below, which
  // reads it: a picker built while the world was still the permissive default would keep offering
  // unavailable models until something else happened to re-project it -- and with discovery off,
  // nothing would.
  let signedIn = new Set<string>();
  const sampleSubscriptionAuth = async (): Promise<boolean> => {
    const next = new Set<string>();
    for (const account of subscriptionProviders(config.llm.providers)) {
      const present =
        account.kind === "codex"
          ? await codexIsLoggedIn(account.key).catch(() => false)
          : (await claudeTokenStatus(account.key).catch(() => ({ present: false }))).present;
      if (present) next.add(account.key);
    }
    if (next.size === signedIn.size && [...next].every((key) => signedIn.has(key))) return false;
    signedIn = next;
    // The sample decides which models the picker may offer, and it lands asynchronously -- after
    // the projection that a refresh triggers. Re-project, or a token that expired between two
    // refreshes leaves its models on the menu for six hours.
    applyModelCatalog();
    return true;
  };
  setAvailabilityWorld(() => ({
    answered: (provider) => modelCatalog.answered(provider),
    listedBy: (provider) => modelCatalog.listedBy(provider),
    hasEnv: (name) => Boolean(process.env[name]),
    // From the sample: every writer of a sign-in goes through onAuthChanged, which re-samples.
    signedIn: (provider) => signedIn.has(provider),
  }));
  // `/codex` and `/claude` act on the first account of their kind (docs/subscription-accounts.md);
  // with none declared yet, a login declares one (added to config, persisted for restarts), or the
  // token would land on no provider and its models would never reach /model.
  const firstAccountOf = (providers: Record<string, LlmProviderConfig> | undefined, kind: AccountKind): string | undefined =>
    subscriptionProviders(providers).find((a) => a.kind === kind)?.key;
  /** Declares one account, in the live config and on disk. Never the in-memory config to disk. */
  const declareAccount = async (key: string, kind: AccountKind, group: string): Promise<void> => {
    const spec = { type: PLAN_PROVIDER[kind].type, discover: true, group };
    const live = (config.llm.providers ??= {});
    // Live first, so the refresh right after can see the provider before the watcher lands.
    live[key] = spec;
    const written = await upsertProvider(key, spec);
    if (!written.ok) throw new Error(written.error);
    await reloadConfigNow().catch((err) => {
      void log("warn", "config reload after an account was declared failed", { key, error: String(err) });
    });
  };
  const accountFor = async (kind: AccountKind): Promise<string> => {
    const existing = firstAccountOf(config.llm.providers, kind);
    if (existing) return existing;
    const key = freeProviderKey(config.llm.providers ?? {}, PLAN_PROVIDER[kind].key);
    await declareAccount(key, kind, freeProviderName(config.llm.providers ?? {}, PLAN_PROVIDER[kind].group));
    return key;
  };
  // One adoption at a time: declaring a plan for the Claude token of .env reloads the config, and a
  // reload adopts too.
  let adopting: Promise<void> = Promise.resolve();
  const adoptSignIns = (): Promise<void> => {
    const run = (): Promise<void> => adoptLegacyAccounts(config.llm.providers, accountFor);
    adopting = adopting.then(run).catch((err) => {
      void log("warn", "legacy sign-ins could not be adopted", { error: String(err) });
    });
    return adopting;
  };
  // The sign-ins of before (one per server, and the Claude token of .env) go to their providers
  // before anything reads them; a token pasted into .env later, or a plan declared later, adopts then.
  await adoptSignIns();
  await sampleSubscriptionAuth();
  hooks.on("env:refreshed", () => void adoptSignIns().then(sampleSubscriptionAuth));
  hooks.on("models:discovered", () => void sampleSubscriptionAuth());
  // A config.json edit can add a provider or a key env name, both of which change what is runnable.
  // A plan declared now adopts a sign-in left for it (the Claude token of .env on a fresh install).
  // The projection runs after: a hand-edited `disabled` flips availability and must reach the
  // picker without waiting for the next sign-in change or discovery pass (docs/providers-admin.md).
  hooks.on("config:reloaded", () => void adoptSignIns().then(sampleSubscriptionAuth).then(() => applyModelCatalog()));

  modelCatalog.onUpdate(applyModelCatalog);
  // Load the OpenRouter catalogue before the first projection. It fails closed to an empty cache,
  // so a cold cache or network failure remains non-blocking and cannot replace explicit config.
  await openRouterModels();
  applyModelCatalog();
  // models.dev discovery may complete later than the OpenRouter request. Its update callback
  // re-projects the same config, preserving the explicit > endpoint > OpenRouter > models.dev order.
  if (modelCatalog.enabled()) void modelCatalog.refresh().then(applyModelCatalog);
  const modelCatalogTimer = setInterval(() => void modelCatalog.refresh().then(applyModelCatalog), 6 * 60 * 60 * 1000);
  modelCatalogTimer.unref?.();

  // A first-ever metadata fetch has to replay the projection, otherwise models retain fallbacks
  // until restart. Both refreshers are cache-aware and failures leave the current projection intact.
  const refreshModelMetadata = () => Promise.all([pricing.refreshIfStale(), openRouterModels()]).then(applyModelCatalog);
  void refreshModelMetadata();
  const pricingTimer = setInterval(() => void refreshModelMetadata(), 6 * 60 * 60 * 1000);
  pricingTimer.unref?.();


  const pushModelListToOwners = (): void => {
    const appConfig = config.channels["my-claw-app"];
    if (!myClawAppRef || !appConfig) return;
    const owners = new Set<string>();
    for (const [deviceId, entry] of Object.entries(appConfig.devices ?? {})) owners.add(entry.owner ?? deviceId);
    for (const owner of owners) myClawAppRef.pushModelList(owner);
  };
  const onAuthChanged = async (_provider: string): Promise<void> => {
    // Before the refresh: a login that adds models must not have them judged unrunnable by a
    // stale auth sample, and a logout must stop offering them immediately.
    await sampleSubscriptionAuth();
    await modelCatalog.refresh();
    // The refresh re-projects the server-side picker, but nothing told the app: it keeps the
    // catalogue it already holds (no ChatGPT model, no effort levels) until it asks again, which
    // is what a manual "refresh" button papered over. Push the fresh list to every owner.
    pushModelListToOwners();
  };
  // A sign-in written by another process (`myclaw codex login` while the server runs) reaches the
  // picker without a restart. A token refresh rewrites the file too and leaves the sample as it was.
  watchAccounts(() => {
    void sampleSubscriptionAuth()
      .then((changed) => (changed ? onAuthChanged("") : undefined))
      .catch((err) => void log("warn", "a sign-in change could not be applied", { error: String(err) }));
  });

  const voiceManager = new VoiceManager(config);
  // Local Whisper runs only while the config sends speech to it -- docs/on-demand-services.md.
  // Read at call time, from the live config: the voice mode, a Groq key appearing in .env.
  const reconcileOnDemand = (): void => {
    if (managesUnits()) void scheduleReconcile(config);
  };
  reconcileOnDemand();
  // A download that just ended (faster-whisper installed) is what the unit was waiting for.
  whisperRuntime.onChange(() => {
    if (whisperRuntime.status().state === "ready") reconcileOnDemand();
  });
  // Likewise for transformers.js: local embeddings warm up once it is there.
  transformersRuntime.onChange(() => {
    if (transformersRuntime.status().state === "ready") void reloadMemoryEmbedding(config.memory);
  });
  hooks.on("config:reloaded", reconcileOnDemand);
  hooks.on("env:refreshed", reconcileOnDemand);
  const sttPipeline = new SttPipeline(voiceManager);
  const ttsPipeline = new TtsPipeline(voiceManager);

  const toolRegistry = new ToolRegistry();
  // External MCP servers (config.mcp) feed both backends through one manager: the registry's
  // dynamic provider surfaces their tools to getForAgent, which the home loop and the SDK
  // in-process tool server both build from. Connected at boot, re-synced on hot-reload.
  const mcpManager = new McpManager();
  // Optional owner-authored tool plugins (tools.d/), created after registration below.
  let pluginLoader: PluginLoader | undefined;
  toolRegistry.setDynamicProvider(() => [...mcpManager.getTools(), ...(pluginLoader?.getTools() ?? [])]);
  // Not awaited: the provider above is read per call, so a server that connects a second late is
  // simply in the next tool list. Awaiting it put every external server on the critical path of
  // the boot -- an unreachable host meant no channels at all until it gave up.
  void mcpManager.sync(config.mcp).catch((err) => {
    void log("error", "mcp sync failed at boot", { error: String(err) });
  });
  registerCoreTools(toolRegistry, config);
  registerVoiceTools(toolRegistry, sttPipeline, ttsPipeline, voiceManager);
  // Registered via a reusable closure so the config hot-reload watcher can (re)register
  // web_search when webSearch.baseUrl is added or changed at runtime.
  const registerWebSearch = (): void => {
    if (config.webSearch?.baseUrl) toolRegistry.register(createWebSearchTool(config.webSearch));
  };
  registerWebSearch();

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoSkillsDir = join(repoRoot, "src", "skills");
  const builtinDir = join(MY_CLAW_DIR, "skills", ".builtin");
  const customDir = join(MY_CLAW_DIR, "skills");
  const workspaceSkillsDir = join(workspacePath, "skills");

  /** Every workspace's skills layer: the default (unscoped) plus each named one. Live-derived
   *  from the config object, so a hot-reloaded workspaces map is picked up by re-scans. */
  const skillWorkspaceLayers = (): SkillDirs["workspaces"] =>
    Object.entries(config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "skills") }));
  const skillsDirs = (): SkillDirs => ({
    builtInDir: builtinDir,
    customDir,
    workspaceDir: workspaceSkillsDir,
    workspaces: skillWorkspaceLayers(),
  });

  const changedBuiltins = await syncBuiltIn(repoSkillsDir, builtinDir);
  if (changedBuiltins.length > 0) {
    void log("info", "skills synced", { changed: changedBuiltins });
  }

  const allSkills = await loadAllSkills(skillsDirs());
  const skillRegistry = new SkillRegistry(allSkills);
  hooks.emit("skills:loaded", { count: allSkills.size });

  // File-defined agents, same three tiers as skills. See docs/file-agents.md.
  const repoAgentsDir = join(repoRoot, "src", "agents", "builtin");
  const builtinAgentsDir = join(MY_CLAW_DIR, "agents", ".builtin");
  const customAgentsDir = join(MY_CLAW_DIR, "agents");
  const workspaceAgentsDir = join(workspacePath, "agents");
  const agentsDirs = (): AgentDirs => ({
    builtInDir: builtinAgentsDir,
    customDir: customAgentsDir,
    workspaceDir: workspaceAgentsDir,
    workspaces: Object.entries(config.workspaces ?? {}).map(([key, dir]) => ({ key, dir: join(dir, "agents") })),
  });

  const changedAgents = await syncBuiltInAgents(repoAgentsDir, builtinAgentsDir);
  if (changedAgents.length > 0) {
    void log("info", "built-in agents synced", { changed: changedAgents });
  }

  const allAgents = await loadAllAgents(agentsDirs());
  const agentRegistry = new AgentRegistry(allAgents);
  hooks.emit("agents:loaded", { count: allAgents.size });

  // Scope entries pointing at nothing narrow an agent silently, so they are reported. Validated
  // against the *declared* MCP servers rather than the connected ones: a server that failed to
  // connect is still a real name, and flagging it as a typo would send the owner the wrong way.
  const unknownScopes = findUnknownScopeEntries(config, {
    skills: skillRegistry.names(),
    mcpServers: Object.keys(config.mcp ?? {}),
  });
  if (unknownScopes.length > 0) {
    log("warn", "agent scope entries match nothing", { entries: unknownScopes });
  }

  // Same reasoning for workspaces: a typo would pin an agent to a workspace that does not
  // exist, and the failure would only surface on that agent's first run.
  const unknownAgentWorkspaces = findUnknownAgentWorkspaces(config);
  if (unknownAgentWorkspaces.length > 0) {
    log("warn", "agent workspace keys match nothing in config.workspaces", { entries: unknownAgentWorkspaces });
  }

  // Same reasoning for prompt policies: a policy keyed by a workspace that does not exist is read
  // by no run, and the missing layer would only surface on that workspace's first run.
  const unknownPromptWorkspaces = findUnknownPromptWorkspaces(config);
  if (unknownPromptWorkspaces.length > 0) {
    log("warn", "prompt policies address workspaces that do not exist", { entries: unknownPromptWorkspaces });
  }

  // A workspace key that shadows a prompt source keyword. Not fatal -- a declared key wins over
  // the keyword -- but a policy can never select that workspace by name, which is a surprise.
  const shadowingWorkspaceKeys = findShadowingWorkspaceKeys(config);
  if (shadowingWorkspaceKeys.length > 0) {
    log("warn", "workspace keys shadow a prompt source keyword", { keys: shadowingWorkspaceKeys });
  }

  // An `agents.<name>` section addressing neither a reserved role nor a file in `agents/`. Config
  // is an override layer, so such a section is read by nobody and the setting silently never
  // applies -- the exact failure the two checks above exist to surface.
  const unknownAgents = findUnknownAgents(config, agentRegistry.names());
  if (unknownAgents.length > 0) {
    log("warn", "config sections address agents that do not exist", { agents: unknownAgents });
  }

  const subAgentRegistry = new SubAgentRegistry();
  // The browser agent's toolbox, registered whatever `browser.enabled` says: the delegate tool
  // reads that flag live and refuses when it is off, so the hot-reload watcher can toggle the
  // browser without a restart. The runner holds the session too, to queue and clean up its runs.
  const browserSession = new BrowserSession(config);
  registerBrowserTools(toolRegistry, config, browserSession);
  const subAgentRunner = new SubAgentRunner(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, agentRegistry, browserSession);
  // Live streams of sub-agent runs for the app channel, keyed by sub-agent session id.
  // Filled when `subagent:spawn` fires inside an app run, read by the spawn tool's
  // streamProvider to attach tokens to the sub-agent's own thread.
  const subAgentStreamers = new Map<string, MyClawAppStreamer>();
  // How to open a fresh bubble in a sub-agent's thread, filled by the run that opened the first one.
  // The provider below is built at boot and has no view of a thread, but a steered sub-agent needs
  // exactly that: the app channel is what knows where the child paints.
  const subAgentStreamRenew = new Map<string, (injected: UnifiedMessage) => MyClawAppStreamer>();
  registerSubAgentTools(
    toolRegistry, subAgentRunner, subAgentRegistry, config, agentRegistry, browserSession,
    (subagentId) => subAgentStreamFor(subAgentStreamers, subAgentStreamRenew, subagentId, (injected) => {
      hooks.emit("message:injected", { message: injected, sessionId: subagentId });
    }),
  );

  // Before anything opens a session. Awaited, not fired off: a channel coming up while the pass is
  // still running would read a conversation the pass is halfway through moving. Measured at 596 ms
  // for the 68 sessions on this install, and it is a one-off -- a session that already has its
  // directory is skipped, so every later boot pays a directory scan and nothing else.
  await migrateSessions(loadLegacySession);

  // Same window, same reason: the run markers of a session written before they existed are added
  // before any reader opens it, so no code ever meets a half-migrated file. One-off as well -- a
  // session that already carries a marker is skipped.
  await migrateRunMarkers();

  // And the ids of the pictures those markers name. A ref is a path and a device fetches an id, so
  // a marker written before this pass resolves by filename inside one thread directory -- which
  // misses the copy a sub-agent's run left in its parent's thread, and lists nothing at all for a
  // window that never read one. Stamped: the sweep costs a read of every log, and a marker written
  // after it carries its ids by construction.
  await migrateMediaIds();

  const sessionManager = new SessionManager();
  sessionManager.startAutosave();
  // Every run reads and appends through the manager's cached handle rather than opening the file
  // again: two handles on one conversation would each hold their own leaf and write past each
  // other -- docs/session-log.md annexe D.
  setSessionLogResolver((sessionId) => sessionManager.logOf(sessionId));
  // Registered here, once, and not inside a run: a background sub-agent outlives the run that
  // spawned it, so a subscription torn down with that run would miss the very state this records.
  recordSpawnLifecycle((sessionId) => sessionManager.logOf(sessionId));
  // The runner pre-dates the manager; adopt() lets live sub-agent runs surface in the app
  // channel (history/peek) instead of only the frozen pre-pushed task on disk.
  subAgentRunner.setSessionManager(sessionManager);
  registerSkillTools(toolRegistry, skillRegistry, config, builtinDir, customDir, workspaceSkillsDir, sessionManager);
  toolRegistry.register(createWorkspacesTool({ sessionManager, config, reload: reloadConfigNow }));
  const backfilledConversations = await backfillConversationArchive();
  if (backfilledConversations > 0) {
    void log("info", "conversation archive backfilled", { messages: backfilledConversations });
  }
  const agent = new BackendDispatcher(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, undefined, agentRegistry);
  const router = new MessageRouter(sessionManager, agent, config);
  const cronScheduler = new CronScheduler(router, sessionManager, config);

  // Run and job notifications to the app's devices (docs/notifications.md). Best-effort by
  // design: a dead push endpoint must never fail the run that produced the result.
  const threadTitle = async (sessionId: string, fallback: string): Promise<string> => {
    const session = await sessionManager.peek(sessionId);
    return session?.title?.trim() || cleanNotificationText(fallback).slice(0, 60);
  };
  registerRunNotifications({ titleOf: threadTitle, publish: publishNotification, isForegroundOn });
  // The browser tidies itself while it runs: pages of ended runs and ended holds, frozen tabs, and
  // a word to the owner before a long hold closes -- docs/browser-windows.md.
  browserSession.startHousekeeping((hold) => {
    hooks.emit("browser:hold:expiring", {
      holder: hold.holder, alias: hold.alias, until: hold.until,
      ...(hold.label ? { label: hold.label } : {}),
      ...(hold.urls[0] ? { url: hold.urls[0] } : {}),
    });
  });

  // A question the run is waiting on: the owner left the app open on another thread, or it is
  // in the background, or closed. The push is the only way the question reaches him; a device
  // already looking at the very thread sees the sheet itself and gets no double noise.
  questionManager.setNotifier((question) => {
    // The session the question waits in names its thread; the thread id it carries is the
    // fallback, never "default", which is a conversation of its own.
    const target = targetOfSession(question.sessionId) ?? (question.threadId ? { kind: "thread" as const, threadId: question.threadId } : undefined);
    const threadId = target?.kind === "thread" ? target.threadId : "";
    const first = question.questions[0];
    const label = first?.header?.trim() || first?.question?.trim() || "Question";
    void threadTitle(question.sessionId, label).then((title) =>
      publishNotification(
        {
          title,
          body: cleanNotificationText(label).slice(0, 160),
          ...(target ? { target } : {}),
        },
        { skipDevice: (deviceId) => (threadId ? isForegroundOn(deviceId, threadId) : Promise.resolve(false)) },
      ),
    );
  });

  toolRegistry.register(createNotifyTool());

  const installAlertAfterMs = (): number => {
    try {
      return config.cron?.alertAfter !== undefined ? parseDurationMs(config.cron.alertAfter) : DEFAULT_ALERT_AFTER_MS;
    } catch {
      return DEFAULT_ALERT_AFTER_MS;
    }
  };
  // `deliver: "thread:<title>"`: the owner's conversation of that name, or a new one in the job's
  // workspace. Found by title among the owner's threads, so a second job naming the same thread
  // lands beside the first instead of opening another. Shared by the cron tool and the app's job
  // editor, so both name the same conversation the same way.
  const ensureOwnerThread = async (owner: string, title: string, workspace?: string): Promise<string> => {
    const prefix = `my-claw-app/thread/${owner}/`;
    // The meta file alone: peeking every thread would load them all into the session cache.
    for (const id of await sessionManager.listSessions(prefix, 500)) {
      const meta = await readMeta(id).catch(() => null);
      if (meta?.title?.trim() === title.trim()) return id.slice(prefix.length);
    }
    const threadId = crypto.randomUUID();
    const sessionId = `${prefix}${threadId}`;
    const created = await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm", workspace);
    created.title = title.trim();
    await sessionManager.persist(sessionId);
    return threadId;
  };
  toolRegistry.register(createCronTool(cronScheduler, {
    // Live catalogs, read per call: a workspace or a skill added while the server runs must
    // show up on the next `cron list` without a restart.
    models: () => modelPicker.options().map((m) => m.id),
    defaultModel: () => config.llm.defaultModel ?? config.llm.model ?? "",
    workspaces: () => Object.keys(config.workspaces ?? {}),
    // listAll keeps one entry per layer, so a name defined in several workspaces would be
    // offered several times in the picker.
    skills: () => Array.from(new Set(skillRegistry.listAll().map((s) => s.name))),
    mcp: () => mcpManager.status().map((s) => s.name),
    cronTools: () =>
      toolRegistry
        .getForAgent("cron", config.tools?.disabled, resolveAgentMcp(config, "cron"), undefined)
        .map((t) => t.name),
    cronAgentSkills: () => resolveAgentSkills(config, "cron"),
    cronAgentMcp: () => resolveAgentMcp(config, "cron"),
    defaultTimeoutMs: () => config.cron?.timeoutMs,
    defaultAlertAfterMs: installAlertAfterMs,
    ensureThread: ensureOwnerThread,
  }));

  const adapters: Array<{ stop(): Promise<void> }> = [];
  let myClawAppRef: MyClawAppAdapter | undefined;
  // Filled by the app channel once its settings surface exists. The config watcher has to push the
  // same provider list the settings frames answer with, and that builder lives inside the channel.
  let pushAgentsConfig: (() => void) | undefined;

  // Boot-time alerts are addressed to a person, and the app names one through its paired devices.
  // Ambiguous (several owners) resolves to nothing rather than picking someone's conversation.
  const appOwner = (): string | undefined => {
    const appConfig = config.channels["my-claw-app"];
    if (!appConfig) return undefined;
    const resolved = defaultOwner(appConfig);
    return resolved.ok ? resolved.owner : undefined;
  };

  const startMyClawAppChannel = async (): Promise<void> => {
    // Channel keys are never validated, so a config still on the old name would start the
    // process with the channel silently missing. Say it out loud instead.
    if ("mobile" in config.channels) {
      log("warn", 'channels.mobile is not read anymore, rename it to channels["my-claw-app"]');
    }
    if (!isMyClawAppChannelEnabled(config)) return;
    const myClawAppConfig = config.channels["my-claw-app"]!;
    setAPNsDeviceAuthorization(deviceId => {
      const device = config.channels["my-claw-app"]?.devices?.[deviceId];
      return Boolean(device && device.enabled !== false);
    });
    const myClawAppSessions = new MyClawAppSessionStoreImpl(
      sessionManager,
      new SessionFileStore(myClawAppConfig),
      // Deleting a conversation takes its private sub-agents with it; the shared ones survive and
      // stay listed in every roster.
      async (sessionId) => {
        await subAgentRunner.deleteChildrenOf(sessionId, subAgentRegistry);
      },
      // Live config, so a workspace added or removed by hot-reload is accepted/refused at once.
      (key) => key === "default" || key in (config.workspaces ?? {}),
    );
    const myClawApp = new MyClawAppAdapter(myClawAppConfig, myClawAppSessions);
    // The quota module holds no config of its own: the composition root is where the live
    // providers live, and a hot-reloaded provider must answer on the next read.
    myClawApp.onQuotaController({
      get: (provider, force) => quotaFor(config, provider, { force }),
      redeem: (provider) => redeemQuota(config, provider),
    });
    // The remote-node surface reads the top-level `nodes` section live (mTLS header, claim TTL).
    myClawApp.setNodesConfig(() => config.nodes);
    myClawApp.onLocationResolver(new GeoapifyReverseGeocoder(() => process.env.GEOAPIFY_API_KEY));

    myClawAppRef = myClawApp;
    noticeSenders.set("my-claw-app", (chatId, text, threadId) => myClawApp.send(chatId, { text, notice: true, threadId }));

    // A send that lands during a compaction is held by the router until the history stops moving,
    // which is a minute or two with nothing on the wire. The device is told so the bubble says it
    // is waiting instead of looking dropped; the stream that follows lifts the mark.
    hooks.on("message:queued", ({ message }) => {
      if (message.platform !== "my-claw-app") return;
      myClawApp.notifyQueued(message.chatId, message.threadId ?? DEFAULT_THREAD, message.id, "compaction");
    });

    // The boundary a compaction wrote, automatic or typed, drawn now instead of at the next
    // history load. A session that is not one of this channel's threads is skipped by the
    // adapter. No notification is published for it on purpose -- see the hook's own note.
    hooks.on("session:compact:boundary", ({ sessionId, entryId, summary, count, archive }) => {
      myClawApp.notifyCompaction(sessionId, { id: entryId, summary, count, ...(archive ? { archive } : {}) });
    });

    // A send that lands while a run is active is parked in the run's mailbox and drained at the
    // next turn boundary (onTurnSwitch). The device marks the bubble "queued for the next turn";
    // `message:injected` (fired at the drain) lifts it via chat.send.acked.
    hooks.on("message:injection:queued", ({ message }) => {
      if (message.platform !== "my-claw-app") return;
      myClawApp.notifyQueued(message.chatId, message.threadId ?? DEFAULT_THREAD, message.id, "injection");
    });
    hooks.on("message:injected", ({ message }) => {
      if (message.platform !== "my-claw-app") return;
      myClawApp.notifyAcked(message.chatId, message.threadId ?? DEFAULT_THREAD, message.id);
    });

    // The run's lifecycle, as the router sees it: one start when a message actually opens a run,
    // one end when that run settles, whatever the reason. Not the message handler's: it runs once
    // per message, and a message that lands mid-run is folded into the run in flight rather than
    // opening one, so announcing from there gave a run one start and one end per message it
    // absorbed. The Stop button, the live journal a reloading window is replayed from and the
    // end-of-run ring all hang on these frames -- docs/live-turn-replay.md.
    const appRunOf = (message: UnifiedMessage): { owner: string; threadId: string } | null =>
      message.platform === "my-claw-app" ? { owner: message.chatId, threadId: message.threadId ?? DEFAULT_THREAD } : null;
    hooks.on("message:route:start", ({ message }) => {
      const run = appRunOf(message);
      if (run) myClawApp.notifyRun(run.owner, run.threadId, true, undefined, message.id);
    });
    hooks.on("message:route:complete", ({ message }) => {
      const run = appRunOf(message);
      if (run) myClawApp.notifyRun(run.owner, run.threadId, false, "done");
    });
    hooks.on("message:route:error", ({ message }) => {
      const run = appRunOf(message);
      if (run) myClawApp.notifyRun(run.owner, run.threadId, false, "error");
    });
    hooks.on("message:route:aborted", ({ message }) => {
      const run = appRunOf(message);
      if (run) myClawApp.notifyRun(run.owner, run.threadId, false, "aborted");
    });

    // Remote debugging surface: the app can pull a health snapshot and a filtered log tail,
    // both redacted here rather than in the adapter, which has no view of the global config.
    myClawApp.onVoiceController({
      status: () => ({
        mode: config.voice?.stt?.mode ?? config.voice?.mode ?? "auto",
        resolved: voiceManager.resolveMode("stt"),
        cloudAvailable: !!process.env.GROQ_API_KEY,
      }),
      setMode: async (mode) => {
        const result = await setVoiceSttMode(mode);
        if (!result.ok) throw new Error(result.error);
        // The file is the source of truth, but the watcher lands a beat later and the reply is
        // built now: apply it in memory too so the app is not told the old engine.
        voiceManager.setFeatureMode("stt", mode);
        reconcileOnDemand();
      },
    });

    // The services page (docs/services.md): the catalogue of the live config, each endpoint probed
    // once. A set answers from the file as written; the watcher applies it to the live config.
    const describeServices = async (source: MyClawConfig) => {
      // A key just pasted on the page is in .env before the watcher re-reads it: read it now, or
      // the page would show it missing right after saving it.
      refreshEnvFile();
      const kind = installKind();
      const local = async (id: string) => {
        // Embeddings run in-process, so any install downloads them, compose included (into its
        // home volume). Speech-to-text is an image in compose: only bare metal downloads it.
        const runtime = id === "embeddings" ? transformersRuntime : id === "stt" && kind === "native" ? whisperRuntime : undefined;
        if (!runtime) return undefined;
        const prep = runtime.status();
        return { state: prep.state, ...(prep.state === "failed" ? { error: prep.error } : {}), bytes: await diskBytes(runtime.paths()) };
      };
      const services = await Promise.all(
        serviceStates(source).map(async (state) => {
          const held = await local(state.id);
          return { ...state, choices: choicesOf(state.id, kind), health: await probeService(state), ...(held ? { local: held } : {}) };
        }),
      );
      const [push, apnsDevices] = await Promise.all([
        endpointStore.endpoints().catch(() => []),
        registeredAPNsDevices().catch(() => []),
      ]);
      return {
        install: kind,
        services,
        pushDevices: [...new Set([...push.map((entry) => entry.deviceId), ...apnsDevices])],
        pairedDevices: Object.keys(config.channels["my-claw-app"]?.devices ?? {}).length,
      };
    };
    // The subscriptions' sign-in from the app (docs/subscription-accounts.md): the same token stores
    // and provider bootstrap as `/codex` and `/claude`.
    myClawApp.onAccountsController(
      createAccounts({
        providers: () => config.llm.providers,
        addProvider: declareAccount,
        renameProvider: async (key, name) => {
          const written = await upsertProvider(key, { group: name });
          if (!written.ok) throw new Error(written.error);
          await reloadConfigNow();
        },
        onAuthChanged,
        onSettled: (state, error) => myClawApp.pushAccounts(state, error),
      }),
    );
    myClawApp.onServicesController({
      status: () => describeServices(config),
      set: async (choice) => {
        const written = await setService(choice);
        if (!written.ok) return written;
        return { ok: true, state: await describeServices(written.written as unknown as MyClawConfig) };
      },
      // Never the files of an engine in use: a transcription mid-flight would lose its model.
      free: async (id) => {
        if (await engineInUse(id)) return { ok: false, error: `${id} runs on this server: switch it to the cloud or a URL first` };
        if (id === "stt") await whisperRuntime.free();
        else await transformersRuntime.free();
        void log("info", "local engine freed", { id });
        return { ok: true, state: await describeServices(config) };
      },
    });

    // App display preferences, persisted server-side so every device and every reinstall starts
    // from the same layout choices. Same read-through/config-edit pattern as the voice mode.
    const uiPrefsStatus = () => ({
      expandTools: config.uiPrefs?.expandTools ?? false,
      expandReasoning: config.uiPrefs?.expandReasoning ?? false,
    });
    myClawApp.onUiPrefsController({
      status: uiPrefsStatus,
      set: async (prefs) => {
        const result = await setUiPrefs(prefs);
        if (!result.ok) throw new Error(result.error);
        return uiPrefsStatus();
      },
    });

    // The model menu of the app is built from the same picker as /model on the other channels,
    // so the two surfaces can never disagree about what is on offer or what is on.
    const modelSessionId = (owner: string, threadId: string): string =>
      SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
        threadId,
        sessionScope: "per-user",
      });
    /** A model's own full window, for the app's ceiling list (never offered above it). */
    const contextWindowOf = (modelId: string): number | undefined => {
      try {
        return contextChoiceFor(config, modelId, undefined).raw;
      } catch {
        // A model whose provider vanished must not take the whole catalog down.
        return undefined;
      }
    };
    const resolveModelState = async (owner: string, threadId: string) => {
      const session = await sessionManager.peek(modelSessionId(owner, threadId));
      const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";
      // What this chat actually runs, agent pin included. Reading `override ?? defaultModel` here
      // is what made the app display sonnet while every run went to the orchestrator's own pin.
      const run = tryResolveRunModel(
        config,
        { agent: "main", ...(session?.modelOverride ? { sessionModel: session.modelOverride } : {}) },
        availabilityWorld(),
      );
      const resolvedModel = run?.model ?? chatModel(config, session?.modelOverride);
      const model = run && tagNameOf(resolvedModel) !== undefined && !modelPicker.knows(resolvedModel)
        ? run.apiModel ?? resolvedModel
        : resolvedModel;
      const effort = effectiveEffort(config.llm, model, session?.effortOverride, resolveAgentLlm(config, "main")?.effort);
      const levels = modelPicker.effortLevelsFor(model);
      // The app builds its own ceiling list from these three numbers, the same way the picker
      // menus do on the other channels (docs/context-window.md).
      const choice = contextChoiceFor(config, model, session?.contextOverride);
      // The cap in force on this model, not the global one: a tag pins its own, and the app
      // offers exactly this number in the tune sheet (docs/context-window.md).
      const cap = standingContextCap(config, model, "main");
      return {
        model,
        defaultModel,
        ...(run ? { source: run.source } : {}),
        effort: {
          level: effort.source === "unsupported" ? "" : effort.level ?? "",
          levels,
          supported: effort.source !== "unsupported",
        },
        context: {
          raw: choice.raw,
          effective: choice.effective,
          ...(cap !== undefined && cap < choice.raw ? { cap } : {}),
          ...(session?.contextOverride === undefined ? {} : { choice: session.contextOverride }),
          // The occupancy the compaction gate reads, not a second estimate of it: the chat header
          // shows a share of the window, and two numbers for one thing would disagree by a turn.
          ...(session
            ? await (async () => {
                const log = await sessionLogOf(session.id);
                const prompt = promptOf(log.entries(), log.leaf());
                return {
                  used: occupiedContextTokens(
                    prompt,
                    (msgs) => [...msgs],
                    session.lastPrompt,
                    session.lastFixedTokens ?? 0,
                  ),
                };
              })()
            : {}),
        },
      };
    };
    /** Provider keys served by OpenRouter: only their models can have a route pinned. */
    const routableProviders = (): Set<string> =>
      new Set(
        Object.entries(config.llm.providers ?? {})
          .filter(([, provider]) => isOpenRouterBaseUrl(provider.baseUrl))
          .map(([name]) => name),
      );
    /** The declared half of the catalogue: what `llm.models` contributes, by id. */
    const declaredIds = (): Set<string> => new Set(baseModels.map((m) => m.id));
    /**
     * A declaration edit, applied before the answer goes out. Awaited on purpose: the watcher's
     * own reload is debounced, so a broadcast that did not wait would carry the catalogue from
     * before the write and the app would show the edit as a no-op until something else moved.
     */
    const applyModelEdit = async (note: string): Promise<void> => {
      await reloadConfigNow().catch((err) => {
        void log("warn", "config reload after model edit failed", { note, error: String(err) });
      });
    };
    myClawApp.onModelController({
      list: () => {
        const routable = routableProviders();
        const declared = declaredIds();
        const discovered = new Set(modelCatalog.discovered().map((m) => m.id));
        const world = availabilityWorld();
        return {
          // Known and not runnable: never offered, always shown by the management view. A filtered
          // list cannot say what it removed, which is how three declarations survived their own
          // deletion from a gateway unnoticed (docs/model-declarations.md).
          unavailable: (config.llm.models ?? []).flatMap((model) => {
            const availability = availabilityOf(config.llm, model.id, world);
            if (availability === undefined || availability.state === "ready") return [];
            return [{
              id: model.id,
              label: model.label || model.id,
              ...(model.provider ? { provider: model.provider } : {}),
              ...(declared.has(model.id) ? { declared: true } : {}),
              ...(discovered.has(model.id) ? { discovered: true } : {}),
              state: availability.state,
              reason: describeAvailability(availability),
            }];
          }),
          models: modelPicker.options().map((m) => {
            // One lookup per option: everything the form shows about a model that is not already
            // on the picker option itself comes from here.
            const entry = config.llm.models?.find((model) => model.id === m.id);
            return {
            id: m.id,
            label: m.label,
            ...(m.group ? { group: m.group } : {}),
            // The provider key rides along so the app can group the catalog by provider without
            // asking for a second list that could disagree with this one.
            ...(m.provider ? { provider: m.provider } : {}),
            // Per-model effort levels and full window: the app's chained picker offers those two
            // steps for the model being staged, which is not necessarily the one in force.
            ...(modelPicker.effortLevelsFor(m.id).length > 0 ? { effortLevels: modelPicker.effortLevelsFor(m.id) } : {}),
            ...(contextWindowOf(m.id) === undefined ? {} : { context: contextWindowOf(m.id) }),
            // A tag entry names the effort it pins, so a config flow that stages it can say what
            // applies instead of silently inheriting the scope's own pin.
            ...(() => {
              const tagName = tagNameOf(m.id);
              const tagEffort = tagName !== undefined ? config.tags?.[tagName]?.effort : undefined;
              return tagEffort ? { effort: tagEffort } : {};
            })(),
            // Whether the model accepts image input: the fallback picker needs it to offer only
            // models the resolver would actually reroute to. Mirrors the resolver's own guard.
            // A tag is answered by the model its route lands on, since that is the capability the
            // rerouted run would use.
            ...(() => {
              if (entry) return entry.vision === undefined ? {} : { vision: entry.vision };
              if (tagNameOf(m.id) === undefined) return {};
              const leafVision = findModel(config.llm, leafModelId(config.llm, m.id))?.vision;
              return leafVision === undefined ? {} : { vision: leafVision };
            })(),
            // What this model reads its own prior reasoning back from, and the answer budget it
            // was given. Both ride along so the edit form shows what actually runs -- a family
            // default included (docs/model-metadata.md) -- instead of an empty field over a real
            // setting that the next save would then clear.
            ...(entry?.reasoningField === undefined ? {} : { reasoningField: entry.reasoningField }),
            ...(entry?.limit?.output === undefined ? {} : { output: entry.limit.output }),
            // Whether a routing step is worth offering at all. Read from the provider key rather
            // than by resolving each of several hundred models; `model.endpoints` answers for real.
            ...(m.provider !== undefined && routable.has(m.provider) ? { routes: true } : {}),
            // Where this entry comes from, so the app can label it (custom vs override) and word
            // its delete button as a reset when the provider serves the id too.
            ...(declared.has(m.id) ? { declared: true } : {}),
            ...(discovered.has(m.id) ? { discovered: true } : {}),
            // The request budget this model declares, so the form shows what is stored rather than
            // an empty field over a real setting. `0` is a value here (docs/llm-timeout.md).
            ...(entry?.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
            };
          }),
          defaultModel: config.llm.defaultModel ?? config.llm.model ?? "",
        };
      },
      upsert: async (entry) => {
        const result = await upsertModel({
          id: entry.id,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          ...(entry.apiId === undefined ? {} : { apiId: entry.apiId }),
          ...(entry.provider === undefined ? {} : { provider: entry.provider }),
          ...(entry.group === undefined ? {} : { group: entry.group }),
          ...(entry.family === undefined ? {} : { family: entry.family }),
          ...(entry.vision === undefined ? {} : { vision: entry.vision }),
          ...(entry.supportsEffort === undefined ? {} : { supportsEffort: entry.supportsEffort }),
          ...(entry.effortLevels === undefined ? {} : { supportedEffortLevels: entry.effortLevels as EffortLevel[] }),
          ...(entry.thinkingAdaptive === undefined && entry.thinkingEnabled === undefined
            ? {}
            : { thinkingTypes: { adaptive: entry.thinkingAdaptive === true, enabled: entry.thinkingEnabled === true } }),
          ...(entry.context === undefined && entry.output === undefined
            ? {}
            : { limit: { ...(entry.context === undefined ? {} : { context: entry.context }), ...(entry.output === undefined ? {} : { output: entry.output }) } }),
          ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
        });
        if (!result.ok) throw new Error(result.error);
        await applyModelEdit(`modèle ${entry.id}`);
      },
      remove: async (id) => {
        const result = await removeModel(id);
        if (!result.ok) throw new Error(result.error);
        await applyModelEdit(`retrait modèle ${id}`);
      },
      refresh: async () => {
        // Awaited, not fired and forgotten: the button exists to be told when the answer is in,
        // and the catalogue coalesces concurrent passes onto the one already running.
        // The same press refetches both metadata tables past their TTLs. Discovery alone left a
        // new id with no window and no effort ladder whenever models.dev published it after the
        // last table download (deepseek-flash, released between two fetches, sat at the global
        // cap with no efforts until the 24h TTL rolled over) -- a manual refresh is exactly when
        // fresh metadata is the point.
        await Promise.all([modelCatalog.refresh(), pricing.refresh(), openRouterModels(true)]);
        applyModelCatalog();
        // A provider that opts into discovery but has no complete answer on record kept its
        // previous models (docs/model-identity.md). Saying which ones is the whole point of a
        // manual refresh: silence would read as "nothing new", which is a different fact.
        const failed = Object.entries(config.llm.providers ?? {})
          .filter(([name, provider]) => provider.discover && !modelCatalog.answered(name))
          .map(([name]) => name);
        return { models: modelPicker.options().length, failed, enabled: modelCatalog.enabled() };
      },
      endpoints: async (modelRef, sort) => {
        // One route list for every surface: the same helper answers the two channel menus, so the
        // app can never offer a route the /model menu does not (docs/model-identity.md). Sorting
        // happens here for the same reason: three surfaces ordering one model's providers three
        // ways is how a menu comes to present a different "cheapest" than the next one.
        const routes = sortRoutes(await routesFor(config, modelRef), sort ?? "price");
        return routes.map((route) => ({
          id: referenceWithRoute(modelRef, route.tag),
          label: route.providerName === route.tag ? route.tag : `${route.providerName} (${route.tag})`,
          ...(route.promptUsd === undefined ? {} : { promptUsd: route.promptUsd }),
          ...(route.completionUsd === undefined ? {} : { completionUsd: route.completionUsd }),
          ...(route.context === undefined ? {} : { context: route.context }),
          ...(route.maxOutput === undefined ? {} : { maxOutput: route.maxOutput }),
          ...(route.degraded ? { degraded: true } : {}),
          ...(route.uptime30m === undefined ? {} : { uptime30m: route.uptime30m }),
        }));
      },
      current: (owner, threadId) => resolveModelState(owner, threadId),
      set: async (owner, threadId, modelId) => {
        const sessionId = modelSessionId(owner, threadId);
        // Unlike rename, a missing session is not refused: the thread is already in the app's
        // list, and picking a model for it is exactly what /model does on the other channels.
        const session =
          (await sessionManager.peek(sessionId)) ??
          (await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        const previousModel = (await resolveModelState(owner, threadId)).model;
        session.modelOverride = overrideForPick(config, { agent: "main" }, modelId, availabilityWorld());
        // A tag carries its own effort and ceiling, and picking it is how a conversation adopts
        // them: the pins set on top of the previous model would outrank both. Same for a pick
        // that hands the conversation back to its scope (no override left).
        resetPinsOnPick(session, modelId, session.modelOverride);
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        hooks.emit("session:model:changed", { sessionId, previousModel, newModel: modelId });
        return resolveModelState(owner, threadId);
      },
      setEffort: async (owner, threadId, level) => {
        const sessionId = modelSessionId(owner, threadId);
        const session =
          (await sessionManager.peek(sessionId)) ??
          (await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        // An empty level is the deliberate clear: the session hands its effort back to the tag pin
        // or the scope's default. Without it, "default (inherit)" in the picker could only
        // descend once, and every later click landed on invalid effort level.
        if (level === "") {
          delete session.effortOverride;
          session.lastActiveAt = new Date().toISOString();
          await sessionManager.persist(sessionId);
          return resolveModelState(owner, threadId);
        }
        const activeModel = (await resolveModelState(owner, threadId)).model;
        const levels = modelPicker.effortLevelsFor(activeModel);
        if (!levels.includes(level as never)) throw new Error(`invalid effort level: ${level}`);
        session.effortOverride = level as never;
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        return resolveModelState(owner, threadId);
      },
      setContext: async (owner, threadId, choice) => {
        const sessionId = modelSessionId(owner, threadId);
        const session =
          (await sessionManager.peek(sessionId)) ??
          (await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        const activeModel = (await resolveModelState(owner, threadId)).model;
        // "full" is the model's own window, so it is stored as the marker rather than a number
        // that would go stale the day the model's window changes. A ceiling is clamped to the
        // window: a conversation may lower it, never lift it above what the model can hold.
        if (choice === "full") {
          session.contextOverride = "full";
        } else {
          const raw = contextChoiceFor(config, activeModel, undefined).raw;
          session.contextOverride = Math.min(Math.floor(choice), raw);
        }
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        return resolveModelState(owner, threadId);
      },
    });

    // Agent defaults for the phone app: the same writers as `/model <agent>`, plus the global
    // default that had no writer until now. Every answer is a fresh snapshot of the config so a
    // stale page can never survive a server-side change.
    const toolTypeFor = (key: string): AgentToolType => (key === "orchestrator" ? "main" : key);
    const agentModelOf = (key: string): string => {
      try {
        const file = agentRegistry.get(key);
        const resolved = resolveAgentLlmConfig(resolveAgentLlm(config, toolTypeFor(key), file?.meta.model), config.llm);
        const model = resolved.model ?? "";
        // A deleted tag is still the stored identity, but it is no longer a picker entry. Show the
        // concrete Default model on the settings surface so the row describes what will run.
        return model && tagNameOf(model) !== undefined && !modelPicker.knows(model) ? resolved.apiModel ?? model : model;
      } catch {
        // A removed provider must not take the whole page down: the row shows an empty model.
        return "";
      }
    };
    const providerCountOf = (providerKey: string): number =>
      modelPicker.options().filter((m) => (m.provider ?? config.llm.defaultProvider) === providerKey).length;
    // Any tag reference remains a valid model reference even after its definition is deleted:
    // resolution falls back to Default and recreating the name reactivates it.
    const isTagReference = (modelId: string): boolean => tagNameOf(modelId) !== undefined;
    const modelReferenceKnown = (modelId: string): boolean => modelPicker.knows(modelId) || isTagReference(modelId);

    /** The two agents that exist without a file. Spawnable agents come from the registry. */
    const AGENT_ROLES = ["orchestrator", "cron"] as const;

    /** One row of the agents page: the config entry over the file, marked with where it came from. */
    const agentRow = (
      key: string,
      label: string,
      description: string,
      inheritsFrom: "global" | "orchestrator",
      file?: { source: string; path: string; base: string; layer?: string },
    ) => {
      const entry = agentConfigOf(config, toolTypeFor(key));
      const llm = entry?.llm;
      const model = agentModelOf(key);
      const definition = agentRegistry.get(key);
      const skills = entry?.skills ?? (Array.isArray(definition?.meta.skills) ? definition.meta.skills : null);
      const mcp = entry?.mcp ?? (Array.isArray(definition?.meta.mcp) ? definition.meta.mcp : null);
      const workspace = entry?.workspace ?? definition?.meta.workspace ?? null;
      // Scope entries matching nothing are the whole reason the page flags them: an entry that
      // exists in config but not in any live catalog is dead weight, and hiding it would make it
      // unremovable. Same catalogs as the boot report (findUnknownScopeEntries), read live.
      const knownSkills = new Set(skillRegistry.names());
      const knownMcp = new Set(Object.keys(config.mcp ?? {}));
      const unknownOf = (list: string[] | null, known: Set<string>): string[] =>
        list && !list.includes("*") ? list.filter((n) => !known.has(n)) : [];
      return {
        key,
        label,
        description,
        model,
        ...(model ? { provider: modelPicker.providerFor(model) ?? config.llm.defaultProvider } : {}),
        ...(llm?.effort !== undefined ? { effort: llm.effort } : {}),
        pinned: llm?.defaultModel !== undefined || llm?.defaultProvider !== undefined,
        inheritsFrom,
        // Config over file, so the page shows what the agent actually resolves to rather than what
        // one of the two layers happens to say.
        skills,
        mcp,
        workspace,
        contextCap: entry?.context?.cap ?? definition?.meta.contextCap ?? null,
        maxIterations: entry?.maxIterations ?? definition?.meta.maxIterations ?? null,
        ...(unknownOf(skills, knownSkills).length > 0 ? { unknownSkills: unknownOf(skills, knownSkills) } : {}),
        ...(unknownOf(mcp, knownMcp).length > 0 ? { unknownMcp: unknownOf(mcp, knownMcp) } : {}),
        ...(workspace !== null && !config.workspaces?.[workspace] ? { unknownWorkspace: true } : {}),
        ...(file ? { source: file.source, path: file.path, base: file.base, ...(file.layer ? { layer: file.layer } : {}) } : {}),
      };
    };
    const agentsConfigSnapshot = () => {
      const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";
      return {
        type: "agents.config.result" as const,
        defaultModel,
        ...(config.llm.defaultProvider ? { defaultProvider: config.llm.defaultProvider } : {}),
        defaultEffort: config.llm.effort ?? "",
        effortLevels: EFFORT_LEVELS,
        fallback: config.llm.visionFallback ?? "",
        // The schedule is sent resolved, so the page renders what will actually be waited for and
        // has no copy of the default to drift from (docs/provider-failures.md).
        retry: {
          enabled: config.llm.providerRetry?.enabled !== false,
          delaysMs: providerRetryDelays(config.llm),
        },
        contextCap: {
          ...(config.context?.cap === undefined ? {} : { value: config.context.cap }),
          default: DEFAULT_CONTEXT_CAP,
        },
        providers: [
          // The virtual "Tags" provider rows at the top of the app's provider list: one entry
          // for the reserved `Default` tag plus one per configured tag (docs/tags.md). The app
          // opens the tags page instead of a provider page when this row is tapped.
          {
            key: "tags",
            type: "tags",
            discover: false,
            models: 1 + Object.keys(config.tags ?? {}).length,
            keyPresent: true,
          },
          ...Object.entries(config.llm.providers ?? {}).map(([key, provider]) => ({
            key,
            type: provider.type ?? "openai",
            ...(provider.group ? { group: provider.group } : {}),
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            ...(provider.promptCache !== undefined ? { promptCache: provider.promptCache } : {}),
            ...(provider.reasoningReplay !== undefined ? { reasoningReplay: provider.reasoningReplay } : {}),
            ...(provider.pricingProvider ? { pricingProvider: provider.pricingProvider } : {}),
            ...(provider.fallbackModel ? { fallbackModel: provider.fallbackModel } : {}),
            ...(provider.disabled ? { disabled: true } : {}),
            discover: provider.discover === true,
            models: providerCountOf(key),
            // How its last discovery went: what the page that just added it reads as "N models"
            // or the reason the key was refused.
            ...(modelCatalog.discovery(key) ? { discovery: modelCatalog.discovery(key)! } : {}),
            ...(provider.apiKeyEnv ? { keyEnv: provider.apiKeyEnv } : {}),
            // A plan: the app draws its sign-in instead of a key (docs/subscription-accounts.md).
            ...(accountKindOf(provider) ? { account: accountKindOf(provider)! } : {}),
            // The providers that publish their limits: the app draws a quota line on the row.
            ...(quotaSourceOf(provider) ? { quota: quotaSourceOf(provider)! } : {}),
            // A plan has no env key at all, and reporting "no key" for it said the opposite of the
            // truth on a box that was perfectly authenticated. Its credential is its own sign-in.
            keyPresent:
              accountKindOf(provider)
                ? signedIn.has(key)
                : provider.apiKeyEnv
                  ? Boolean(process.env[provider.apiKeyEnv])
                  : false,
          })),
        ],
        // The two reserved roles, then every file-defined agent. The page is a browse surface, so
        // it lists the whole catalog and marks each agent's tier rather than filtering by workspace.
        agents: [
          ...AGENT_ROLES.map((key) => agentRow(key, AGENTS[key].label, AGENTS[key].description, AGENTS[key].inheritsFrom)),
          ...agentRegistry.listAll().map((agent) => agentRow(
            agent.name,
            agent.name,
            agent.description,
            "global",
            { source: agent.source, path: agent.path, base: agent.base, ...(agent.layer ? { layer: agent.layer } : {}) },
          )),
        ],
      };
    };
    pushAgentsConfig = () => myClawApp.pushAgentsConfig(agentsConfigSnapshot());
    // A pass changes what every provider page shows (its count, its failure) and what the picker
    // offers: pushed, or a provider just added would read "checking" until the page is reopened.
    hooks.on("models:discovered", () => {
      pushAgentsConfig?.();
      pushModelListToOwners();
    });
    /**
     * Whether a name may receive config overrides: a reserved role, or an agent that has a file.
     * Accepting anything would let the app create an `agents.<typo>` section that nothing reads.
     */
    const writableAgent = (agent: string): boolean =>
      (AGENT_ROLES as readonly string[]).includes(agent) || agentRegistry.exists(agent);

    const writeAgentsConfig = async (note: string): Promise<MyClawAppAgentsConfigResult> => {
      // The file is the source of truth, but the watcher lands a beat later and the answer is
      // built now: reload explicitly so the reply describes the running config, like /model does.
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after agents edit failed", { note, error: String(err) });
      });
      return agentsConfigSnapshot();
    };
    // The agent file editor's payload: structured fields from the actual file on disk. Built from
    // the file rather than the registry so the sha is the sha of what the next write would edit.
    const agentFileResult = async (file: FileAgent): Promise<MyClawAppAgentFileResult | null> => {
      const doc = await readAgentFile(file.path);
      if (!doc) return null;
      const parsed = parseAgentFile(doc.text, file.name, file.path);
      if ("rejected" in parsed) return null;
      const fields = fieldsOfMeta(parsed.meta);
      const toolOptions = baselineToolNames(parsed.meta.base, toolRegistry.staticNames());
      return {
        type: "agents.file.result",
        name: file.name,
        source: file.source,
        path: file.path,
        editable: file.source !== "built-in",
        sha: doc.sha,
        description: fields.description,
        ...(fields.base ? { base: fields.base } : {}),
        ...(fields.tools ? { tools: fields.tools } : {}),
        skillsMode: fields.skillsMode,
        ...(fields.skills ? { skills: fields.skills } : {}),
        mcpMode: fields.mcpMode,
        ...(fields.mcp ? { mcp: fields.mcp } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.workspace ? { workspace: fields.workspace } : {}),
        ...(fields.maxIterations !== undefined ? { maxIterations: fields.maxIterations } : {}),
        ...(fields.contextCap !== undefined ? { contextCap: fields.contextCap } : {}),
        ...(fields.instructions ? { instructions: fields.instructions } : {}),
        prompt: parsed.prompt,
        toolOptions,
        // A tools: entry outside the baseline is dropped at run time, so it is flagged instead of
        // being silently saved into a set that never applies.
        unknownTools: (fields.tools ?? []).filter((t) => !toolOptions.includes(t)),
      };
    };
    const reloadAgentsNow = (): Promise<number> => reloadAgents(agentsDirs(), agentRegistry);
    /**
     * A pin may only name a rung the model actually offers. The vocabulary alone was the check,
     * which was wrong in both directions: `max` was accepted on a model whose ladder stops at
     * `high` (the run clamps it, so the file said one thing and the request another), while `none`
     * was refused on the very models that publish it, the fallback list starting at `low`.
     */
    const assertEffortOffered = (modelId: string, level: string): void => {
      const concreteModel = tagNameOf(modelId) === undefined ? modelId : leafModelId(config.llm, modelId);
      const levels = modelPicker.effortLevelsFor(concreteModel);
      if (levels.length === 0) throw new Error(`effort has no effect on ${modelId}`);
      if (!levels.includes(level as EffortLevel)) {
        throw new Error(`invalid effort level for ${modelId}: ${level} (offered: ${levels.join(", ")})`);
      }
    };
    myClawApp.onAgentsController({
      get: () => agentsConfigSnapshot(),
      setModel: async (agent, modelId, effort) => {
        if (!modelReferenceKnown(modelId)) throw new Error(`unknown model: ${modelId}`);
        // A tag id must not pin a provider: the tag resolves through config.tags and its model
        // carries its own provider. The "tags" provider key exists only in the UI (docs/tags.md).
        const provider = tagNameOf(modelId) !== undefined ? undefined : modelPicker.providerFor(modelId);
        // The effort travels with the model: "" clears the pin, a level writes it, and neither
        // says anything when the frame omits it.
        const effortArg = effort === undefined ? undefined : effort === "" ? ("clear" as const) : (effort as EffortLevel);
        if (effort !== undefined && effort !== "") assertEffortOffered(modelId, effort);
        if (agent === "global") {
          const result = await setDefaultModel(modelId, provider, effortArg);
          if (!result.ok) throw new Error(result.error);
          return writeAgentsConfig(`défaut global ${modelId}`);
        }
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await setAgentModel(agent, modelId, provider, effortArg);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`modèle ${agent} ${modelId}`);
      },
      clearModel: async (agent) => {
        if (agent === "global") throw new Error("global has no model pin to clear");
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await clearAgentModel(agent);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`clear modèle ${agent}`);
      },
      setFallback: async (modelId) => {
        // "" removes the pin. A tag is accepted as it stands: it names a route, and the resolver
        // reads the leaf's capability at run time, so a route that moves to a text-only model
        // stops applying instead of failing a run.
        if (modelId !== "") {
          const name = tagNameOf(modelId);
          if (name !== undefined) {
            if (name !== "Default" && !config.tags?.[name]) throw new Error(`unknown tag: ${modelId}`);
          } else {
            const declared = findModel(config.llm, modelId);
            if (!declared) throw new Error(`unknown model: ${modelId}`);
            if (declared.vision !== true) throw new Error(`${modelId} cannot take images`);
          }
        }
        const result = await setVisionFallback(modelId);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`fallback image ${modelId || "aucun"}`);
      },
      setRetry: async (patch) => {
        const result = await setProviderRetry(patch);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`retry provider ${patch.enabled ? "on" : "off"}`);
      },
      setScope: async (agent, field, mode, names) => {
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await setAgentScope(agent, field, mode, names);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`scope ${agent}.${field}`);
      },
      setWorkspace: async (agent, workspace) => {
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await setAgentWorkspace(agent, workspace);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`workspace ${agent}`);
      },
      setMaxIterations: async (agent, value) => {
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await setAgentMaxIterations(agent, value);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`itérations ${agent}`);
      },
      setDefaultContextCap: async (value) => {
        const result = await setDefaultContextCap(value ?? undefined);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`context cap ${value ?? "default"}`);
      },
      setContextCap: async (agent, value) => {
        if (!writableAgent(agent)) throw new Error(`unknown agent: ${agent}`);
        const result = await setAgentContextCap(agent, value ?? undefined);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`context cap ${agent}`);
      },
      fileGet: async (agent) => {
        const file = agentRegistry.get(agent);
        if (!file) return null;
        return agentFileResult(file);
      },
      fileSet: async (agent, fields) => {
        const file = agentRegistry.get(agent);
        if (!file) throw new Error(`unknown agent: ${agent}`);
        if (file.source === "built-in") throw new Error("built-in agents are repo-synced; fork to a custom file first");
        // The browser agent is the browser base and nothing else: the editor cannot move it off
        // the toolbox `delegate_browser_task` runs it with, whatever picker it offers. A node
        // agent is pinned the same way, and its `node:` id is carried from the file on disk: an
        // editor that never saw the field must not strip the file of the machine it belongs to.
        const currentMeta = agentRegistry.get(agent)?.meta;
        const base = agent === "browser" ? "browser" : currentMeta?.base === "node" ? "node" : fields.base;
        const text = serializeAgentFile(
          {
            description: fields.description,
            ...(base ? { base } : {}),
            ...(base === "node" && currentMeta?.node ? { node: currentMeta.node } : {}),
            ...(fields.tools ? { tools: fields.tools } : {}),
            skillsMode: fields.skillsMode,
            ...(fields.skills ? { skills: fields.skills } : {}),
            mcpMode: fields.mcpMode,
            ...(fields.mcp ? { mcp: fields.mcp } : {}),
            ...(fields.model ? { model: fields.model } : {}),
            ...(fields.workspace ? { workspace: fields.workspace } : {}),
            ...(fields.maxIterations !== undefined ? { maxIterations: fields.maxIterations } : {}),
            ...(fields.contextCap !== undefined ? { contextCap: fields.contextCap } : {}),
            ...(fields.instructions ? { instructions: fields.instructions as PromptLayerName[] } : {}),
          },
          fields.prompt,
        );
        const written = await writeAgentFile(file.path, text, fields.sha, agent);
        if (!written.ok) {
          throw new Error(written.conflict ? `conflict: ${written.error}` : written.error);
        }
        const result = await agentFileResult(await reloadAgentsNow().then(() => agentRegistry.get(agent) ?? file));
        if (!result) throw new Error("agent file unreadable after write");
        return result;
      },
      fileCreate: async (name, description) => {
        const created = await createAgentFile(customAgentsDir, name, description);
        if (!created.ok) throw new Error(created.error);
        await reloadAgentsNow();
        const file = agentRegistry.get(name);
        if (!file) throw new Error("agent file did not load");
        const result = await agentFileResult(file);
        if (!result) throw new Error("agent file unreadable");
        return result;
      },
      fileDelete: async (agent) => {
        const file = agentRegistry.get(agent);
        if (!file) throw new Error(`unknown agent: ${agent}`);
        if (file.source === "built-in") throw new Error("built-in agents are repo-synced and cannot be deleted");
        await deleteAgentFile(file.path);
        await reloadAgentsNow();
      },
    });

    // Tags: named aliases for a model/effort/context combo (docs/tags.md). The listing is a
    // fresh read of the config after every mutation, like the agents snapshot: a stale page can
    // never survive a server-side edit. The virtual `Default` tag is synthesized, not stored.
    const tagsSnapshot = (): MyClawAppTagsResult => ({
      type: "tags.result",
      tags: [
        { name: "Default", model: config.llm.defaultModel ?? config.llm.model ?? "" },
        ...Object.entries(config.tags ?? {}).map(([name, tag]) => {
          const route = tagRouteOf(tag);
          const first = route[0];
          return {
            name,
            model: first?.model ?? "",
            ...(first?.effort ? { effort: first.effort } : {}),
            ...(first?.contextCap !== undefined ? { contextCap: first.contextCap } : {}),
            route: route.map((candidate) => ({
              model: candidate.model,
              ...(candidate.effort ? { effort: candidate.effort } : {}),
              ...(candidate.contextCap !== undefined ? { contextCap: candidate.contextCap } : {}),
            })),
            ...(tag.fallbackToGlobalDefault ? { fallbackToGlobalDefault: true } : {}),
          };
        }),
      ],
    });
    const writeTagsConfig = async (note: string): Promise<MyClawAppTagsResult> => {
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after tags edit failed", { note, error: String(err) });
      });
      return tagsSnapshot();
    };
    myClawApp.onTagsController({
      list: () => tagsSnapshot(),
      upsert: async (fields) => {
        const route = (fields.route ?? (fields.model ? [{ model: fields.model, ...(fields.effort ? { effort: fields.effort } : {}), ...(fields.contextCap !== undefined ? { contextCap: fields.contextCap } : {}) }] : [])).map((candidate) => ({
          model: candidate.model,
          ...(candidate.effort ? { effort: candidate.effort as EffortLevel } : {}),
          ...(candidate.contextCap !== undefined ? { contextCap: candidate.contextCap } : {}),
        }));
        if (route.length === 0) throw new Error("tag route must contain at least one model");
        for (const candidate of route) {
          if (!modelReferenceKnown(candidate.model)) throw new Error(`unknown model: ${candidate.model}`);
          if (candidate.effort) assertEffortOffered(candidate.model, candidate.effort);
        }
        const result = await setTag(fields.name, { ...fields, route });
        if (!result.ok) throw new Error(result.error);
        return writeTagsConfig(`tag ${fields.name}`);
      },
      delete: async (name) => {
        const result = await deleteTag(name);
        if (!result.ok) throw new Error(result.error);
        return writeTagsConfig(`suppression tag ${name}`);
      },
    });

    // Provider CRUD. Env keys are names in config, values in .env: the two files stay in step
    // through the two editors, and the catalog is refreshed so a provider that just gained a
    // key (or just appeared) discovers its models now instead of at the next 6h cycle.
    const writeProvidersConfig = async (note: string): Promise<MyClawAppAgentsConfigResult> => {
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after providers edit failed", { note, error: String(err) });
      });
      void modelCatalog.refresh();
      return agentsConfigSnapshot();
    };
    const envSnapshot = async (): Promise<MyClawAppProviderEnvResult> => {
      const names = await envKeys();
      return {
        type: "providers.env.result",
        names,
        present: [...new Set([...names, ...Object.keys(process.env)])],
        usedBy: Object.fromEntries(
          Object.entries(config.llm.providers ?? {})
            .filter(([, provider]) => provider.apiKeyEnv !== undefined)
            .map(([key, provider]) => [key, provider.apiKeyEnv!]),
        ),
        claudeClaim: claudeClaim(),
      };
    };
    myClawApp.onProvidersController({
      upsert: async (patch) => {
        const { key, providerType, baseUrl, apiKeyEnv, group, discover, promptCache, reasoningReplay, pricingProvider, fallbackModel, disabled } = patch;
        const result = await upsertProvider(key, { type: providerType, baseUrl, apiKeyEnv, group, discover, promptCache, reasoningReplay, pricingProvider, fallbackModel, disabled });
        if (!result.ok) throw new Error(result.error);
        return writeProvidersConfig(`provider ${patch.key}`);
      },
      remove: async (key, withModels) => {
        const result = await removeProvider(key, { withModels: withModels === true });
        if (!result.ok) throw new Error(result.error);
        // A plan removed takes its sign-in with it: the next provider of that name starts signed out.
        await removeAccount(key);
        return writeProvidersConfig(`retrait provider ${key}`);
      },
      rename: async (from, to) => {
        const result = await renameProviderEverywhere(from, to, editableAgentTierDirs(agentsDirs()));
        if (!result.ok) throw new Error(result.error);
        return writeProvidersConfig(`renommage provider ${from} → ${to}`);
      },
      renamePreview: (from, to) => previewProviderRename(from, to, editableAgentTierDirs(agentsDirs())),
      envSet: async (name, value) => {
        const result = await setEnvValue(name, value);
        if (!result.ok) throw new Error(result.error);
        void modelCatalog.refresh();
      },
      envRename: async (from, to) => {
        const result = await renameEnvKey(from, to);
        if (!result.ok) throw new Error(result.error);
        const repointed = await repointEnvKey(from, to);
        if (!repointed.ok) {
          // The .env line moved but the config did not: restore the old name so the two files
          // are back in step, then say why the rename was refused.
          await renameEnvKey(to, from);
          throw new Error(repointed.error);
        }
        void modelCatalog.refresh();
      },
      envRemove: async (name) => {
        const result = await removeEnvKey(name);
        if (!result.ok) throw new Error(result.error);
      },
      envList: () => envSnapshot(),
    });

    // The browse catalog, every workspace included: this is a reading surface, not an agent
    // run, and an agent's own view stays narrowed by list(scope, workspace). The shadowing
    // fields travel with it so the page can say which copy of a name actually wins.
    const skillCatalog = (): MyClawAppSkillEntry[] =>
      skillRegistry.listAll().map((s) => ({
        name: s.name,
        description: s.description,
        ...(s.version ? { version: s.version } : {}),
        source: s.source,
        path: s.path,
        ...(s.workspace ? { workspace: s.workspace } : {}),
        ...(s.overriddenIn ? { overriddenIn: s.overriddenIn } : {}),
        ...(s.overrides ? { overrides: s.overrides } : {}),
      }));
    myClawApp.onSkillsController({
      list: () => ({ skills: skillCatalog() }),
      transfer: async (input) => {
        const outcome = await transferSkill(input, {
          builtInDir: builtinDir,
          customDir,
          workspaceSkillsDir,
          workspaces: config.workspaces,
        });
        // The watcher would catch the new directory on its own, but the answer to this frame is
        // the fresh catalog: rescan now so the page never shows the state from before the move.
        const count = await reloadSkills(skillsDirs(), skillRegistry);
        hooks.emit("skills:reloaded", { count });
        void log("info", `skill ${input.mode}`, {
          name: input.name,
          from: input.source,
          to: input.target.source,
          path: outcome.path,
          replaced: outcome.replaced,
        });
        return { skills: skillCatalog() };
      },
      read: async (source, name, workspace) => {
        if (source !== "built-in" && source !== "custom" && source !== "workspace") return null;
        return resolveSkillFile(
          source,
          name,
          { builtInDir: builtinDir, customDir, workspaceSkillsDir, workspaces: config.workspaces },
          workspace,
        );
      },
      workspaces: () => [
        { key: "default", path: workspacePath, default: true },
        ...Object.entries(config.workspaces ?? {}).map(([key, path]) => ({ key, path, default: false })),
      ],
    });

    // Field by field on purpose: a projection keeps a field later added to McpServerStatus from
    // reaching devices on its own, and the wiring (command, args, env, url, headers) carries
    // credentials that have no business on the wire. The declared wiring is shown (command/args/url
    // minus env/headers) so the page can display what a server is and offer add/remove/enable.
    const mcpEntries = (): MyClawAppMcpEntry[] =>
      mcpManager.status().map((s) => {
        const declared = config.mcp?.[s.name];
        return {
          name: s.name,
          transport: s.transport,
          state: s.state,
          toolCount: s.toolCount,
          ...(s.lastError ? { lastError: s.lastError } : {}),
          ...(s.lastAttemptAt ? { lastAttemptAt: s.lastAttemptAt } : {}),
          ...(declared?.enabled === false ? { enabled: false } : {}),
          ...(declared?.command ? { command: declared.command } : {}),
          ...(declared?.args ? { args: declared.args } : {}),
          ...(declared?.url ? { url: declared.url } : {}),
        };
      });
    const writeMcpEntries = async (note: string): Promise<MyClawAppMcpEntry[]> => {
      // The config watcher's mcp applier reconnects/opens connections; reload now so the answer
      // reflects the declared set, and the manager's sync lands a beat later.
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after mcp edit failed", { note, error: String(err) });
      });
      return mcpEntries();
    };
    myClawApp.onMcpController({
      list: () => mcpEntries(),
      add: async (spec) => {
        const result = await addMcpServer(spec.name, spec);
        if (!result.ok) throw new Error(result.error);
        return writeMcpEntries(`ajout mcp ${spec.name}`);
      },
      remove: async (name) => {
        const result = await removeMcpServer(name);
        if (!result.ok) throw new Error(result.error);
        return writeMcpEntries(`retrait mcp ${name}`);
      },
      setEnabled: async (name, enabled) => {
        const result = await setMcpEnabled(name, enabled);
        if (!result.ok) throw new Error(result.error);
        return writeMcpEntries(`bascule mcp ${name}`);
      },
    });

    // The full catalog as the orchestrator sees it: this is a reading surface, not a run, and an
    // agent's own view stays narrowed by getForAgent. Built-ins are read through staticNames so a
    // plugin or MCP tool that ever clashed with a built-in name cannot shadow it here either.
    // `disabled` is read live from config, so a hot-reloaded denylist edit shows up next visit.
    const toolsCatalog = (): { tools: MyClawAppToolEntry[]; missing: string[] } => {
      const disabled = new Set(config.tools?.disabled ?? []);
      const asks = new Set(config.blacklist ?? []);
      const tools: MyClawAppToolEntry[] = [];
      for (const name of toolRegistry.staticNames()) {
        const tool = toolRegistry.get(name);
        if (!tool) continue;
        tools.push({ name, description: tool.description, source: "built-in", disabled: disabled.has(name), confirm: asks.has(name) });
      }
      for (const tool of pluginLoader?.getTools() ?? []) {
        tools.push({ name: tool.name, description: tool.description, source: "plugin", disabled: disabled.has(tool.name), confirm: asks.has(tool.name) });
      }
      for (const tool of mcpManager.getTools()) {
        const server = mcpServerOf(tool.name);
        tools.push({
          name: tool.name,
          description: tool.description,
          source: "mcp",
          ...(server ? { server } : {}),
          disabled: disabled.has(tool.name),
          confirm: asks.has(tool.name),
        });
      }
      const known = new Set(tools.map((t) => t.name));
      return {
        tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
        // Denylist entries no tool carries are dead weight: flagged so the page can show and
        // clean them, exactly like an agent scope entry that matches nothing.
        missing: (config.tools?.disabled ?? []).filter((n) => !known.has(n)).sort(),
      };
    };
    const writeToolsCatalog = async (note: string): Promise<{ tools: MyClawAppToolEntry[]; missing: string[] }> => {
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after tools edit failed", { note, error: String(err) });
      });
      return toolsCatalog();
    };
    myClawApp.onToolsController({
      list: () => toolsCatalog(),
      toggle: async (name, disabled) => {
        const result = await setToolDisabled(name, disabled);
        if (!result.ok) throw new Error(result.error);
        return writeToolsCatalog(`toggle tool ${name}`);
      },
      confirm: async (name, confirm) => {
        const result = await setToolConfirm(name, confirm);
        if (!result.ok) throw new Error(result.error);
        return writeToolsCatalog(`confirm tool ${name}`);
      },
    });

    // config.workspaces is hot-reloadable, so the roots are read per call from the live config
    // rather than captured: a workspace added while the app is open must show up on the page.
    const instructionRoots = (): InstructionRoots => ({
      defaultDir: workspacePath,
      ...(config.workspaces ? { workspaces: config.workspaces } : {}),
      ...(config.workspacePrompts ? { workspacePrompts: config.workspacePrompts } : {}),
    });

    // The nested scan answers with the workspaces it had to cut, and the field is left out when
    // it cut none: an empty array on every listing would read as a state the page has to explain.
    const nestedListing = async (): Promise<{ nested: MyClawAppNestedInstruction[]; nestedTruncated?: string[] }> => {
      const scan = await scanNestedInstructions(instructionRoots());
      return { nested: scan.nested, ...(scan.truncated.length > 0 ? { nestedTruncated: scan.truncated } : {}) };
    };

    // The session is read here and the decision is taken in instructions.ts: the allowlist is a
    // property of what a session read, and it is testable without a live session manager.
    const nestedTarget = async (workspace: string, nested: string, sessionId?: string): Promise<string | null> =>
      resolveNestedTarget(
        instructionRoots(),
        workspace,
        nested,
        sessionId ? (await sessionManager.peek(sessionId))?.nestedAgents : undefined,
      );

    myClawApp.onInstructionsController({
      list: async () => ({
        entries: await listInstructions(instructionRoots()),
        ...(await nestedListing()),
        files: [...PROMPT_FILES],
        maxBytes: MAX_INSTRUCTION_BYTES,
        // File-defined agents and the layers each declares, so the app can say which agents cut a
        // layer in their own file. Default-scoped resolution: the list is global, not per-workspace.
        agentLayers: agentRegistry
          .names()
          .map((name) => ({ agent: name, layers: [...(agentRegistry.get(name, "default")?.meta.instructions ?? PROMPT_LAYERS)] }))
          .sort((a, b) => a.agent.localeCompare(b.agent)),
      }),
      read: async ({ workspace, file, nested, sessionId }) => {
        if (nested) {
          const target = await nestedTarget(workspace, nested, sessionId);
          if (!target) return null;
          const content = isAbsolute(nested)
            ? await readNestedByPath(target)
            : await readNestedInstruction(instructionRoots(), workspace, nested);
          if (content === null) return null;
          return {
            workspace,
            file: nested,
            content,
            origin: "nested" as const,
            from: workspace,
            sha: contentSha(content),
            // A nested AGENTS.md is not part of the system prompt, but it is instructions the
            // agent reads, and the owner writes them the same way they write the four files.
            editable: true,
          };
        }
        const read = await readInstruction(instructionRoots(), workspace, file ?? "");
        if (!read) return null;
        return { workspace, file: file ?? "", ...read, editable: true };
      },
      write: async ({ workspace, file, content, sha, nested, sessionId }) => {
        if (nested) {
          const target = await nestedTarget(workspace, nested, sessionId);
          if (!target) {
            return { ok: false, sha: "", conflict: false, error: `unknown nested AGENTS.md: ${nested}` };
          }
          const res = await writeNestedInstruction(target, content, sha, { workspace, file: nested });
          if (res.ok) return { ok: true, sha: res.sha, conflict: false };
          return { ok: false, sha: "", conflict: res.conflict === true, error: res.error };
        }
        const res = await writeInstruction(instructionRoots(), workspace, file ?? "", content, sha);
        if (res.ok) return { ok: true, sha: res.sha, conflict: false };
        return { ok: false, sha: "", conflict: res.conflict === true, error: res.error };
      },
      setPolicy: async (workspace, file, inherit, off) => {
        const result = await setWorkspacePromptPolicy(workspace, file, inherit, off);
        if (!result.ok) throw new Error(result.error);
        // workspacePrompts is hot: the watcher applies the section in place, so the next run --
        // and the next list -- reads the new policy with no restart.
        await reloadConfigNow?.().catch((err) => {
          void log("warn", "config reload after prompt policy edit failed", { workspace, file, error: String(err) });
        });
        return {
          entries: await listInstructions(instructionRoots()),
          ...(await nestedListing()),
          files: [...PROMPT_FILES],
          maxBytes: MAX_INSTRUCTION_BYTES,
        };
      },
    });

    // Composed on demand from the live registries, exactly as a run would: the page has to show
    // what the next message loads, so nothing here is cached and nothing is read off the last run.
    myClawApp.onSessionInstructions(async (sessionId) =>
      sessionInstructionsReport({
        session: (await sessionManager.peek(sessionId)) ?? null,
        sessionId,
        config,
        skillRegistry,
        toolRegistry,
        agentRegistry,
        platform: "my-claw-app",
      }),
    );

    // The files page (docs/files-page.md): where a conversation's tree starts, and the roots
    // fs.remove must never touch. Both live in the live config, which the channel does not hold.
    myClawApp.onFsProvider({
      sessionRoot: async (owner, threadId) => {
        const sessionId = myClawAppSessions.resolveSessionId(owner, threadId);
        const session = await sessionManager.peek(sessionId);
        // A sub-agent's own directory first: an agent pinned to a project runs there, and the
        // page has to open where its tools work. Everyone else resolves by workspace key, the
        // same resolution the run uses.
        if (session?.meta?.workspaceDir) return session.meta.workspaceDir;
        return resolveWorkspaceKey(config, session?.workspace);
      },
      protectedRoots: () => ({
        home: homedir(),
        myClawDir: MY_CLAW_DIR,
        defaultWorkspace: resolveWorkspaceDir(config.workspace),
        cwd: process.cwd(),
      }),
    });

    // The one surface without a structured editor: the raw config.json, read from disk exactly as
    // the watcher sees it. Every write goes through parseConfig first, so a structurally broken
    // file (the only class the parser catches) never reaches the disk; what survives the parser is
    // hot-reloaded by the watcher like any hand edit, and the answer reports what it applied.
    myClawApp.onConfigController({
      get: async () => {
        const raw = await readFile(CONFIG_PATH, "utf-8");
        return { content: raw, sha: contentSha(raw), maxBytes: MAX_CONFIG_BYTES };
      },
      set: async (sha, content) => {
        // Checked and written in one go with every other edit: an edit landing between the two
        // would be overwritten by a file that never saw it.
        const refused = await oneEditAtATime(async () => {
          const current = await readFile(CONFIG_PATH, "utf-8").catch(() => "");
          if (current && sha !== "" && contentSha(current) !== sha) {
            return { ok: false, sha: "", conflict: true, changed: [], rebootRequired: [], error: "changed on the server since it was opened" };
          }
          if (Buffer.byteLength(content, "utf-8") > MAX_CONFIG_BYTES) {
            return { ok: false, sha: "", conflict: false, changed: [], rebootRequired: [], error: `config too large to save (max ${MAX_CONFIG_BYTES} bytes)` };
          }
          try {
            parseConfig(content);
          } catch (err) {
            return {
              ok: false,
              sha: "",
              conflict: false,
              changed: [],
              rebootRequired: [],
              error: err instanceof Error ? err.message : String(err),
            };
          }
          const mode = await stat(CONFIG_PATH).then((s) => s.mode & 0o777, () => 0o600);
          await snapshotConfigFile(CONFIG_PATH, { origin: "pre-write", note: "avant config.set depuis l'app" });
          await writeFileAtomically(CONFIG_PATH, content, { mode });
          return null;
        });
        if (refused) return refused;
        let changed: string[] = [];
        let rebootRequired: string[] = [];
        try {
          const result = await reloadConfigNow?.();
          changed = result?.changed ?? [];
          rebootRequired = result?.rebootRequired ?? [];
        } catch (err) {
          void log("warn", "config reload after config.set failed", { error: String(err) });
        }
        return { ok: true, sha: contentSha(content), conflict: false, changed, rebootRequired };
      },
    });

    // Workspace CRUD: config.workspaces is hot-reloaded in place and the skills/agents watchers
    // re-target their tiers on change, so a mutation applies on the next run with no restart.
    // Every answer is the fresh listing, read from the live config like the skills page's.
    const workspacesEntries = (): MyClawAppWorkspaceEntry[] => [
      { key: "default", path: workspacePath, default: true },
      ...Object.entries(config.workspaces ?? {}).map(([key, path]) => ({ key, path, default: false })),
    ];
    const writeWorkspaces = async (note: string, result: ConfigEditResult): Promise<MyClawAppWorkspaceEntry[]> => {
      if (!result.ok) throw new Error(result.error);
      // The watcher's workspaces applier reloads the skills tiers; reload now so the answer
      // describes the running config, like the other config edits.
      await reloadConfigNow?.().catch((err) => {
        void log("warn", "config reload after workspaces edit failed", { note, error: String(err) });
      });
      return workspacesEntries();
    };
    myClawApp.onWorkspacesController({
      list: () => workspacesEntries(),
      add: async (key, path) => writeWorkspaces(`ajout workspace ${key}`, await addWorkspace(key, path)),
      remove: async (key) => writeWorkspaces(`retrait workspace ${key}`, await removeWorkspace(key)),
      rename: async (from, to) => writeWorkspaces(`renommage workspace ${from}`, await renameWorkspace(from, to)),
      setPath: async (key, path) => writeWorkspaces(`chemin workspace ${key}`, await setWorkspacePath(key, path)),
    });

    // The scope editors share the agents' vocabulary ("inherit"/"all"/"list"), converted to the
    // config shape the resolver reads. Model and scope names are never validated on save: the
    // job is the truth, and the listing flags what no longer exists so the app paints it red.
    const scopeToStored = (scope: MyClawAppJobScope): string[] | undefined => {
      if (scope.mode === "inherit") return undefined;
      if (scope.mode === "all") return ["*"];
      return scope.names ?? [];
    };
    const scopeToWire = (list: string[] | undefined): { mode: "inherit" | "all" | "list"; names?: string[] } => {
      if (list === undefined) return { mode: "inherit" };
      if (list.includes("*")) return { mode: "all" };
      return { mode: "list", names: list };
    };
    const deliverDisplay = (deliver: CronDeliver): string => {
      if (deliver === "local" || deliver === "origin") return deliver;
      return deliver.threadId ? `${deliver.platform}:${deliver.chatId}:${deliver.threadId}` : `${deliver.platform}:${deliver.chatId}`;
    };
    // Unknown-flag catalogs, read live so a rename that lands in the app is reflected too.
    const modelIds = (): Set<string> => new Set(modelPicker.options().map((m) => m.id));
    const workspaceKeys = (): Set<string> => new Set(Object.keys(config.workspaces ?? {}));
    const skillNames = (): Set<string> => new Set(skillRegistry.listAll().map((s) => s.name));
    const mcpNames = (): Set<string> => new Set(mcpManager.status().map((s) => s.name));
    const toolNames = (): Set<string> => new Set(toolsCatalog().tools.map((t) => t.name));

    // The conversation a job delivers to, by the title the owner sees: what the editor shows and
    // saves back. Undefined for a target that is not one of the owner's app conversations.
    const deliveryThreadTitle = async (deliver: CronDeliver): Promise<string | undefined> => {
      const sessionId = deliveryThreadOf(deliver);
      const meta = sessionId ? await readMeta(sessionId).catch(() => null) : null;
      return meta?.title?.trim() || undefined;
    };
    const jobsListing = async (): Promise<MyClawAppJobEntry[]> => {
      const jobs = await loadJobs();
      const titles = await Promise.all(jobs.map((job) => deliveryThreadTitle(job.deliver)));
      return jobs.map((job, index) => {
          const models = modelIds();
          const workspaces = workspaceKeys();
          const skills = skillNames();
          const mcp = mcpNames();
          const tools = toolNames();
          return {
            id: job.id,
            name: job.name,
            prompt: job.prompt,
            schedule: job.schedule,
            enabled: job.enabled,
            silent: job.silent === true,
            state: job.state,
            ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
            repeat: job.repeat,
            completedRuns: job.completedRuns,
            deliver: deliverDisplay(job.deliver),
            ...(job.model ? { model: job.model } : {}),
            ...(job.effort ? { effort: job.effort } : {}),
            ...(job.workspace ? { workspace: job.workspace } : {}),
            skillsMode: scopeToWire(job.skills).mode,
            ...(job.skills ? { skills: job.skills } : {}),
            mcpMode: scopeToWire(job.mcp).mode,
            ...(job.mcp ? { mcp: job.mcp } : {}),
            toolsMode: scopeToWire(job.tools).mode,
            ...(job.tools ? { tools: job.tools } : {}),
            subagents: job.subagents !== false,
            browser: job.browser !== false,
            followUp: job.followUp === true,
            ...(job.followUpPrompt ? { followUpPrompt: job.followUpPrompt } : {}),
            nextRunAt: job.nextRunAt,
            lastRunAt: job.lastRunAt,
            lastStatus: job.lastStatus === "interrupted" ? "error" : job.lastStatus,
            lastError: job.lastError,
            ...(job.lastStatus ? { lastRunStatus: job.lastStatus } : {}),
            ...(job.lastStartedAt ? { lastStartedAt: job.lastStartedAt } : {}),
            ...(job.lastDurationMs !== undefined ? { lastDurationMs: job.lastDurationMs } : {}),
            ...(job.lastModel ? { lastModel: job.lastModel } : {}),
            ...(job.lastCostUsd !== undefined ? { lastCostUsd: job.lastCostUsd } : {}),
            ...(job.lastCostPartial ? { lastCostPartial: true } : {}),
            ...(job.runningSince ? { runningSince: job.runningSince } : {}),
            ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}),
            ...runLimitsOfJob(job, titles[index], { alertAfterMs: installAlertAfterMs(), timeoutMs: config.cron?.timeoutMs }),
            createdAt: job.createdAt,
            unknownModel: job.model !== undefined && !models.has(job.model) && !isTagReference(job.model),
            unknownWorkspace: job.workspace !== undefined && !workspaces.has(job.workspace),
            unknownSkills: (job.skills ?? []).filter((name) => name !== "*" && !skills.has(name)),
            unknownMcp: (job.mcp ?? []).filter((name) => name !== "*" && !mcp.has(name)),
            unknownTools: (job.tools ?? []).filter((name) => name !== "*" && !tools.has(name)),
          };
      });
    };

    myClawApp.onJobsController({
      list: () => jobsListing(),
      save: async (fields, owner) => {
        // Only checkable against a model the job names itself: a job with no pin runs whatever the
        // cron agent resolves to that day, and the run's own clamp is what covers that case.
        if (fields.effort !== undefined && fields.effort !== "") {
          if (fields.model) assertEffortOffered(fields.model, fields.effort);
          else if (!EFFORT_LEVELS.includes(fields.effort as EffortLevel)) throw new Error(`invalid effort level: ${fields.effort}`);
        }
        // "" is a deliberate clear on update, so it must reach updateJob rather than vanish
        // as falsy; undefined means "don't touch".
        const jobEffort: EffortLevel | "" | undefined =
          fields.effort === undefined ? undefined : fields.effort === "" ? "" : (fields.effort as EffortLevel);
        const stored = {
          // undefined means "don't touch", like `effort`: an older app build does not send the
          // field, and an edit from it must not silently clear a job's silent flag.
          ...(fields.silent === undefined ? {} : { silent: fields.silent === true }),
          ...(fields.model ? { model: fields.model } : {}),
          ...(jobEffort === undefined ? {} : { effort: jobEffort }),
          ...(fields.workspace ? { workspace: fields.workspace } : {}),
          skills: scopeToStored(fields.skills),
          mcp: scopeToStored(fields.mcp),
          tools: scopeToStored(fields.tools),
          // Absent stays absent, like `silent`: an older app build does not send these, and an
          // edit from it must not silently grant or deny a capability.
          ...(fields.subagents === undefined ? {} : { subagents: fields.subagents === true }),
          ...(fields.browser === undefined ? {} : { browser: fields.browser === true }),
          ...(fields.followUp === undefined ? {} : { followUp: fields.followUp === true }),
          ...(fields.followUpPrompt === undefined ? {} : { followUpPrompt: fields.followUpPrompt }),
        };
        // Resolved before the write, like the tool does: creating a conversation must not happen
        // inside the lock. A thread is the owner's own conversation of that title.
        const before = fields.id ? (await loadJobs()).find((j) => j.id === fields.id) : undefined;
        if (fields.id && !before) throw new Error(`job not found: ${fields.id}`);
        const deliver = await deliverOfSave(fields.deliver, before, owner, fields.workspace, ensureOwnerThread);
        // In turn with the tool and the scheduler: an edit from the phone while a `cron` call
        // writes would otherwise erase one of the two -- docs/cron.md.
        await mutateJobs((jobs) => {
          if (fields.id) {
            const target = jobs.find((j) => j.id === fields.id);
            if (!target) throw new Error(`job not found: ${fields.id}`);
            // "inherit" means the field leaves the job, but updateJob reads undefined as "don't
            // touch": clearing has to happen before the update so the store's semantics stay.
            if (fields.skills.mode === "inherit") delete target.skills;
            if (fields.mcp.mode === "inherit") delete target.mcp;
            if (fields.tools.mode === "inherit") delete target.tools;
            applyRunLimits(target, fields);
            const updated = updateJob(jobs, fields.id, {
              name: fields.name,
              prompt: fields.prompt,
              schedule: fields.schedule,
              enabled: fields.enabled,
              ...(deliver === undefined ? {} : { deliver }),
              ...stored,
            });
            if (!updated) throw new Error(`job not found: ${fields.id}`);
          } else {
            // A job made from the app has no chat of origin: it delivers nowhere unless a
            // conversation is named.
            const job = createJob({ name: fields.name, prompt: fields.prompt, schedule: fields.schedule, origin: null, deliver: deliver ?? "local", ...stored });
            applyRunLimits(job, fields);
            jobs.push(job);
          }
        });
        return jobsListing();
      },
      remove: async (id) => {
        await mutateJobs((jobs) => {
          if (!removeJob(jobs, id)) throw new Error(`job not found: ${id}`);
        });
        return jobsListing();
      },
      runs: async (jobId) => {
        const jobs = await loadJobs();
        const job = jobs.find((j) => j.id === jobId);
        if (!job) throw new Error(`job not found: ${jobId}`);
        const ids = await sessionManager.listSessions(`cron/${jobId}/`, 100);
        const runs: MyClawAppJobsRunEntry[] = [];
        for (const sessionId of ids) {
          const runTs = Number(sessionId.slice(sessionId.lastIndexOf("/") + 1));
          const threadId = cronSessionToThread(sessionId);
          if (!threadId || !Number.isFinite(runTs)) continue;
          const session = await sessionManager.peek(sessionId);
          // From the log, like the thread list does. The name stays `messageCount` because a
          // shipped client reads it under that name.
          const runEntries = session ? (await sessionManager.logOf(sessionId)).entries().length : 0;
          runs.push({
            threadId,
            runAt: runTs,
            messageCount: runEntries,
            title: session?.title?.trim() || `${job.name} · ${new Date(runTs).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
          });
        }
        return runs;
      },
    });

    const apnsRelay = relayURL();
    myClawApp.onNotificationsController({
      ...(apnsRelay ? { apns: { relayURL: apnsRelay, register: (deviceId: string, registration: { registrationId: string; secret: string }) => apnsStore.register(deviceId, registration), unregister: (deviceId: string) => apnsStore.unregister(deviceId) } } : {}),
      info: () => loadOrCreateVapid().then((keys) => keys.publicKey).catch(() => undefined),
      register: (deviceId, frame) =>
        endpointStore.register(deviceId, {
          endpoint: frame.endpoint,
          pubKey: frame.pubKey,
          auth: frame.auth,
          updatedAt: new Date().toISOString(),
        }),
      unregister: (deviceId) => endpointStore.unregister(deviceId),
      setChannels: (deviceId, channels) => endpointStore.setChannels(deviceId, channels),
      setForeground: (deviceId, state) => foregroundStore.set(deviceId, state),
    });

    myClawApp.onCommandHandler(createMyClawAppCommandHandler({
      config,
      sessionManager,
      modelPicker,
      skillRegistry,
      agentRegistry,
      reloadAgents: () => reloadAgents(agentsDirs(), agentRegistry),
      builtinDir,
      customDir,
      workspaceSkillsDir,
      listCronJobs: () => loadJobs(),
      browserWindows: browserSession.windows,
      postMessage: (owner, text, threadId) => myClawApp.send(owner, { text, threadId }),
      onAuthChanged,
      accountFor,
      reloadConfigNow,
      toolRegistry,
      mcpStatus: () => mcpManager.status(),
      listSubAgents: (sessionId) => subAgentRunner.list(subAgentRegistry, sessionId),
      pricing,
      undoPrompt: askUndoMode,
      // The typed `/stop` claims through the channel's one door, like the app's Stop button:
      // the stop frame is written by the adapter alone, so neither door can answer without the
      // other hearing (docs/stop.md).
      stop: (sessionId, owner, threadId) => myClawApp.claimStop(sessionId, owner, threadId),
    }));

    // A run is either a root the registry holds a controller for, or a child the runner tracks: a
    // sub-agent spawned by the spawn tool has a mailbox in the registry and nothing else, so asking
    // the registry alone read its thread as idle -- and the app sealed and folded a run in flight.
    // Both authorities answer the same union, derived from their own work, so the callback returns
    // one outcome and nothing here has to be flattened.
    myClawApp.onStop((sessionId): StopOutcome => {
      const root = runRegistry.stop(sessionId);
      if (root !== "idle") return root;
      return subAgentRunner.stopSession(sessionId);
    });
    myClawApp.onRunActive((sessionId) => runRegistry.isRunning(sessionId) || subAgentRunner.isRunningSession(sessionId));

    // A message the app sends inside a sub-agent goes through the runner, never through a normal
    // run: see the refusal in MessageRouter.
    //
    // The caller is the conversation the app opened the sub-agent from, carried on the frame and
    // resolved here, so the runner applies the one visibility rule it already applies to the
    // `send` tool -- no second rule for this path. An absent or malformed parent yields "", which
    // isReachableFrom accepts for a global sub-agent and refuses for a private one: the fallback
    // is the safe one, not the permissive one.
    router.onSubAgentSend(async (sessionId, message, options) => {
      const frame = message.raw as { parentThreadId?: unknown } | null;
      const claimed = typeof frame?.parentThreadId === "string" ? sanitizeThreadId(frame.parentThreadId) : null;
      const callerSessionId = claimed
        ? SessionManager.resolveSessionId("my-claw-app", "dm", message.chatId, message.userId, {
            threadId: claimed,
            sessionScope: "per-user",
          })
        : "";
      return subAgentRunner.send(
        sessionId,
        // A Continue from the sub-agent's own chat adds no turn: the runner resumes it.
        message.resume ? undefined : message.text,
        message.attachments.length > 0 ? message.attachments : undefined,
        message,
        subAgentRegistry,
        callerSessionId,
        options.signal,
        options.onToken
          ? {
              onToken: options.onToken,
              onToolUse: options.onToolUse,
              onToolStart: options.onToolStart,
              onTurnSwitch: options.onTurnSwitch,
              reasoning: options.reasoning,
            }
          : undefined,
      );
    });

    if (config.browser) myClawApp.onBrowserConfig(config.browser);
    myClawApp.onBrowserSession(browserSession);

    // The install-wide statistics page. Its money is the same money `/status` shows, priced by the
    // same table, so the two screens cannot disagree about a call they both cover.
    myClawApp.onStatsController({
      report: (period, filter, folders) =>
        statsReport({
          config,
          period,
          filter,
          pricing,
          folders,
          // `read`, not `peek`: this walks every conversation that ever spent something, and most
          // of them no longer exist. `peek` caches its misses and would evict the live ones.
          sessionInfo: async (sessionId) => {
            const session = await sessionManager.read(sessionId);
            if (!session) return undefined;
            return session.title ? { title: session.title } : {};
          },
        }),
    });

    myClawApp.onSubAgentsController({
      list: async (callerSessionId) => {
        const agents = await subAgentRunner.list(subAgentRegistry, callerSessionId);
        // A sub-agent whose id yields no handle cannot be opened, so it is not offered.
        return agents.flatMap((a) => {
          const threadId = subagentSessionToThread(a.id);
          return threadId ? [{ ...a, threadId }] : [];
        });
      },
      // The handle is resolved here, and a stale one reports "not found" through the runner's own
      // guard rather than being turned into a different session id.
      kill: async (threadId, callerSessionId) => {
        const sessionId = subagentThreadToSession(threadId);
        if (!sessionId) return `Error: sub-agent ${threadId} not found.`;
        return subAgentRunner.kill(sessionId, callerSessionId);
      },
      reset: async (threadId, callerSessionId) => {
        const sessionId = subagentThreadToSession(threadId);
        if (!sessionId) return `Error: sub-agent ${threadId} not found.`;
        return subAgentRunner.reset(sessionId, callerSessionId);
      },
      callers: async (threadId, callerSessionId) => {
        const sessionId = subagentThreadToSession(threadId);
        if (!sessionId) return undefined;
        const callers = await subAgentRunner.callersOf(sessionId, callerSessionId);
        if (!callers) return undefined;
        return callers.map((c) => {
          const target = appThreadOfSession(c.sessionId);
          return {
            ...c,
            ...(target ? { threadId: target } : { unreachable: "gone" as const }),
          };
        });
      },
      handoff: async ({ threadId, callerSessionId, targets, body: handed, note, mode }) => {
        const sessionId = subagentThreadToSession(threadId);
        if (!sessionId) return targets.map((t) => ({ sessionId: t, ok: false, error: "sub-agent not found" }));
        // The reader is authorised exactly like a driver, and the list it returns is also the
        // allow-list: a target the owner could not have been shown is not a target.
        const known = await subAgentRunner.callersOf(sessionId, callerSessionId);
        if (!known) return targets.map((t) => ({ sessionId: t, ok: false, error: "sub-agent not found" }));
        const session = await sessionManager.peek(sessionId) ?? await loadSession(sessionId) ?? undefined;
        const label = session?.meta?.displayName || sessionId.slice("subagent/".length);
        const outcomes: MyClawAppSubAgentHandoffOutcome[] = [];
        // Sequential and capped: each `ask` opens a run in another conversation, and a menu tap
        // must not be able to start an unbounded fan-out.
        for (const target of targets.slice(0, MAX_HANDOFF_TARGETS)) {
          const entry = known.find((c) => c.sessionId === target);
          const appThread = appThreadOfSession(target);
          if (!entry) {
            outcomes.push({ sessionId: target, ok: false, error: "not a caller of this sub-agent" });
            continue;
          }
          if (!appThread) {
            outcomes.push({ sessionId: target, ok: false, error: "conversation is gone" });
            continue;
          }
          const body = renderHandoff(label, handed, note);
          try {
            if (mode === "note") {
              // Filed, never prompted: the journal is the display-only channel, so a note reads
              // back on reload without ever reaching a model.
              const targetSession = await sessionManager.read(target);
              if (!targetSession) {
                outcomes.push({ sessionId: target, threadId: appThread, ok: false, error: "conversation is gone" });
                continue;
              }
              const targetLog = await sessionManager.logOf(target);
              targetLog.append<CommandEntry>({
                type: "command",
                prompt: false,
                input: `handoff from ${label}`,
                output: body,
              });
              await sessionManager.persist(target);
              myClawApp.send(target.split("/")[2] ?? "", { text: body, notice: true, threadId: appThread });
              outcomes.push({ sessionId: target, threadId: appThread, ok: true });
            } else {
              const owner = ownerOfAppSession(target);
              const ok = owner ? await myClawApp.deliverOwnerTurn(owner, appThread, body) : false;
              outcomes.push({ sessionId: target, threadId: appThread, ok, ...(ok ? {} : { error: "delivery refused" }) });
            }
          } catch (err) {
            outcomes.push({ sessionId: target, threadId: appThread, ok: false, error: String(err) });
          }
        }
        for (const extra of targets.slice(MAX_HANDOFF_TARGETS)) {
          outcomes.push({ sessionId: extra, ok: false, error: `at most ${MAX_HANDOFF_TARGETS} targets at once` });
        }
        return outcomes;
      },
    });

    myClawApp.onDiagnostics({
      snapshot: async (owner, threadId) => {
        const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, { threadId, sessionScope: "per-user" });
        const session = await sessionManager.peek(sessionId);
        const resolved = resolveLlmConfig(config.llm, session?.modelOverride);
        return buildDiagnostics({
          config,
          liveChannels: [...liveChannels],
          model: {
            id: resolved.model,
            ...(resolved.vision === undefined ? {} : { vision: resolved.vision }),
            ...(resolved.backend ? { backend: resolved.backend } : {}),
          },
          ...(session
            ? {
                session: {
                  id: session.id,
                  messages: (await sessionManager.logOf(session.id)).entries().length,
                  lastActiveAt: session.lastActiveAt,
                  ...(session.modelOverride ? { model: session.modelOverride } : {}),
                },
              }
            : {}),
        });
      },
      logs: async (query) => {
        const entries = await readLogEntries(query as Parameters<typeof readLogEntries>[0]);
        return { text: formatLogEntries(entries, collectSecrets(config)), lines: entries.length };
      },
    });

    // The header shows how full the window is, and that moves at every turn. Both engines say when
    // their measurement lands, so the share follows the run instead of freezing at what it was when
    // the run started. Includes the turns that call no tool, which is most of the short ones.
    hooks.on("session:context:measured", ({ sessionId }) => myClawApp.notifyModelStateForSession(sessionId));
    // A compaction moves the boundary with no turn behind it, so nothing would move the figure
    // until the next run: a thread the owner just compacted would keep showing it full.
    hooks.on("session:compact:finished", ({ sessionId }) => myClawApp.notifyModelStateForSession(sessionId));
    // The status page follows the conversation live: every event that moves its report names the
    // session it happened in, and the page open on it (or on the conversation it bills to) is
    // pushed a fresh one. The recorded call is what moves the money; the run events move the
    // live tree; the compaction moves the context. Sub-agent runs report through the same hooks,
    // under their own session id, which is how the parent's page sees its delegated spend grow.
    hooks.on("analytics:call:recorded", ({ sessionId, parentSessionId }) => myClawApp.statusChanged(sessionId, parentSessionId));
    hooks.on("agent:run:start", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    hooks.on("agent:run:finish", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    hooks.on("agent:run:aborted", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    hooks.on("agent:run:error", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    hooks.on("session:compact:start", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    hooks.on("session:compact:finished", ({ sessionId }) => myClawApp.statusChanged(sessionId));
    // One to two minutes of silence, and until now the only surface that showed them was the
    // placeholder bubble on the device that typed `/compact`: every other window, and that same
    // window after a reload, saw a thread doing nothing. The state is raised by the summarizer
    // itself, so the automatic gates announce themselves exactly like the command does, and the
    // `settled` end is the one event no exit path can skip (docs/compaction.md).
    hooks.on("session:compact:start", ({ sessionId }) => myClawApp.notifyCompacting(sessionId, Date.now()));
    // The summary being written, live. Batched at the source: one frame per token would be a wall
    // of them for text the owner may not be reading.
    hooks.on("session:compact:progress", ({ sessionId, text }) => myClawApp.notifyCompactionProgress(sessionId, text));
    hooks.on("session:compact:reasoning", ({ sessionId, text }) => myClawApp.notifyCompactionReasoning(sessionId, text));
    hooks.on("session:compact:settled", ({ sessionId }) => myClawApp.notifyCompacting(sessionId, undefined));

    // The roster is pull-only by default; a lifecycle event pushes a fresh `subagents.list.result`
    // so every window of the parent conversation gains/updates/loses the row live instead of
    // waiting for the next request (or the run-end refetch). spawn/complete also feed the per-run
    // spawn-card subscription above; this one is the always-on safety net that never blocks.
    for (const ev of ["subagent:spawn", "subagent:complete", "subagent:error", "subagent:aborted", "subagent:killed", "subagent:reset"] as const) {
      hooks.on(ev, (payload: { parentSessionId: string; callerSessionId?: string }) => {
        if (payload.parentSessionId) void myClawApp.notifyRoster(payload.parentSessionId);
        if (payload.callerSessionId && payload.callerSessionId !== payload.parentSessionId) {
          void myClawApp.notifyRoster(payload.callerSessionId);
        }
      });
    }

    myClawApp.onMessage(async (msg) => withRunContext({ platform: "my-claw-app" }, async () => {
      let response: RouteResult | undefined;
      try {
        await agent.preprocessMessage(msg);
        const transcripts = agent.transcriptsOf(msg.id);
        const echoes = agent.getEchoMessages(msg.id);
        if (transcripts.length > 0) {
          // The app owns the rendering: it puts the words inside the voice bubble they belong to.
          // The echo messages are dropped here, since they would repeat the same text as a
          // standalone turn -- warnings from failed takes have no transcript and still come through.
          myClawApp.sendTranscript(msg.chatId, msg.threadId ?? "default", msg.id, transcripts);
        } else {
          for (const echo of echoes) {
            await myClawApp.send(msg.chatId, { ...echo, replyToId: msg.id, threadId: msg.threadId });
          }
        }

        // The run's start and end reach the app from the router's lifecycle hooks (registered
        // above), not from here: this handler runs once per message, and a message that lands
        // mid-run is folded into the run in flight rather than opening one of its own.
        try {
          if (myClawApp.streamingEnabled()) {
            // The streamer owns the output bubble for the whole run; a mid-run injected message
            // finalizes it and opens a fresh bubble replying to that message.
            let active = myClawApp.createStreamer(msg);
            const runSessionId = SessionManager.resolveSessionId("my-claw-app", "dm", msg.chatId, msg.userId, { threadId: msg.threadId, sessionScope: "per-user" });
            // The bubbles this run paints in, so the phases the recorder writes are appended under
            // the ids already on screen -- docs/bubble-identity.md. Read through `active`, which a
            // mid-run injection replaces: the sink must follow the bubble that is open now.
            setRunBubbles(runSessionId, { take: () => active.take(), errorBubble: () => active.errorBubble() });
            // Live tool output (bash) is a global hook; route each chunk to the streamer of the
            // session that produced it. A sub-agent's chunks carry its own session id, so matching
            // the root alone silently dropped them and a long command in a child ran blind.
            const onProgress = ({ toolCallId, sessionId, chunk }: { toolCallId: string; sessionId: string; chunk: { stdout?: string; stderr?: string } }): void => {
              if (sessionId === runSessionId) {
                void active.appendToolProgress(toolCallId, chunk);
                return;
              }
              // Only a child this run is showing: another run's sub-agent paints in its own window.
              if (!subAgentContexts.has(sessionId)) return;
              void subAgentStreamers.get(sessionId)?.appendToolProgress(toolCallId, chunk);
            };
            hooks.on("tool:execute:progress", onProgress);


            // Sub-agent lifecycle is also a global hook; route this run's spawns to its streamer so
            // the spawn card lives where the parent run paints. rosterEverywhere runs one shared
            // subscription registered once at boot (see below), so nothing here broadcasts twice.
            const subAgentContexts = new Map<string, UnifiedMessage>();
            const streamSubAgent = (ev: { id: string }, context: UnifiedMessage): void => {
              const threadId = subagentSessionToThread(ev.id);
              if (!threadId) return;
              // The child's thread is a conversation the app can open (docs/subagent-navigation.md),
              // so its run is announced like any other: that is what opens the journal a window
              // reloading on it is replayed from, and what gives it a Stop.
              myClawApp.notifyRun(context.chatId, threadId, true);
              const streamer = myClawApp.createStreamer({
                ...context,
                id: `subagent-${ev.id}`,
                threadId,
                text: "",
              });
              subAgentStreamers.set(ev.id, streamer);
              subAgentContexts.set(ev.id, context);
              // Keyed by the child's own session: unkeyed, the parent's phases would claim the
              // bubbles its child opened.
              setRunBubbles(ev.id, { take: () => subAgentStreamers.get(ev.id)?.take() ?? [] });
              // The boot-level stream provider has no thread to paint in; this is how a steered
              // child opens its next bubble in the right place.
              subAgentStreamRenew.set(ev.id, (injected) => myClawApp.createStreamer({
                ...context,
                ...(injected.id ? { id: injected.id } : {}),
                threadId,
                text: "",
              }));
            };
            const settleSubAgentStream = (ev: { id: string; status: "complete" | "error" | "aborted"; error?: string; resultLength?: number }): void => {
              const streamer = subAgentStreamers.get(ev.id);
              if (streamer) {
                subAgentStreamers.delete(ev.id);
                if (ev.status === "complete") void streamer.finish();
                else void streamer.abort(ev.error);
              }
              const context = subAgentContexts.get(ev.id);
              const threadId = subagentSessionToThread(ev.id);
              if (context && threadId) {
                myClawApp.notifyRun(context.chatId, threadId, false, ev.status === "complete" ? "done" : ev.status);
              }
              subAgentContexts.delete(ev.id);
              subAgentStreamRenew.delete(ev.id);
            };
            const parentStreamer = (parentSessionId: string): MyClawAppStreamer | undefined =>
              parentSessionId === runSessionId
                ? active
                : subAgentContexts.has(parentSessionId) ? subAgentStreamers.get(parentSessionId) : undefined;
            const onSubagentSpawn = (ev: { id: string; displayName: string; type: string; mode: string; parentSessionId: string; toolCallId?: string; action: "spawn" | "send" }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              const context = ev.parentSessionId === runSessionId ? msg : subAgentContexts.get(ev.parentSessionId);
              if (!owner || !context) return;
              void owner.appendSpawnStart({ subagentId: ev.id, displayName: ev.displayName, type: ev.type, mode: ev.mode, action: ev.action, ...(ev.toolCallId ? { toolCallId: ev.toolCallId } : {}) });
              streamSubAgent(ev, context);
            };
            const onSubagentComplete = (ev: { id: string; resultLength: number; parentSessionId: string; toolCallId?: string }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              if (!owner) return;
              void owner.appendSpawnEnd({ subagentId: ev.id, status: "complete", resultLength: ev.resultLength });
              settleSubAgentStream({ id: ev.id, status: "complete", resultLength: ev.resultLength });
            };
            const onSubagentError = (ev: { id: string; error: unknown; parentSessionId: string; toolCallId?: string }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              if (!owner) return;
              const error = String(ev.error);
              void owner.appendSpawnEnd({ subagentId: ev.id, status: "error", error });
              settleSubAgentStream({ id: ev.id, status: "error", error });
            };
            const onSubagentAborted = (ev: { id: string; parentSessionId: string; toolCallId?: string }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              if (!owner) return;
              void owner.appendSpawnEnd({ subagentId: ev.id, status: "aborted" });
              settleSubAgentStream({ id: ev.id, status: "aborted" });
            };
            const onSubagentKilled = (ev: { id: string; parentSessionId: string }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              if (!owner) return;
              void owner.appendSpawnEnd({ subagentId: ev.id, status: "aborted", error: "sub-agent killed" });
              settleSubAgentStream({ id: ev.id, status: "aborted", error: "sub-agent killed" });
            };
            const onSubagentReset = (ev: { id: string; parentSessionId: string }): void => {
              const owner = parentStreamer(ev.parentSessionId);
              if (!owner) return;
              void owner.appendSpawnEnd({ subagentId: ev.id, status: "aborted", error: "sub-agent reset" });
              settleSubAgentStream({ id: ev.id, status: "aborted", error: "sub-agent reset" });
            };
            hooks.on("subagent:spawn", onSubagentSpawn);
            hooks.on("subagent:complete", onSubagentComplete);
            hooks.on("subagent:error", onSubagentError);
            hooks.on("subagent:aborted", onSubagentAborted);
            hooks.on("subagent:killed", onSubagentKilled);
            hooks.on("subagent:reset", onSubagentReset);
            hooks.emit("stream:start", { platform: "my-claw-app", chatId: msg.chatId });
            try {
              response = await routeWithReroute(router, msg, {
                onToken: (token) => active.push(token),
                onToolUse: (tools, verbose) => active.appendToolUse(tools, verbose),
                onToolStart: (call) => active.appendToolStart([call]),
                // Only this channel builds a sink, which is what
                // keeps them free of reasoning -- docs/reasoning-visibility.md.
                reasoning: runReasoningSink(() => active),
                onTurnSwitch: async (injMsg) => {
                  // The run drained a queued injection at this turn boundary: this is the real
                  // "injected" moment, not the enqueue. Emit before the new streamer opens so
                  // the app lifts the "queued for the next turn" mark in lockstep with the run.
                  const injSessionId = SessionManager.resolveSessionId("my-claw-app", "dm", injMsg.chatId, injMsg.userId, { threadId: injMsg.threadId, sessionScope: "per-user" });
                  hooks.emit("message:injected", { message: injMsg, sessionId: injSessionId });
                  await active.finish();
                  active = myClawApp.createStreamer(injMsg);
                },
              });
              await active.finish();
              hooks.emit("stream:finish", { platform: "my-claw-app", chatId: msg.chatId });
            } catch (err) {
              // A stop carries no text of its own. It is the owner's doing, the command that made it
              // already answered him, and its message ("Run aborted by user") printed once per
              // streamer the stop settles -- one for the run, one for every message folded into it.
              // A message folded into a run that died learns the error but does not print it: the
              // run's own streamer already did, in the bubble the error interrupted.
              await active.abort(isAbort(err) || err instanceof FoldedRunError ? undefined : briefError(err));
              hooks.emit("stream:abort", { platform: "my-claw-app", chatId: msg.chatId, error: err });
              throw err;
            } finally {
              hooks.off("tool:execute:progress", onProgress);
              hooks.off("subagent:spawn", onSubagentSpawn);
              hooks.off("subagent:complete", onSubagentComplete);
              hooks.off("subagent:error", onSubagentError);
              hooks.off("subagent:aborted", onSubagentAborted);
              hooks.off("subagent:killed", onSubagentKilled);
              hooks.off("subagent:reset", onSubagentReset);
              for (const [id, context] of subAgentContexts) {
                const streamer = subAgentStreamers.get(id);
                subAgentStreamers.delete(id);
                subAgentStreamRenew.delete(id);
                if (streamer) void streamer.abort("parent run ended");
                const threadId = subagentSessionToThread(id);
                if (threadId) myClawApp.notifyRun(context.chatId, threadId, false, "aborted");
              }
              subAgentContexts.clear();
            }
          } else {
            response = await routeWithReroute(router, msg, {});
          }
        } catch (err) {
          // The error was a stream frame and nothing else, so the next history page erased it and
          // the thread reopened on a question with nothing under it. Journalled here, where the
          // text is the one the bubble showed. An abort needs no entry: it is the owner's own
          // doing and the partial answer is kept in the mirror. A message folded into the run
          // that died is not its reporter either: the run's own message journals the failure once.
          if (!isAbort(err) && !(err instanceof FoldedRunError)) {
            // Under the id of the bubble the owner is looking at, when a streamer painted one: the
            // entry and the bubble are then one identity, and the next page replaces it in place
            // instead of drawing the same error a second time at the end of the thread
            // (docs/bubble-identity.md).
            const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", msg.chatId, msg.userId, { threadId: msg.threadId, sessionScope: "per-user" });
            await myClawApp.recordFailure(msg.chatId, msg.threadId ?? DEFAULT_THREAD, briefError(err), runErrorBubble(sessionId));
            // The one place that holds both the error and the conversation: a spent quota with a
            // published reset arms the session's wait, anything else cancels one (docs/quota-retry.md).
            await myClawApp.settleQuotaRetry(msg.chatId, msg.threadId ?? DEFAULT_THREAD, err);
          }
          throw err;
        }

        if (response) {
          const outGate = await hooks.check("gate:message:outgoing", { platform: "my-claw-app", chatId: msg.chatId, text: response.text });
          if (outGate.allowed) {
            const refs = extractMediaRefs(response.text);
            const textHasMediaRefs = refs.length > 0;
            if (!myClawApp.streamingEnabled()) {
              const deliveryText = (await hooks.transform("transform:outgoing:message", { text: response.text, platform: "my-claw-app", chatId: msg.chatId })).text;
              await myClawApp.send(msg.chatId, {
                text: deliveryText,
                attachments: textHasMediaRefs ? undefined : response.attachments,
                replyToId: msg.id,
                threadId: msg.threadId,
              });
              hooks.emit("message:delivered", { platform: "my-claw-app", chatId: msg.chatId, text: deliveryText, attachments: (response.attachments?.length ?? 0) });
            } else if (!textHasMediaRefs && response.attachments?.length) {
              await myClawApp.send(msg.chatId, { text: "", attachments: response.attachments, replyToId: msg.id, threadId: msg.threadId });
              hooks.emit("message:delivered", { platform: "my-claw-app", chatId: msg.chatId, text: "", attachments: response.attachments.length });
            } else if (textHasMediaRefs) {
              const mediaAttachments = refs.map((ref) => ({ type: mediaTypeForPath(ref.path), path: ref.path }));
              await myClawApp.send(msg.chatId, { text: "", attachments: mediaAttachments, replyToId: msg.id, threadId: msg.threadId });
              hooks.emit("message:delivered", { platform: "my-claw-app", chatId: msg.chatId, text: "", attachments: mediaAttachments.length });
            }
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
        await cleanupGeneratedTempFiles(response?.attachments);
      }
    }));

    // A run stores what its tools produced *before* it writes its end marker: the log never
    // rewrites an entry, so the marker is only useful if it is born naming the copy a device will
    // fetch. The channel owns the bytes, so it is the channel that stores them -- and a sub-agent's
    // run stores into the thread of the conversation that asked for it (2026-09-15).
    router.setMediaStore(async (sessionId, path) => await myClawApp.storeRunMedia(sessionId, path));
    subAgentRunner.setMediaStore(async (sessionId, path) => await myClawApp.storeRunMedia(sessionId, path));

    // The only surface left that can answer an approval prompt. Without this the gate has no
    // handler at all and every approval-required tool is denied on sight.
    router.setApprovalHandler(async (request) => {
      if (request.platform === "my-claw-app") {
        return await myClawApp.confirmTool(request);
      }
      return "deny";
    });

    try {
      await myClawApp.start();
      adapters.push(myClawApp);
      hooks.emit("channel:started", { platform: "my-claw-app" });
    } catch (err) {
      log("error", "my-claw-app adapter failed to start", { error: String(err) });
      hooks.emit("channel:error", { platform: "my-claw-app", error: err });
    }
  };
  await startMyClawAppChannel();
  if (myClawAppRef) cronScheduler.adapters.set("my-claw-app", myClawAppRef);
  // A job with `followUp` hands its report to the conversation as the owner's next turn, through
  // the same door as a sub-agent's hand-back: a conversation at rest opens a run, one in flight
  // parks it in its mailbox (docs/cron.md).
  cronScheduler.handOver = async (target, text) =>
    myClawAppRef ? myClawAppRef.deliverOwnerTurn(target.chatId, target.threadId ?? "default", text) : false;
  // A delivered result goes into the conversation's history, so it reads back on reload and reaches
  // a phone that was asleep, and into its context: asked about the report afterwards, the
  // conversation's agent has read it (owner, 2026-10-05). Filed, not handed over: nothing runs.
  cronScheduler.journal = async (target, text) => {
    const sessionId = SessionManager.resolveSessionId("my-claw-app", "dm", target.chatId, target.chatId, {
      threadId: target.threadId ?? "default",
      sessionScope: "per-user",
    });
    await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm");
    const threadLog = await sessionManager.logOf(sessionId);
    threadLog.append<CommandEntry>({ type: "command", prompt: true, input: "cron delivery", output: text, quiet: true });
    await sessionManager.persist(sessionId);
  };

  cronScheduler.start();
  configWatcher = startConfigWatcher(config, {
    modelPicker,
    // On an llm config edit, re-snapshot the curated base and re-merge discovered models
    // (config.llm.models was just reset to the disk value by the watcher).
    syncModels: () => {
      baseModels = [...(config.llm.models ?? [])];
      applyModelCatalog();
      void modelCatalog.refresh();
    },
    // Deferred, and read at call time: the snapshot builder only exists once the channel has
    // started, and the frame must describe the config the watcher has just landed.
    pushAgentsConfig: () => queueMicrotask(() => pushAgentsConfig?.()),
    registerWebSearch,
    syncMcp: (mcp) => void mcpManager.sync(mcp),
    reloadCron: () => cronScheduler.restart(),
    reloadMemory: (memory) => void reloadMemoryEmbedding(memory),
    reloadSkills: () => void reloadSkills(skillsDirs(), skillRegistry).then((count) => {
      void log("info", "skills reloaded from config change", { count });
    }).then(() => reloadAgents(agentsDirs(), agentRegistry)).then((count) => {
      // A workspace added to config.workspaces brings a `agents` tier with it, so the two
      // registries have to follow the same config change or the new workspace has skills and
      // no agents until the next restart.
      void log("info", "agents reloaded from config change", { count });
    }).catch((err) => {
      // The reload appliers are called detached, so a rejection here reaches the process-level
      // unhandledRejection handler and shuts the daemon down over an unreadable skill directory.
      void log("error", "skills/agents reload from config change failed", { error: String(err) });
    }),
  });

  const stopSkillsWatcher = startSkillsWatcher(
    skillsDirs(),
    skillRegistry,
    {
      getTierDirs: () => editableTierDirs(skillsDirs()),
      reload: () => reloadSkills(skillsDirs(), skillRegistry),
    },
  );

  const stopAgentsWatcher = startAgentsWatcher(
    agentsDirs(),
    agentRegistry,
    {
      getTierDirs: () => editableAgentTierDirs(agentsDirs()),
      reload: () => reloadAgents(agentsDirs(), agentRegistry),
    },
  );

  // Opt-in tool-code plugins. Created after all built-ins are registered so the collision
  // check knows the reserved names. The composed dynamic provider (set above) picks them up.
  if (config.tools?.pluginsEnabled) {
    pluginLoader = new PluginLoader(join(MY_CLAW_DIR, "tools.d"), new Set(toolRegistry.staticNames()));
    await pluginLoader.start();
    log("info", "tool plugins enabled", { count: pluginLoader.getTools().length });
  }

  log("info", "my-claw started", { channels: Object.keys(config.channels) });
  hooks.emit("app:ready", { channels: Object.keys(config.channels) });

  // The whole point of reverting is that the owner can reach the agent again, so the reason has to
  // arrive in the chat. Addressed to the app owner, the only surface left.
  if (fallback) {
    const owner = appOwner();
    if (owner && myClawAppRef) {
      void myClawAppRef
        .send(owner, {
          text: [
            "Attention : j'ai démarré sur une sauvegarde de config.",
            `Raison : ${fallback.error}`,
            `Version restaurée : \`${fallback.ref}\``,
            "Ton fichier n'a pas été modifié. Corrige-le puis sauvegarde : toute modification lève la quarantaine.",
            "Voir `/config history config.json` et `/config diff config.json`.",
          ].join("\n"),
        })
        .catch(() => {});
    }
  }

  // Same best-effort delivery as the fallback alert above. A silently reduced scope is worth a
  // message because the symptom is an agent that just stops using a skill.
  if (unknownScopes.length > 0) {
    const owner = appOwner();
    if (owner && myClawAppRef) {
      const lines = unknownScopes.map(
        (e) => `- \`${e.path}\`: "${e.name}" (${e.kind === "skill" ? "aucune skill de ce nom" : "aucun serveur declare"})`,
      );
      void myClawAppRef
        .send(owner, {
          text: [
            "Attention : des noms de scope ne correspondent a rien.",
            ...lines,
            "Ces agents tournent avec un scope reduit. `agents` est une section hot : corrige puis sauvegarde.",
          ].join("\n"),
        })
        .catch(() => {});
    }
  }

  // Health gate: "it parsed" is not "it works". A config that boots and then dies must never become
  // the thing we fall back to, or the safety net records the trap. Surviving 60s past a completed
  // boot is the evidence, mirroring update.sh waiting for the service to be healthy before keeping
  // a new version. Snapshots of files that never ran stay unconfirmed and thus never auto-restore.
  const confirmTimer = setTimeout(() => void confirmHealthyConfig(), HEALTH_GATE_MS);
  confirmTimer.unref?.();

  const activeChannels: string[] = [];
  if (myClawAppRef) activeChannels.push("my-claw-app");

  const shutdown = async (signal = "SIGINT") => {
    log("info", "shutting down...", { signal });
    hooks.emit("app:shutdown", { signal });
    clearTimeout(confirmTimer);
    configWatcher.stop();
    stopSkillsWatcher();
    stopAgentsWatcher();
    pluginLoader?.stop();
    await mcpManager.stop().catch(() => undefined);
    cronScheduler.stop();
    clearInterval(modelCatalogTimer);
    if (memoryPurgeTimer) clearInterval(memoryPurgeTimer);
    clearInterval(shadowGcTimer);
    for (const ch of activeChannels) hooks.emit("channel:stopped", { platform: ch });
    await Promise.allSettled(adapters.map((a) => a.stop()));
    // After the adapters, so nothing can append behind the write, and before the exit: a cached
    // session that never reached the disk is a conversation the owner loses for good.
    sessionManager.stopAutosave();
    await sessionManager.flushAll().catch((err) => log("error", "session flush failed", { error: String(err) }));
    closeDb();
    closeMemoryDb();
    process.exit(0);
  };

  // Exits cleanly and lets the supervisor bring us back: Restart=always restarts on a clean exit
  // too, so there is no need to fake a failure code. Only ever called when a better config exists.
  restartForHealth = async (reason: string): Promise<void> => {
    await shutdown(`config-health:${reason}`);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  let shutdownTriggered = false;
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandled rejection", { error: String(reason) });
    hooks.emit("app:error", { error: reason, type: "rejection" });
    if (!shutdownTriggered) {
      shutdownTriggered = true;
      void shutdown().finally(() => process.exit(1));
    }
  });
  process.on("uncaughtException", (err) => {
    log("error", "uncaught exception", { error: String(err), stack: err?.stack });
    hooks.emit("app:error", { error: err, type: "exception" });
    if (!shutdownTriggered) {
      shutdownTriggered = true;
      void shutdown().finally(() => process.exit(1));
    }
  });
}

function initMemory(config: MyClawConfig): ReturnType<typeof setInterval> | undefined {
  if (config.memory?.enabled === false) return undefined;
  const memCfg = config.memory;

  void (async () => {
    try {
      await migrateLegacyFiles(memCfg);
      await importHandEdits(memCfg);
      purgeOldMemory(memCfg);
      await exportToMarkdown();
      // Preload embeddings without blocking boot; recall falls back to FTS5 until ready.
      // Once ready, backfill vectors for entries stored while FTS5-only.
      await warmupEmbedding(memCfg?.embedding);
      const n = await backfillEmbeddings(memCfg);
      if (n > 0) void log("info", "memory embeddings backfilled", { embedded: n });
    } catch (err) {
      void log("warn", "memory init failed", { error: String(err) });
    }
  })();

  if (memCfg?.consolidation?.enabled !== false) {
    const every = memCfg?.consolidation?.every ?? 20;
    const caller: LlmCaller = async (system, user) => {
      const llmCfg = resolveUtilityLlmConfig(config.llm, memCfg?.consolidation?.model);
      // Housekeeping belongs to no conversation, but a gateway routing on the session key still
      // wants one, and this job is stable enough to be its own -- docs/session-affinity.md.
      llmCfg.cacheKey ??= "my-claw:memory-consolidation";
      // Streamed, for the same reason the compaction summarizer is: a transport's budget is
      // "time with not one byte received", so a one-shot call turns it into a hard ceiling on the
      // whole generation -- 120 s on an OpenAI-compatible endpoint, whatever the work. The tokens
      // themselves are not wanted here, only the answer read out of them.
      const res = await llmCompleteStream(llmCfg, [
        { role: "system", content: system },
        { role: "user", content: user },
      ], () => {});
      return res.content;
    };
    let storeCount = 0;
    let running = false;
    hooks.on("memory:store", () => {
      storeCount += 1;
      if (storeCount >= every && !running) {
        storeCount = 0;
        running = true;
        // A rejection here (e.g. a SQLite error in supersedeEntry) would otherwise reach the
        // process-level unhandledRejection handler and shut the whole assistant down.
        void consolidateMemory(caller, memCfg)
          .catch((err) => { void log("error", "memory consolidation failed", { error: String(err) }); })
          .finally(() => {
            running = false;
          });
      }
    });
  }

  return setInterval(() => purgeOldMemory(memCfg), DAY_MS);
}

// Applier for a hot-reloaded `memory` section. Recall knobs are read live per call, so the
// only side effect needed is re-warming the embedding model: cheap when unchanged (warmup is
// cached by model name and backfill only re-embeds rows whose stored model signature differs).
async function reloadMemoryEmbedding(memory: MyClawConfig["memory"]): Promise<void> {
  if (memory?.enabled === false) return;
  try {
    await warmupEmbedding(memory?.embedding);
    const n = await backfillEmbeddings(memory);
    if (n > 0) void log("info", "memory embeddings re-backfilled after config reload", { embedded: n });
  } catch (err) {
    void log("warn", "memory reload failed", { error: String(err) });
  }
}

function registerCoreTools(registry: ToolRegistry, config: MyClawConfig): void {
  // `bash` builds its child environment by name, not by inheritance: the process holds every
  // provider key and the model writes the commands.
  setBashEnvPassthrough(config.tools?.bashEnvPassthrough);
  setBashLimits(config.tools?.bash);
  for (const tool of [bashTool, readTool, writeTool, applyPatchTool, fetchTool, searchTool, lsTool, createMemoryTool(config), createConversationSearchTool(), createQuestionTool()]) {
    registry.register(tool);
  }
}

function registerVoiceTools(registry: ToolRegistry, stt: SttPipeline, tts: TtsPipeline, voice: VoiceManager): void {
  registry.register(createAudioTool({ stt, tts, manager: voice }));
}

function registerSubAgentTools(
  registry: ToolRegistry, runner: SubAgentRunner, subRegistry: SubAgentRegistry, config: MyClawConfig,
  agentRegistry: AgentRegistry, browserSession: BrowserSession,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
): void {
  // Both lists are read live: the spawn schema is rebuilt per run, so an agent file dropped in
  // `agents/` is spawnable on the next message without a restart.
  registry.register(createSpawnTool(
    runner,
    subRegistry,
    () => spawnModelIds(config),
    () => agentRegistry.list(),
    streamProvider,
  ));
  registry.register(createSendTool(runner, subRegistry, streamProvider));
  // The browser is a sub-agent like the others, reached through its own door rather than `spawn`:
  // one shared Chromium, one task at a time (docs/browser.md).
  registry.register(createDelegateBrowserTool(config, runner, subRegistry, browserSession, streamProvider));
  registry.register(createAgentsTool(runner, subRegistry));
}

function registerSkillTools(
  registry: ToolRegistry, skillRegistry: SkillRegistry, config: MyClawConfig,
  builtinDir: string, customDir: string, workspaceSkillsDir: string,
  sessionManager: SessionManager,
): void {
  // config is the live object mutated in place by the hot-reload appliers, so a scope edit takes
  // effect on the next tool call without re-registering anything.
  registry.register(createSkillsTool(skillRegistry, config, { builtinDir, customDir, workspaceSkillsDir }, sessionManager));
}

// CLI subcommands for the Codex (ChatGPT subscription) backend. Device-code login is the only
// flow: it needs no local browser, so it works over SSH on the headless VPS. See
// docs/codex-backend.md.
/**
 * The account a CLI subcommand acts on: `--provider <key>`, else the first one of its kind in the
 * config on disk, else the key `/codex` and `/claude` would declare (docs/subscription-accounts.md).
 */
async function cliAccount(
  kind: AccountKind,
  args: string[],
): Promise<{ account: string; rest: string[]; declare: () => Promise<boolean> }> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, "utf-8").catch(() => "{}")) as Partial<MyClawConfig>;
  const providers = raw.llm?.providers ?? {};
  const at = args.indexOf("--provider");
  const named = at >= 0 ? args[at + 1] : undefined;
  const rest = named ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  const account =
    named ?? subscriptionProviders(providers).find((a) => a.kind === kind)?.key ?? freeProviderKey(providers, PLAN_PROVIDER[kind].key);
  // Declared once the sign-in is stored, never before: the server reloads on the write and must
  // find the file already there. A sign-in on a provider nobody declared would never be offered.
  const declare = async (): Promise<boolean> => {
    if (account in providers) return true;
    const { type, group } = PLAN_PROVIDER[kind];
    // A key of the owner's choosing (`--provider work`) names the account in the picker too.
    const written = await upsertProvider(account, { type, discover: true, group: named ?? freeProviderName(providers, group) });
    if (!written.ok) {
      console.error(`Signed in, but provider "${account}" could not be added to config.json: ${written.error}`);
      return false;
    }
    console.log(`Provider "${account}" added to config.json.`);
    return true;
  };
  return { account, rest, declare };
}

async function runCodexCli(argv: string[]): Promise<number> {
  const { account, rest: args, declare } = await cliAccount("codex", argv);
  const cmd = args[0];
  if (cmd === "login") {
    try {
      const cred = await codexLoginDeviceCode(account, (prompt) => {
        console.log("\nTo authorize my-claw with your ChatGPT account:");
        console.log(`  1. Open: ${prompt.verificationUri}`);
        console.log(`  2. Enter code: ${prompt.userCode}`);
        console.log(`\nWaiting for approval (expires in ${Math.round(prompt.expiresInSeconds / 60)} min)...`);
      });
      console.log(`\nLogged in as provider "${account}". ChatGPT account id: ${cred.accountId}`);
      return (await declare()) ? 0 : 1;
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "status") {
    const cred = await loadCodexCredential(account);
    if (!cred) {
      console.log(`Provider "${account}" is not logged in. Run: my-claw codex login`);
      return 1;
    }
    const mins = Math.round((cred.expires - Date.now()) / 60000);
    console.log(`Logged in. account id: ${cred.accountId}`);
    console.log(`Access token ${mins > 0 ? `expires in ~${mins} min` : "expired (will refresh on next use)"}.`);
    return 0;
  }
  if (cmd === "logout") {
    await codexLogout(account);
    console.log(`Logged out of ChatGPT (provider "${account}").`);
    return 0;
  }
  console.log("Usage: my-claw codex <login|status|logout> [--provider <key>]");
  return cmd ? 1 : 0;
}

// CLI subcommands for the Claude (subscription) backend. `login` wraps the official
// `claude setup-token` (browser/TTY); `set-token` stores a token generated anywhere. Tokens live
// in ~/.my-claw/accounts/<provider>.json and are injected per run by the Anthropic transport.
async function runClaudeCli(argv: string[]): Promise<number> {
  const { account, rest: args, declare } = await cliAccount("claude", argv);
  const cmd = args[0];
  if (cmd === "login") {
    const r = await runClaudeSetupToken(account);
    console.log(`\n${r.message}`);
    if (!r.ok) return 1;
    return (await declare()) ? 0 : 1;
  }
  if (cmd === "set-token") {
    const token = args.slice(1).join(" ").trim();
    if (!token) {
      console.log("Usage: my-claw claude set-token <token>   (generate one with: claude setup-token)");
      return 1;
    }
    try {
      await setClaudeToken(account, token);
      console.log(`Claude token stored for provider "${account}".`);
      return (await declare()) ? 0 : 1;
    } catch (err) {
      console.error(`Failed to store token: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "status") {
    const st = await claudeTokenStatus(account);
    if (!st.present) {
      console.log("Not logged in to Claude. Run: my-claw claude login");
      return 1;
    }
    const life = st.expiresInMin === undefined ? "" : `, access token ${st.expiresInMin > 0 ? `valid ~${st.expiresInMin} min` : "expired (refreshed on the next call)"}`;
    console.log(`Logged in to Claude (source: ${st.source}, ${st.masked}${life}${st.hasFallbackToken ? ", long-lived token kept as fallback" : ""}).`);
    return 0;
  }
  if (cmd === "logout") {
    await clearClaudeToken(account);
    console.log(`Signed out of Claude (provider "${account}").`);
    return 0;
  }
  // The chat has `/claude login` (PKCE with a pasted code) because it has no browser. Here the
  // browser is one command away, so `login` stays the vendor's own tool and mints the long-lived
  // token that backs the OAuth credential when a refresh fails.
  console.log("Usage: my-claw claude <login|set-token <token>|status|logout> [--provider <key>]");
  return cmd ? 1 : 0;
}

// The chat commands need a live channel. A config that kills the only channel (a bad token) leaves
// no way in, so the same three subcommands are reachable from a terminal.
async function runConfigCli(args: string[]): Promise<number> {
  const { configCommandCli } = await import("./channels/config-commands.ts");
  const { resolveWorkspaceDir, loadEnv } = await import("./core/config.ts");
  await loadEnv();
  // Read the workspace straight off disk: loadConfig would refuse to run on the very file the
  // operator is trying to roll back.
  const raw = await readFile(CONFIG_PATH, "utf-8").catch(() => "{}");
  let workspace: string | undefined;
  try {
    workspace = (JSON.parse(raw) as MyClawConfig).workspace;
  } catch {
    // A broken config is the expected case here.
  }
  console.log(await configCommandCli(args, resolveWorkspaceDir(workspace)));
  return 0;
}

// Device pairing from the shell, the CLI half of docs/web-pairing.md. Imported lazily like the
// other CLI paths: the runner must not boot the orchestrator to write one config entry.
async function runDeviceCliCommand(args: string[]): Promise<number> {
  const { runDeviceCli } = await import("./channels/my-claw-app/device-cli.ts");
  const { loadEnv } = await import("./core/config.ts");
  await loadEnv();
  return runDeviceCli(args);
}

async function runSetupCliCommand(args: string[]): Promise<number> {
  const { runSetupCli } = await import("./channels/my-claw-app/device-cli.ts");
  const { loadEnv } = await import("./core/config.ts");
  await loadEnv();
  return runSetupCli(args);
}

async function runWebCliCommand(args: string[]): Promise<number> {
  const { runWebCli } = await import("./channels/my-claw-app/web-cli.ts");
  // The bundle lives on a private release: without the env the download is anonymous, and a
  // private asset answers an anonymous GET with a 404.
  const { loadEnv } = await import("./core/config.ts");
  await loadEnv();
  return runWebCli(args);
}

// Remote nodes from the shell: `myclaw node add` mints a claim code through the running daemon
// (docs/remote-nodes.md). Lazy like the other CLI paths.
async function runNodeCliCommand(args: string[]): Promise<number> {
  const { runNodeCli } = await import("./nodes/cli.ts");
  const { loadEnv } = await import("./core/config.ts");
  await loadEnv();
  return runNodeCli(args);
}

const CLI_COMMANDS = ["codex", "claude", "config", "device", "setup", "web", "node", "release-key"] as const;

const cliArgs = process.argv.slice(2);
if ((CLI_COMMANDS as readonly string[]).includes(cliArgs[0] ?? "")) {
  const runners: Record<string, (args: string[]) => Promise<number>> = {
    codex: runCodexCli,
    claude: runClaudeCli,
    config: runConfigCli,
    device: runDeviceCliCommand,
    setup: runSetupCliCommand,
    web: runWebCliCommand,
    node: runNodeCliCommand,
    "release-key": runReleaseKeyCli,
  };
  const runner = runners[cliArgs[0]!]!;
  runner(cliArgs.slice(1))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
