import { readFile, stat } from "node:fs/promises";
import { closeDb, pruneOldRecords } from "./analytics/usage-db.ts";
import { pruneOldSessions, cronSessionToThread, subagentSessionToThread, subagentThreadToSession, loadSession, loadLegacySession } from "./sessions/store.ts";
import { sessionLogOf } from "./sessions/log-access.ts";
import { promptOf } from "./sessions/projection.ts";
import { migrateSessions } from "./sessions/migrate.ts";
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
  resolveContextCap,
  tagNameOf,
  type AgentToolType,
  type EffortLevel,
  type MyClawConfig,
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
import { writeJsonFileAtomically, writeFileAtomically } from "./utils/atomic-write.ts";
import { briefError } from "./utils/errors.ts";
import { MyClawAppAdapter } from "./channels/my-claw-app/adapter.ts";
import type { MyClawAppStreamer } from "./channels/my-claw-app/stream.ts";
import { defaultOwner } from "./channels/my-claw-app/devices.ts";
import type { MyClawAppSubAgentHandoffOutcome, MyClawAppAgentsConfigResult, MyClawAppAgentFileResult, MyClawAppJobEntry, MyClawAppJobsRunEntry, MyClawAppJobScope, MyClawAppMcpEntry, MyClawAppNestedInstruction, MyClawAppSkillEntry, MyClawAppProviderEnvResult, MyClawAppTagsResult, MyClawAppToolEntry, MyClawAppWorkspaceEntry } from "./channels/my-claw-app/types.ts";
import { DEFAULT_THREAD } from "./channels/my-claw-app/types.ts";
import type { CronDeliver } from "./cron/types.ts";
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
import { ModelPricing } from "./llm/pricing.ts";
import { startConfigWatcher, type ConfigWatcherHandle } from "./core/config-watcher.ts";
import { createMyClawAppCommandHandler } from "./channels/my-claw-app/commands.ts";
import { effectiveEffort, EFFORT_LEVELS, leafModelId } from "./llm/resolver.ts";
import { SessionManager } from "./sessions/manager.ts";
import { MessageRouter, type RouteResult } from "./core/router.ts";
import { RerouteSignal, runRegistry } from "./core/run-registry.ts";
import { isAbort } from "./core/aborted.ts";
import { withRunContext } from "./utils/run-context.ts";
import type { UnifiedMessage } from "./channels/types.ts";
import { BackendDispatcher } from "./agent/dispatcher.ts";
import { ToolRegistry, mcpServerOf, baselineToolNames } from "./tools/registry.ts";
import { bashTool } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { fetchTool } from "./tools/fetch.ts";
import { searchTool } from "./tools/search.ts";
import { applyPatchTool } from "./tools/apply-patch.ts";
import { lsTool } from "./tools/ls.ts";
import { createMemoryTool } from "./tools/memory.ts";
import { createConversationSearchTool } from "./tools/conversation-search.ts";
import { createSpawnTool } from "./tools/spawn.ts";
import { createSendTool } from "./tools/send.ts";
import { createListAgentsTool } from "./tools/list-agents.ts";
import { createKillAgentTool } from "./tools/kill-agent.ts";
import { createResetAgentTool } from "./tools/reset-agent.ts";
import { createListSkillsTool, createReadSkillTool, createManageSkillsTool } from "./tools/skills.ts";
import { createSttTool } from "./tools/stt.ts";
import { createTtsTool } from "./tools/tts.ts";
import { createVoiceModeTool } from "./tools/voice-mode.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { createDelegateBrowserTool } from "./tools/browser/index.ts";
import { createCronTool } from "./tools/cron.ts";
import { createWorkspacesTool } from "./tools/workspaces.ts";
import { CronScheduler } from "./cron/scheduler.ts";
import { createJob, loadJobs, removeJob, saveJobs, updateJob } from "./cron/store.ts";
import { endpointStore, foregroundStore, loadOrCreateVapid, publishNotification, isForegroundOn, cleanNotificationText } from "./notifications/push.ts";
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
import { llmComplete } from "./llm/transport.ts";
import { occupiedContextTokens, measurementFor } from "./llm/context-window.ts";
import { promptSidePruned, pruneOldToolResults, sweepSpilledToolOutput } from "./agent/context-pruning.ts";
import { resolveContextPruning } from "./core/config.ts";
import { codexLoginDeviceCode, loadCodexCredential, codexLogout, codexIsLoggedIn } from "./llm/codex-auth.ts";
import { runClaudeSetupToken, setClaudeToken, clearClaudeToken, claudeTokenStatus, claudeTokenInEnv } from "./llm/claude-auth.ts";
import { resolveLlmConfig, resolveAgentLlmConfig, findModel, isOpenRouterBaseUrl } from "./llm/resolver.ts";
import type { ChatMessage } from "./llm/provider.ts";
import { tagRouteOf } from "./core/config.ts";
import { resolveUtilityLlmConfig } from "./llm/utility-model.ts";
import { referenceWithRoute, routesFor, sortRoutes } from "./channels/route-menu.ts";
import { availabilityOf, describe as describeAvailability, overrideForPick, runnableModels, tryResolveRunModel } from "./llm/run-model.ts";
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
  setUiPrefs,
  setDefaultModel,
  clearAgentModel,
  setAgentModel,
  setVisionFallback,
  setAgentScope,
  setAgentWorkspace,
  setAgentMaxIterations,
  setAgentContextCap,
  setToolDisabled,
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
  renameProvider,
  repointEnvKey,
  upsertModel,
  removeModel,
} from "./core/config-edit.ts";
import type { ConfigEditResult } from "./core/config-edit.ts";
import { envKeys, setEnvValue, renameEnvKey, removeEnvKey } from "./core/env-edit.ts";
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
  pruneOldRecords();
  void pruneOldLogs();
  void pruneOldSessions();
  sweepSpilledToolOutput();
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
  // Left empty on purpose: applyModelCatalog() below is the single place that projects the merged
  // model list into the picker, and it runs synchronously before anything can read the menu.
  // The agent list is a closure, not a snapshot: the registry is built further down and its
  // contents change with the files, while a menu is only ever parsed long after boot.
  const modelPicker = new ModelPicker([], undefined, () => agentRegistry.names());

  // Reads the live config so a hot-reloaded provider is priced without a restart, and the live
  // model list so an alias resolves to whatever version discovery last reported. Declared ahead of
  // the catalog because the same table also fills in the context windows discovery left blank.
  const pricing = new ModelPricing(() => config.llm.providers ?? {}, () => config.llm.models ?? []);

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
  const subscriptionAuth = { claude: false, codex: false };
  const sampleSubscriptionAuth = async (): Promise<void> => {
    const claude = (await claudeTokenStatus().catch(() => ({ present: false }))).present;
    const codex = await codexIsLoggedIn().catch(() => false);
    if (claude === subscriptionAuth.claude && codex === subscriptionAuth.codex) return;
    subscriptionAuth.claude = claude;
    subscriptionAuth.codex = codex;
    // The sample decides which models the picker may offer, and it lands asynchronously -- after
    // the projection that a refresh triggers. Re-project, or a token that expired between two
    // refreshes leaves its models on the menu for six hours.
    applyModelCatalog();
  };
  setAvailabilityWorld(() => ({
    answered: (provider) => modelCatalog.answered(provider),
    listedBy: (provider) => modelCatalog.listedBy(provider),
    hasEnv: (name) => Boolean(process.env[name]),
    // The env half is read live, so a token rotated in `.env` alone -- which the watcher applies
    // to process.env without announcing a section change -- is honoured immediately. The stored
    // half comes from the sample, and every writer of that file goes through onAuthChanged.
    claudeAuth: subscriptionAuth.claude || claudeTokenInEnv(),
    codexAuth: subscriptionAuth.codex,
  }));
  await sampleSubscriptionAuth();
  hooks.on("models:discovered", () => void sampleSubscriptionAuth());
  // A config.json edit can add a provider or a key env name, both of which change what is
  // runnable. (A bare `.env` rotation does not reach here -- the watcher returns early when no
  // section changed -- which is why the claude env token is read live in the world above.)
  hooks.on("config:reloaded", () => void sampleSubscriptionAuth());

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


  // `/codex login` and `/claude set-token` only store a token; without a matching provider,
  // discovery is a no-op and the subscription's models never reach /model. After an auth change
  // we ensure the provider exists (added to config, persisted for restarts) and re-run discovery
  // now that a token is available. Provider spec per auth kind:
  const AUTH_PROVIDER: Record<"codex" | "claude", { type: "codex" | "anthropic"; key: string; group: string }> = {
    codex: { type: "codex", key: "chatgpt", group: "ChatGPT (abo)" },
    claude: { type: "anthropic", key: "claude", group: "Claude (abo)" },
  };
  const hasProviderType = (providers: Record<string, { type?: string }> | undefined, type: string): boolean =>
    Object.values(providers ?? {}).some((p) => p.type === type);
  // A free key so we never clobber an existing provider that happens to share the preferred name.
  const freeKey = (providers: Record<string, unknown>, preferred: string): string => {
    if (!(preferred in providers)) return preferred;
    for (let i = 2; ; i++) if (!(`${preferred}${i}` in providers)) return `${preferred}${i}`;
  };
  const ensureAuthProvider = async (kind: "codex" | "claude"): Promise<void> => {
    const spec = AUTH_PROVIDER[kind];
    const live = (config.llm.providers ??= {});
    if (hasProviderType(live, spec.type)) return;
    // Update the live config first so the immediate refresh below can see the provider.
    live[freeKey(live, spec.key)] = { type: spec.type, discover: true, group: spec.group };
    // Persist into the raw on-disk config. Never serialize the in-memory config (it holds
    // runtime-merged models) nor readConfigFromDisk() (it overlays env secrets we must not
    // write back); read and edit the raw file instead.
    try {
      const disk = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as MyClawConfig;
      disk.llm ??= {};
      disk.llm.providers ??= {};
      if (!hasProviderType(disk.llm.providers, spec.type)) {
        disk.llm.providers[freeKey(disk.llm.providers, spec.key)] = { type: spec.type, discover: true, group: spec.group };
        await snapshotConfigFile(CONFIG_PATH, { origin: "pre-write", note: `ajout du provider ${kind}` });
        await writeJsonFileAtomically(CONFIG_PATH, disk, true);
      }
    } catch (err) {
      void log("warn", "could not persist provider to config.json", { kind, error: String(err) });
    }
  };
  const onAuthChanged = async (kind: "codex" | "claude"): Promise<void> => {
    await ensureAuthProvider(kind);
    // Before the refresh: a login that adds models must not have them judged unrunnable by a
    // stale auth sample, and a logout must stop offering them immediately.
    await sampleSubscriptionAuth();
    await modelCatalog.refresh();
  };

  const voiceManager = new VoiceManager(config);
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
  await mcpManager.sync(config.mcp);
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

  // Always register: the tool reads config.browser.enabled live and no-ops when disabled, so the
  // hot-reload watcher can toggle the browser without a restart. Registered after the agent
  // registry because the browser reads its prompt from `agents/browser.md` through it.
  toolRegistry.register(createDelegateBrowserTool(config, agentRegistry));

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
  const subAgentRunner = new SubAgentRunner(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, agentRegistry);
  // Live streams of sub-agent runs for the app channel, keyed by sub-agent session id.
  // Filled when `subagent:spawn` fires inside an app run, read by the spawn tool's
  // streamProvider to attach tokens to the sub-agent's own thread.
  const subAgentStreamers = new Map<string, MyClawAppStreamer>();
  // How to open a fresh bubble in a sub-agent's thread, filled by the run that opened the first one.
  // The provider below is built at boot and has no view of a thread, but a steered sub-agent needs
  // exactly that: the app channel is what knows where the child paints.
  const subAgentStreamRenew = new Map<string, (injected: UnifiedMessage) => MyClawAppStreamer>();
  registerSubAgentTools(
    toolRegistry, subAgentRunner, subAgentRegistry, config, agentRegistry,
    (subagentId) => {
      const streamer = subAgentStreamers.get(subagentId);
      if (!streamer) return undefined;
      return {
        // Read from the map on every call, never captured: a steered child swaps its streamer
        // mid-run and a captured one would keep painting into the sealed bubble.
        onToken: async (token) => { await subAgentStreamers.get(subagentId)?.push(token); },
        onToolUse: async (tools, verbose) => { await subAgentStreamers.get(subagentId)?.appendToolUse(tools, verbose); },
        onToolStart: async (call) => { await subAgentStreamers.get(subagentId)?.appendToolStart([call]); },
        // A sub-agent driven by the model gets the same turn-switch contract as one driven from the
        // app: the bubble in flight is sealed and the answer to the steering message opens a fresh
        // one. Without it the reply melted into the previous bubble and `message:injected` was never
        // emitted, so the owner's message stayed marked "queued for the next turn" for good.
        onTurnSwitch: async (injected) => {
          const current = subAgentStreamers.get(subagentId);
          if (current) await current.finish();
          const renew = subAgentStreamRenew.get(subagentId);
          if (renew) subAgentStreamers.set(subagentId, renew(injected));
          else subAgentStreamers.delete(subagentId);
          hooks.emit("message:injected", { message: injected, sessionId: subagentId });
        },
      };
    },
  );

  // Before anything opens a session. Awaited, not fired off: a channel coming up while the pass is
  // still running would read a conversation the pass is halfway through moving. Measured at 596 ms
  // for the 68 sessions on this install, and it is a one-off -- a session that already has its
  // directory is skipped, so every later boot pays a directory scan and nothing else.
  await migrateSessions(loadLegacySession);

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

  // Run-completion notifications to the app's devices (docs/notifications.md). Best-effort by
  // design: a dead push endpoint must never fail the run that produced the result.
  const formatDuration = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const threadTitle = async (sessionId: string, fallback: string): Promise<string> => {
    const session = await sessionManager.peek(sessionId);
    return session?.title?.trim() || cleanNotificationText(fallback).slice(0, 60);
  };

  hooks.on("message:route:complete", ({ message, sessionId, response, durationMs }) => {
    const threadId = message.threadId ?? "default";
    void threadTitle(sessionId, message.text).then((title) =>
      publishNotification(
        {
          title,
          body: `Run finished in ${formatDuration(durationMs)}: ${cleanNotificationText(response).slice(0, 160)}`,
          url: `myclaw://thread/${threadId}`,
        },
        // The one case the user chose to stay silent: a device that is already looking at
        // the very thread that just finished (the stream is on screen).
        { skipDevice: (deviceId) => isForegroundOn(deviceId, threadId) },
      ),
    );
  });
  hooks.on("message:route:error", ({ message, sessionId, error, durationMs }) => {
    const threadId = message.threadId ?? "default";
    void threadTitle(sessionId, message.text).then((title) =>
      publishNotification(
        {
          title,
          body: `Run failed after ${formatDuration(durationMs)}: ${cleanNotificationText(String(error)).slice(0, 200)}`,
          url: `myclaw://thread/${threadId}`,
        },
        { skipDevice: (deviceId) => isForegroundOn(deviceId, threadId) },
      ),
    );
  });
  // A compaction is the one long operation with no stream behind it: minutes of silence, then a
  // single result frame. The device that is looking at the thread sees that frame land, every
  // other one is told (docs/notifications.md).
  hooks.on("session:compact:finished", ({ sessionId, threadId, durationMs, ok, text }) => {
    const thread = threadId ?? "default";
    void threadTitle(sessionId, "Compaction").then((title) =>
      publishNotification(
        {
          title,
          body: ok
            ? `Context compacted in ${formatDuration(durationMs)}`
            : `Compaction did not run: ${cleanNotificationText(text).slice(0, 160)}`,
          url: `myclaw://thread/${thread}`,
        },
        { skipDevice: (deviceId) => isForegroundOn(deviceId, thread) },
      ),
    );
  });
  // Silent jobs suppress their output by design; a completion notification would be just as
  // noisy, so it is skipped with the delivery.
  hooks.on("cron:job:end", ({ jobId, jobName, success, silent }) => {
    if (silent) return;
    void publishNotification({
      title: jobName,
      body: success ? "Job finished" : "Job failed",
      url: `myclaw://job/${jobId}`,
    });
  });
  // A silent job stays silent when it fails: it used to notify anyway, which made "silent"
  // useless for the failing job that needed it most.
  hooks.on("cron:job:error", ({ jobId, jobName, error, silent }) => {
    if (silent) return;
    void publishNotification({
      title: jobName,
      body: `Job failed: ${cleanNotificationText(String(error)).slice(0, 200)}`,
      url: `myclaw://job/${jobId}`,
    });
  });

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
  }));

  const adapters: Array<{ stop(): Promise<void> }> = [];
  let myClawAppRef: MyClawAppAdapter | undefined;

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
    /** The engine a model resolves to; undefined when it left the catalogue. Only decides pruning. */
    const backendOfModel = (modelId: string): string | undefined => {
      try {
        return resolveLlmConfig(config.llm, modelId).backend;
      } catch {
        return undefined;
      }
    };
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
      const cap = resolveContextCap(config, "main");
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
          // The prompt is read from the log (the source of truth), and pruning is applied if enabled.
          ...(session
            ? await (async () => {
                const log = await sessionLogOf(session.id);
                const prompt = promptOf(log.entries(), log.leaf());
                const backend = backendOfModel(model);
                const pruning = promptSidePruned(config, backend);
                const pruningOpts = resolveContextPruning(config);
                const toChat = (msgs: readonly ChatMessage[]): ChatMessage[] =>
                  pruning ? pruneOldToolResults([...msgs], pruningOpts) : [...msgs];
                return {
                  used: occupiedContextTokens(
                    prompt,
                    toChat,
                    measurementFor(session.lastPrompt, pruning),
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
          models: modelPicker.options().map((m) => ({
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
            ...(config.llm.models?.find((model) => model.id === m.id)?.vision === undefined
              ? {}
              : { vision: config.llm.models.find((model) => model.id === m.id)!.vision! }),
            // Whether a routing step is worth offering at all. Read from the provider key rather
            // than by resolving each of several hundred models; `model.endpoints` answers for real.
            ...(m.provider !== undefined && routable.has(m.provider) ? { routes: true } : {}),
            // Where this entry comes from, so the app can label it (custom vs override) and word
            // its delete button as a reset when the provider serves the id too.
            ...(declared.has(m.id) ? { declared: true } : {}),
            ...(discovered.has(m.id) ? { discovered: true } : {}),
          })),
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
        await modelCatalog.refresh();
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
            discover: provider.discover === true,
            models: providerCountOf(key),
            ...(provider.apiKeyEnv ? { keyEnv: provider.apiKeyEnv } : {}),
            // A subscription provider has no env key at all, and reporting "no key" for it said
            // the opposite of the truth on a box that was perfectly authenticated. Its credential
            // is the stored token, so that is what the flag has to answer for.
            keyPresent:
              provider.type === "codex"
                ? subscriptionAuth.codex
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
        // "" removes the pin; a model must be declared and vision-capable or the resolver would
        // silently keep the original model at run time, which is a config that does nothing.
        if (modelId !== "") {
          const declared = findModel(config.llm, modelId);
          if (!declared) throw new Error(`unknown model: ${modelId}`);
          if (declared.vision !== true) throw new Error(`${modelId} cannot take images`);
        }
        const result = await setVisionFallback(modelId);
        if (!result.ok) throw new Error(result.error);
        return writeAgentsConfig(`fallback image ${modelId || "aucun"}`);
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
        const text = serializeAgentFile(
          {
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
      };
    };
    myClawApp.onProvidersController({
      upsert: async (patch) => {
        const { key, providerType, baseUrl, apiKeyEnv, group, discover, promptCache, reasoningReplay, pricingProvider, fallbackModel } = patch;
        const result = await upsertProvider(key, { type: providerType, baseUrl, apiKeyEnv, group, discover, promptCache, reasoningReplay, pricingProvider, fallbackModel });
        if (!result.ok) throw new Error(result.error);
        return writeProvidersConfig(`provider ${patch.key}`);
      },
      remove: async (key) => {
        const result = await removeProvider(key);
        if (!result.ok) throw new Error(result.error);
        return writeProvidersConfig(`retrait provider ${key}`);
      },
      rename: async (from, to) => {
        const result = await renameProvider(from, to);
        if (!result.ok) throw new Error(result.error);
        return writeProvidersConfig(`renommage provider ${from}`);
      },
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
      const tools: Array<{
        name: string;
        description: string;
        source: "built-in" | "plugin" | "mcp";
        server?: string;
        disabled: boolean;
      }> = [];
      for (const name of toolRegistry.staticNames()) {
        const tool = toolRegistry.get(name);
        if (!tool) continue;
        tools.push({ name, description: tool.description, source: "built-in", disabled: disabled.has(name) });
      }
      for (const tool of pluginLoader?.getTools() ?? []) {
        tools.push({ name: tool.name, description: tool.description, source: "plugin", disabled: disabled.has(tool.name) });
      }
      for (const tool of mcpManager.getTools()) {
        const server = mcpServerOf(tool.name);
        tools.push({
          name: tool.name,
          description: tool.description,
          source: "mcp",
          ...(server ? { server } : {}),
          disabled: disabled.has(tool.name),
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

    const jobsListing = (): Promise<MyClawAppJobEntry[]> =>
      loadJobs().then((jobs) =>
        jobs.map((job) => {
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
            nextRunAt: job.nextRunAt,
            lastRunAt: job.lastRunAt,
            lastStatus: job.lastStatus,
            lastError: job.lastError,
            createdAt: job.createdAt,
            unknownModel: job.model !== undefined && !models.has(job.model) && !isTagReference(job.model),
            unknownWorkspace: job.workspace !== undefined && !workspaces.has(job.workspace),
            unknownSkills: (job.skills ?? []).filter((name) => name !== "*" && !skills.has(name)),
            unknownMcp: (job.mcp ?? []).filter((name) => name !== "*" && !mcp.has(name)),
            unknownTools: (job.tools ?? []).filter((name) => name !== "*" && !tools.has(name)),
          };
        }),
      );

    myClawApp.onJobsController({
      list: () => jobsListing(),
      save: async (fields) => {
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
        };
        const jobs = await loadJobs();
        if (fields.id) {
          const target = jobs.find((j) => j.id === fields.id);
          if (!target) throw new Error(`job not found: ${fields.id}`);
          // "inherit" means the field leaves the job, but updateJob reads undefined as "don't
          // touch": clearing has to happen before the update so the store's semantics stay.
          if (fields.skills.mode === "inherit") delete target.skills;
          if (fields.mcp.mode === "inherit") delete target.mcp;
          if (fields.tools.mode === "inherit") delete target.tools;
          const updated = updateJob(jobs, fields.id, {
            name: fields.name,
            prompt: fields.prompt,
            schedule: fields.schedule,
            enabled: fields.enabled,
            ...stored,
          });
          if (!updated) throw new Error(`job not found: ${fields.id}`);
        } else {
          // A job made from the app has no chat of origin, so "local" is the only honest target.
          jobs.push(createJob({ name: fields.name, prompt: fields.prompt, schedule: fields.schedule, origin: null, deliver: "local", ...stored }));
        }
        await saveJobs(jobs);
        return jobsListing();
      },
      remove: async (id) => {
        const jobs = await loadJobs();
        if (!removeJob(jobs, id)) throw new Error(`job not found: ${id}`);
        await saveJobs(jobs);
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

    myClawApp.onNotificationsController({
      info: () => loadOrCreateVapid().then((keys) => keys.publicKey).catch(() => undefined),
      register: (deviceId, frame) =>
        endpointStore.register(deviceId, {
          endpoint: frame.endpoint,
          pubKey: frame.pubKey,
          auth: frame.auth,
          updatedAt: new Date().toISOString(),
        }),
      unregister: (deviceId) => endpointStore.unregister(deviceId),
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
      postMessage: (owner, text, threadId) => myClawApp.send(owner, { text, threadId }),
      onAuthChanged,
      reloadConfigNow,
      toolRegistry,
      mcpStatus: () => mcpManager.status(),
      listSubAgents: (sessionId) => subAgentRunner.list(subAgentRegistry, sessionId),
      pricing,
    }));

    myClawApp.onStop((sessionId) => runRegistry.stop(sessionId));
    myClawApp.onRunActive((sessionId) => runRegistry.isRunning(sessionId));

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
        message.text,
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

        // The Stop button is pinned to the run, not to the stream bubbles: it must survive
        // tool calls and model turns, and only end with the run itself.
        myClawApp.notifyRun(msg.chatId, msg.threadId ?? DEFAULT_THREAD, true);
        try {
          if (myClawApp.streamingEnabled()) {
            // The streamer owns the output bubble for the whole run; a mid-run injected message
            // finalizes it and opens a fresh bubble replying to that message.
            let active = myClawApp.createStreamer(msg);
            const runSessionId = SessionManager.resolveSessionId("my-claw-app", "dm", msg.chatId, msg.userId, { threadId: msg.threadId, sessionScope: "per-user" });
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
              const streamer = myClawApp.createStreamer({
                ...context,
                id: `subagent-${ev.id}`,
                threadId,
                text: "",
              });
              subAgentStreamers.set(ev.id, streamer);
              subAgentContexts.set(ev.id, context);
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
                reasoning: {
                  onText: (delta) => active.pushReasoning(delta),
                  onTokens: (tokens) => active.pushReasoningTokens(tokens),
                },
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
              const brief = briefError(err);
              await active.abort(brief);
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
              for (const id of subAgentContexts.keys()) {
                const streamer = subAgentStreamers.get(id);
                subAgentStreamers.delete(id);
                subAgentStreamRenew.delete(id);
                if (streamer) void streamer.abort("parent run ended");
              }
              subAgentContexts.clear();
            }
          } else {
            response = await routeWithReroute(router, msg, {});
          }
          myClawApp.notifyRun(msg.chatId, msg.threadId ?? DEFAULT_THREAD, false, "done");
        } catch (err) {
          const aborted = isAbort(err);
          myClawApp.notifyRun(msg.chatId, msg.threadId ?? DEFAULT_THREAD, false, aborted ? "aborted" : "error");
          // The error was a stream frame and nothing else, so the next history page erased it and
          // the thread reopened on a question with nothing under it. Journalled here, where the
          // text is the one the bubble showed. An abort needs no entry: it is the owner's own
          // doing and the partial answer is kept in the mirror.
          if (!aborted) await myClawApp.recordFailure(msg.chatId, msg.threadId ?? DEFAULT_THREAD, briefError(err));
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
      const res = await llmComplete(llmCfg, [
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
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
  for (const tool of [bashTool, readTool, writeTool, applyPatchTool, fetchTool, searchTool, lsTool, createMemoryTool(config), createConversationSearchTool()]) {
    registry.register(tool);
  }
}

function registerVoiceTools(registry: ToolRegistry, stt: SttPipeline, tts: TtsPipeline, voice: VoiceManager): void {
  registry.register(createSttTool(stt));
  registry.register(createTtsTool(tts));
  registry.register(createVoiceModeTool(voice));
}

function registerSubAgentTools(
  registry: ToolRegistry, runner: SubAgentRunner, subRegistry: SubAgentRegistry, config: MyClawConfig,
  agentRegistry: AgentRegistry,
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
): void {
  // Both lists are read live: the spawn schema is rebuilt per run, so an agent file dropped in
  // `agents/` is spawnable on the next message without a restart.
  registry.register(createSpawnTool(
    runner,
    subRegistry,
    () => (config.llm.models ?? []).map((m) => m.id),
    () => agentRegistry.list(),
    streamProvider,
  ));
  registry.register(createSendTool(runner, subRegistry, streamProvider));
  registry.register(createListAgentsTool(runner, subRegistry));
  registry.register(createKillAgentTool(runner));
  registry.register(createResetAgentTool(runner));
}

function registerSkillTools(
  registry: ToolRegistry, skillRegistry: SkillRegistry, config: MyClawConfig,
  builtinDir: string, customDir: string, workspaceSkillsDir: string,
  sessionManager: SessionManager,
): void {
  // config is the live object mutated in place by the hot-reload appliers, so a scope edit takes
  // effect on the next tool call without re-registering anything.
  registry.register(createListSkillsTool(skillRegistry, config, sessionManager));
  registry.register(createReadSkillTool(skillRegistry, config, sessionManager));
  registry.register(createManageSkillsTool(skillRegistry, config, builtinDir, customDir, workspaceSkillsDir));
}

// CLI subcommands for the Codex (ChatGPT subscription) backend. Device-code login is the only
// flow: it needs no local browser, so it works over SSH on the headless VPS. See
// docs/codex-backend.md.
async function runCodexCli(args: string[]): Promise<number> {
  const cmd = args[0];
  if (cmd === "login") {
    try {
      const cred = await codexLoginDeviceCode((prompt) => {
        console.log("\nTo authorize my-claw with your ChatGPT account:");
        console.log(`  1. Open: ${prompt.verificationUri}`);
        console.log(`  2. Enter code: ${prompt.userCode}`);
        console.log(`\nWaiting for approval (expires in ${Math.round(prompt.expiresInSeconds / 60)} min)...`);
      });
      console.log(`\nLogged in. ChatGPT account id: ${cred.accountId}`);
      return 0;
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "status") {
    const cred = await loadCodexCredential();
    if (!cred) {
      console.log("Not logged in to Codex. Run: my-claw codex login");
      return 1;
    }
    const mins = Math.round((cred.expires - Date.now()) / 60000);
    console.log(`Logged in. account id: ${cred.accountId}`);
    console.log(`Access token ${mins > 0 ? `expires in ~${mins} min` : "expired (will refresh on next use)"}.`);
    return 0;
  }
  if (cmd === "logout") {
    await codexLogout();
    console.log("Logged out of Codex.");
    return 0;
  }
  console.log("Usage: my-claw codex <login|status|logout>");
  return cmd ? 1 : 0;
}

// CLI subcommands for the Claude (subscription) backend. `login` wraps the official
// `claude setup-token` (browser/TTY); `set-token` stores a token generated anywhere. Tokens live
// in ~/.my-claw/claude/auth.json and are injected per run by the SDK backend.
async function runClaudeCli(args: string[]): Promise<number> {
  const cmd = args[0];
  if (cmd === "login") {
    const r = await runClaudeSetupToken();
    console.log(`\n${r.message}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "set-token") {
    const token = args.slice(1).join(" ").trim();
    if (!token) {
      console.log("Usage: my-claw claude set-token <token>   (generate one with: claude setup-token)");
      return 1;
    }
    try {
      await setClaudeToken(token);
      console.log("Claude token stored in ~/.my-claw/claude/auth.json.");
      return 0;
    } catch (err) {
      console.error(`Failed to store token: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  if (cmd === "status") {
    const st = await claudeTokenStatus();
    if (!st.present) {
      console.log("Not logged in to Claude. Run: my-claw claude login");
      return 1;
    }
    const life = st.expiresInMin === undefined ? "" : `, access token ${st.expiresInMin > 0 ? `valid ~${st.expiresInMin} min` : "expired (refreshed on the next call)"}`;
    console.log(`Logged in to Claude (source: ${st.source}, ${st.masked}${life}${st.hasFallbackToken ? ", long-lived token kept as fallback" : ""}).`);
    return 0;
  }
  if (cmd === "logout") {
    await clearClaudeToken();
    console.log("Cleared the my-claw Claude token.");
    return 0;
  }
  // The chat has `/claude login` (PKCE with a pasted code) because it has no browser. Here the
  // browser is one command away, so `login` stays the vendor's own tool and mints the long-lived
  // token that backs the OAuth credential when a refresh fails.
  console.log("Usage: my-claw claude <login|set-token <token>|status|logout>");
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

async function runWebCliCommand(args: string[]): Promise<number> {
  const { runWebCli } = await import("./channels/my-claw-app/web-cli.ts");
  // The bundle lives on a private release: without the env the download is anonymous, and a
  // private asset answers an anonymous GET with a 404.
  const { loadEnv } = await import("./core/config.ts");
  await loadEnv();
  return runWebCli(args);
}

const CLI_COMMANDS = ["codex", "claude", "config", "device", "web"] as const;

const cliArgs = process.argv.slice(2);
if ((CLI_COMMANDS as readonly string[]).includes(cliArgs[0] ?? "")) {
  const runners: Record<string, (args: string[]) => Promise<number>> = {
    codex: runCodexCli,
    claude: runClaudeCli,
    config: runConfigCli,
    device: runDeviceCliCommand,
    web: runWebCliCommand,
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
