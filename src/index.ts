import { readFile } from "node:fs/promises";
import { closeDb, pruneOldRecords } from "./analytics/usage-db.ts";
import { pruneOldSessions } from "./sessions/store.ts";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMatrixChannelEnabled, isTelegramChannelEnabled, isMyClawAppChannelEnabled, findUnknownScopeEntries, CONFIG_PATH, MY_CLAW_DIR, type MyClawConfig } from "./core/config.ts";
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
import { writeJsonFileAtomically } from "./utils/atomic-write.ts";
import { TelegramAdapter } from "./channels/telegram/adapter.ts";
import { escapeHtml } from "./channels/telegram/format.ts";
import { MatrixAdapter } from "./channels/matrix/adapter.ts";
import { MyClawAppAdapter } from "./channels/my-claw-app/adapter.ts";
import { MyClawAppSessionStoreImpl } from "./channels/my-claw-app/sessions.ts";
import { SessionFileStore } from "./channels/my-claw-app/files.ts";
import { resolveSkillFile } from "./channels/my-claw-app/skills.ts";
import { ModelPicker } from "./channels/model-picker.ts";
import { ModelCatalog, mergeModels, applyProviderGroups, applyModelWindows } from "./llm/catalog.ts";
import { ModelPricing } from "./llm/pricing.ts";
import { discoverSdkModels } from "./agent/claude-sdk/models.ts";
import { startConfigWatcher, type ConfigWatcherHandle } from "./core/config-watcher.ts";
import {
  createTelegramCommandHandler,
  createTelegramCallbackHandler,
} from "./channels/telegram/session-handlers.ts";
import { createMyClawAppCommandHandler } from "./channels/my-claw-app/commands.ts";
import { effectiveEffort } from "./llm/resolver.ts";
import {
  createMatrixApprovalHandler,
  createMatrixActionHandler,
  createMatrixCommandHandler,
} from "./channels/matrix/session-handlers.ts";
import { SessionManager } from "./sessions/manager.ts";
import { MessageRouter, type RouteResult } from "./core/router.ts";
import { RerouteSignal, runRegistry } from "./core/run-registry.ts";
import { withRunContext } from "./utils/run-context.ts";
import type { UnifiedMessage } from "./channels/types.ts";
import { BackendDispatcher } from "./agent/dispatcher.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { bashTool } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { fetchTool } from "./tools/fetch.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
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
import { CronScheduler } from "./cron/scheduler.ts";
import { loadJobs } from "./cron/store.ts";
import { normalizeMatrixUserId } from "./channels/matrix/helpers.ts";
import { SubAgentRunner } from "./subagents/runner.ts";
import { SubAgentRegistry } from "./subagents/registry.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { loadAllSkills } from "./skills/loader.ts";
import { syncBuiltIn } from "./skills/sync.ts";
import { startSkillsWatcher } from "./skills/watcher.ts";
import { McpManager } from "./mcp/manager.ts";
import { PluginLoader } from "./tools/plugins.ts";
import { backfillConversationArchive } from "./conversations/store.ts";
import { recreateChannelAdapter } from "./channels/recreate.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "./voice/index.ts";
import { extractMediaRefs, cleanupGeneratedTempFiles, cleanupAttachments } from "./utils/media.ts";
import { chatCompletion } from "./llm/provider.ts";
import { codexLoginDeviceCode, loadCodexCredential, codexLogout } from "./llm/codex-auth.ts";
import { runClaudeSetupToken, setClaudeToken, clearClaudeToken, claudeTokenStatus } from "./llm/claude-auth.ts";
import { resolveLlmConfig, resolveOpenAiLlmConfig } from "./llm/resolver.ts";
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
import { setVoiceSttMode } from "./core/config-edit.ts";
import { log, pruneOldLogs, setLogLevelSource } from "./utils/logger.ts";
import { hooks } from "./hooks/index.ts";

const DAY_MS = 86_400_000;

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
  const workspacePath = config.workspace!;
  process.env["MY_CLAW_WORKSPACE"] = workspacePath;
  await snapshotProtected(workspacePath, { origin: "boot" });

  // A/B confirmation. Channels are tracked live rather than from a one-shot list, because a
  // recreate that fails mid-life has to count as "down" too.
  const liveChannels = new Set<string>();
  hooks.on("channel:started", ({ platform }) => void liveChannels.add(platform));
  hooks.on("channel:stopped", ({ platform }) => void liveChannels.delete(platform));
  hooks.on("channel:error", ({ platform }) => void liveChannels.delete(platform));

  const confirmHealthyConfig = async (): Promise<void> => {
    const healthy = isHealthy({
      expectsChannel: isTelegramChannelEnabled(config) || isMatrixChannelEnabled(config) || isMyClawAppChannelEnabled(config),
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
  const modelPicker = new ModelPicker([]);

  // Reads the live config so a hot-reloaded provider is priced without a restart, and the live
  // model list so an alias resolves to whatever version discovery last reported. Declared ahead of
  // the catalog because the same table also fills in the context windows discovery left blank.
  const pricing = new ModelPricing(() => config.llm.providers ?? {}, () => config.llm.models ?? []);

  // Dynamic model catalog: discovered models (Claude SDK + OpenAI /v1/models) merge into the
  // curated config.models. Everything (resolver, dispatcher, picker) reads config.llm.models,
  // so the merge writes there; baseModels is the curated disk set re-merged on each refresh.
  let baseModels = [...(config.llm.models ?? [])];
  const modelCatalog = new ModelCatalog(() => config.llm, discoverSdkModels);
  const applyModelCatalog = () => {
    const merged = mergeModels(baseModels, modelCatalog.discovered());
    // Provider-first: models with no explicit group nest under their provider's group label.
    const grouped = applyProviderGroups(merged, config.llm.providers ?? {});
    config.llm.models = applyModelWindows(grouped, config.llm.providers ?? {}, pricing);
    modelPicker.syncFromConfig(config.llm);
  };
  modelCatalog.onUpdate(applyModelCatalog);
  applyModelCatalog(); // apply any disk-cached discovery immediately (offline-safe)
  if (modelCatalog.enabled()) void modelCatalog.refresh();
  const modelCatalogTimer = setInterval(() => void modelCatalog.refresh(), 6 * 60 * 60 * 1000);
  modelCatalogTimer.unref?.();

  // The window enrichment above is a no-op until the price table is on disk, so a first-ever
  // fetch has to replay it; otherwise every model keeps the fallback window until a restart.
  void pricing.refreshIfStale().then(applyModelCatalog);
  const pricingTimer = setInterval(() => void pricing.refreshIfStale().then(applyModelCatalog), 6 * 60 * 60 * 1000);
  pricingTimer.unref?.();


  // `/codex login` and `/claude set-token` only store a token; without a matching provider,
  // discovery is a no-op and the subscription's models never reach /model. After an auth change
  // we ensure the provider exists (added to config, persisted for restarts) and re-run discovery
  // now that a token is available. Provider spec per auth kind:
  const AUTH_PROVIDER: Record<"codex" | "claude", { type: "codex" | "claude-sdk"; key: string; group: string }> = {
    codex: { type: "codex", key: "chatgpt", group: "ChatGPT (abo)" },
    claude: { type: "claude-sdk", key: "anthropic", group: "Claude (abo)" },
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
  // Always register: the tool reads config.browser.enabled live and no-ops when disabled,
  // so the hot-reload watcher can toggle the browser without a restart.
  toolRegistry.register(createDelegateBrowserTool(config));

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoSkillsDir = join(repoRoot, "src", "skills");
  const builtinDir = join(MY_CLAW_DIR, "skills", ".builtin");
  const customDir = join(MY_CLAW_DIR, "skills");
  const workspaceSkillsDir = join(workspacePath, "skills");

  const changedBuiltins = await syncBuiltIn(repoSkillsDir, builtinDir);
  if (changedBuiltins.length > 0) {
    void log("info", "skills synced", { changed: changedBuiltins });
  }

  const allSkills = await loadAllSkills({ builtInDir: builtinDir, customDir, workspaceDir: workspaceSkillsDir });
  const skillRegistry = new SkillRegistry(allSkills);
  hooks.emit("skills:loaded", { count: allSkills.size });

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

  const subAgentRegistry = new SubAgentRegistry();
  const subAgentRunner = new SubAgentRunner(config, toolRegistry, skillRegistry, voiceManager, sttPipeline);
  registerSubAgentTools(toolRegistry, subAgentRunner, subAgentRegistry, config);
  registerSkillTools(toolRegistry, skillRegistry, config, builtinDir, customDir, workspaceSkillsDir);

  const sessionManager = new SessionManager();
  const backfilledConversations = await backfillConversationArchive();
  if (backfilledConversations > 0) {
    void log("info", "conversation archive backfilled", { messages: backfilledConversations });
  }
  const agent = new BackendDispatcher(config, toolRegistry, skillRegistry, voiceManager, sttPipeline);
  const router = new MessageRouter(sessionManager, agent, config);
  const cronScheduler = new CronScheduler(router, sessionManager, config);
  toolRegistry.register(createCronTool(cronScheduler));

  const adapters: Array<{ stop(): Promise<void> }> = [];
  let telegramRef: TelegramAdapter | undefined;
  let matrixRef: MatrixAdapter | undefined;
  let myClawAppRef: MyClawAppAdapter | undefined;

  // Factory so the channel can be recreated on an identity/token change (A6b) without a
  // restart: reads config.channels.telegram live, wires all handlers, starts, sets telegramRef.
  const startTelegramChannel = async (): Promise<void> => {
    if (!isTelegramChannelEnabled(config)) return;
    const whitelist = new Set(config.whitelist);
    const telegram = new TelegramAdapter(config.channels.telegram!, whitelist);
    telegramRef = telegram;
    const commandHandler = createTelegramCommandHandler({
      config,
      sessionManager,
      modelPicker,
      skillRegistry,
      builtinDir,
      customDir,
      workspaceSkillsDir,
      listCronJobs: () => loadJobs(),
      sdkCompact: (session) => agent.compactSdkSession(session),
      postMessage: (chatId, text, threadId) => telegram.send(chatId, { text, threadId }),
      onAuthChanged,
      reloadConfigNow,
      toolRegistry,
      mcpStatus: () => mcpManager.status(),
      listSubAgents: (sessionId: string) => subAgentRunner.list(subAgentRegistry, sessionId),
      pricing,
    });
    const callbackHandler = createTelegramCallbackHandler({
      config,
      sessionManager,
      modelPicker,
      // An agent menu writes config.json, and the confirmation must describe the running config.
      reloadConfigNow,
    });

    telegram.onMessage(async (msg) => withRunContext({ platform: "telegram" }, async () => {
      let response: RouteResult | undefined;
      try {
        // Pre-process audio (STT + echo) before routing so echoes arrive first
        await agent.preprocessMessage(msg);
        const echoes = agent.getEchoMessages(msg.id);
        for (const echo of echoes) {
          await telegram.send(msg.chatId, { ...echo, replyToId: msg.id });
        }

        if (telegram.streamingEnabled()) {
          // `active` is the current output bubble; onTurnSwitch finalizes it and opens a fresh
          // reply to a mid-run injected message so each message gets its own threaded answer.
          let active = telegram.createStreamer(msg);
          hooks.emit("stream:start", { platform: "telegram", chatId: msg.chatId });
          try {
            response = await routeWithReroute(router, msg, {
              onToken: (token) => active.push(token),
              onToolUse: (tools, verbose) => active.appendToolUse(tools, verbose),
              onTurnSwitch: async (injMsg) => {
                await active.finish();
                active = telegram.createStreamer(injMsg);
              },
            });
            await active.finish();
            hooks.emit("stream:finish", { platform: "telegram", chatId: msg.chatId });
          } catch (err) {
            const brief = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
            await active.abort(brief);
            hooks.emit("stream:abort", { platform: "telegram", chatId: msg.chatId, error: err });
            throw err;
          }
        } else {
          response = await routeWithReroute(router, msg, {});
        }

        if (response) {
          const outGate = await hooks.check("gate:message:outgoing", { platform: "telegram", chatId: msg.chatId, text: response.text });
          if (outGate.allowed) {
            const refs = extractMediaRefs(response.text);
            const textHasMediaRefs = refs.length > 0;
            if (!telegram.streamingEnabled()) {
              const deliveryText = (await hooks.transform("transform:outgoing:message", { text: response.text, platform: "telegram", chatId: msg.chatId })).text;
              await telegram.send(msg.chatId, { text: deliveryText, attachments: textHasMediaRefs ? undefined : response.attachments, replyToId: msg.id });
              hooks.emit("message:delivered", { platform: "telegram", chatId: msg.chatId, text: deliveryText, attachments: (response.attachments?.length ?? 0) });
            } else if (!textHasMediaRefs && response.attachments?.length) {
              await telegram.send(msg.chatId, { text: "", attachments: response.attachments, replyToId: msg.id });
              hooks.emit("message:delivered", { platform: "telegram", chatId: msg.chatId, text: "", attachments: response.attachments.length });
            } else if (textHasMediaRefs) {
              const mediaAttachments = refs.map((ref) => ({ type: "audio" as const, path: ref.path }));
              await telegram.send(msg.chatId, { text: "", attachments: mediaAttachments, replyToId: msg.id });
              hooks.emit("message:delivered", { platform: "telegram", chatId: msg.chatId, text: "", attachments: mediaAttachments.length });
            }
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
        await cleanupGeneratedTempFiles(response?.attachments);
      }
    }));

    telegram.onCommand(commandHandler);
    telegram.onCallbackQuery(callbackHandler);

    if (!isMatrixChannelEnabled(config)) {
      router.setApprovalHandler(async (request) => {
        if (request.platform === "telegram") {
          const args = escapeHtml(JSON.stringify(request.args, null, 2).slice(0, 500));
          const text = `Approval required for tool <b>${escapeHtml(request.toolName)}</b>\n\n<pre>${args}</pre>`;
          const accepted = await telegram.confirm(request.chatId, text, request.messageId);
          return accepted ? "allow-session" : "deny";
        }
        if (request.platform === "my-claw-app" && myClawAppRef) {
          return await myClawAppRef.confirmTool(request);
        }
        return "deny";
      });
    }

    try {
      await telegram.start();
      adapters.push(telegram);
      hooks.emit("channel:started", { platform: "telegram" });
    } catch (err) {
      log("error", "telegram adapter failed to start", { error: String(err) });
      hooks.emit("channel:error", { platform: "telegram", error: err });
    }
  };
  await startTelegramChannel();

  if (isMatrixChannelEnabled(config)) {
    const whitelist = new Set(config.whitelist.map(normalizeMatrixUserId));
    const matrix = new MatrixAdapter(config.channels.matrix!, whitelist);
    matrixRef = matrix;
    const matrixStoragePaths = matrix.runtimeStoragePaths();
    const commandHandler = createMatrixCommandHandler({
      config,
      sessionManager,
      modelPicker,
      skillRegistry,
      builtinDir,
      customDir,
      workspaceSkillsDir,
      listCronJobs: () => loadJobs(),
      sdkCompact: (session) => agent.compactSdkSession(session),
      postMessage: (roomId, text, threadId) => matrix.send(roomId, { text, threadId }),
      onAuthChanged,
      reloadConfigNow,
      toolRegistry,
      mcpStatus: () => mcpManager.status(),
      listSubAgents: (sessionId: string) => subAgentRunner.list(subAgentRegistry, sessionId),
      pricing,
    });
    const approvalHandler = createMatrixApprovalHandler(matrixStoragePaths.pendingApprovalsPath);
    const actionHandler = createMatrixActionHandler({
      config,
      sessionManager,
      modelPicker,
      // An agent menu writes config.json, and the confirmation must describe the running config.
      reloadConfigNow,
      approvalHandler,
      skillRegistry,
      builtinDir,
      customDir,
      workspaceSkillsDir,
    });

    matrix.onMessage(async (msg) => withRunContext({ platform: "matrix" }, async () => {
      let response: RouteResult | undefined;
      try {
        // Pre-process audio (STT + echo) before routing so echoes arrive first
        await agent.preprocessMessage(msg);
        const echoes = agent.getEchoMessages(msg.id);
        for (const echo of echoes) {
          await matrix.send(msg.chatId, { ...echo, replyToId: msg.id, threadId: msg.threadId });
        }

        if (matrix.streamingEnabled()) {
          // `active` is the current output bubble; onTurnSwitch finalizes it and opens a fresh
          // reply to a mid-run injected message so each message gets its own threaded answer.
          let active = matrix.createStreamer(msg);
          hooks.emit("stream:start", { platform: "matrix", chatId: msg.chatId });
          try {
            response = await routeWithReroute(router, msg, {
              onToken: (token) => active.push(token),
              onToolUse: (tools, verbose) => active.appendToolUse(tools, verbose),
              onTurnSwitch: async (injMsg) => {
                await active.finish();
                active = matrix.createStreamer(injMsg);
              },
            });
            await active.finish();
            hooks.emit("stream:finish", { platform: "matrix", chatId: msg.chatId });
          } catch (err) {
            const brief = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
            await active.abort(brief);
            hooks.emit("stream:abort", { platform: "matrix", chatId: msg.chatId, error: err });
            throw err;
          }
        } else {
          response = await routeWithReroute(router, msg, {});
        }

        if (response) {
          const outGate = await hooks.check("gate:message:outgoing", { platform: "matrix", chatId: msg.chatId, text: response.text });
          if (outGate.allowed) {
            const refs = extractMediaRefs(response.text);
            const textHasMediaRefs = refs.length > 0;
            if (!matrix.streamingEnabled()) {
              const deliveryText = (await hooks.transform("transform:outgoing:message", { text: response.text, platform: "matrix", chatId: msg.chatId })).text;
              await matrix.send(msg.chatId, {
                text: deliveryText,
                attachments: textHasMediaRefs ? undefined : response.attachments,
                replyToId: msg.id,
                threadId: msg.threadId,
              });
              hooks.emit("message:delivered", { platform: "matrix", chatId: msg.chatId, text: deliveryText, attachments: (response.attachments?.length ?? 0) });
            } else if (!textHasMediaRefs && response.attachments?.length) {
              await matrix.send(msg.chatId, {
                text: "",
                attachments: response.attachments,
                replyToId: msg.id,
                threadId: msg.threadId,
              });
            } else if (textHasMediaRefs) {
              const mediaAttachments = refs.map((ref) => ({ type: "audio" as const, path: ref.path }));
              await matrix.send(msg.chatId, {
                text: "",
                attachments: mediaAttachments,
                replyToId: msg.id,
                threadId: msg.threadId,
              });
            }
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
        await cleanupGeneratedTempFiles(response?.attachments);
      }
    }));

    matrix.onCommand(commandHandler);
    matrix.onAction(actionHandler);
    router.setApprovalHandler(async (request) => {
      if (request.platform === "matrix") {
        return await matrix.confirmTool(request, approvalHandler);
      }
      if (request.platform === "telegram" && telegramRef) {
        const args = escapeHtml(JSON.stringify(request.args, null, 2).slice(0, 500));
        const text = `Approval required for tool <b>${escapeHtml(request.toolName)}</b>\n\n<pre>${args}</pre>`;
        const accepted = await telegramRef.confirm(request.chatId, text, request.messageId);
        return accepted ? "allow-session" : "deny";
      }
      if (request.platform === "my-claw-app" && myClawAppRef) {
        return await myClawAppRef.confirmTool(request);
      }
      return "deny";
    });
    await approvalHandler.restorePendingApprovals();
    try {
      await matrix.start();
      adapters.push(matrix);
      hooks.emit("channel:started", { platform: "matrix" });
    } catch (err) {
      log("error", "matrix adapter failed to start", { error: String(err) });
      hooks.emit("channel:error", { platform: "matrix", error: err });
    }
  }

  if (telegramRef) cronScheduler.adapters.set("telegram", telegramRef);
  if (matrixRef) cronScheduler.adapters.set("matrix", matrixRef);

  const startMyClawAppChannel = async (): Promise<void> => {
    // Channel keys are never validated, so a config still on the old name would start the
    // process with the channel silently missing. Say it out loud instead.
    if ("mobile" in config.channels) {
      log("warn", 'channels.mobile is not read anymore, rename it to channels["my-claw-app"]');
    }
    if (!isMyClawAppChannelEnabled(config)) return;
    const myClawAppConfig = config.channels["my-claw-app"]!;
    const myClawAppSessions = new MyClawAppSessionStoreImpl(sessionManager, new SessionFileStore(myClawAppConfig));
    const myClawApp = new MyClawAppAdapter(myClawAppConfig, myClawAppSessions);
    myClawAppRef = myClawApp;

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

    // The model menu of the app is built from the same picker as /model on the other channels,
    // so the two surfaces can never disagree about what is on offer or what is on.
    const modelSessionId = (owner: string, threadId: string): string =>
      SessionManager.resolveSessionId("my-claw-app", "dm", owner, owner, {
        threadId,
        sessionScope: "per-user",
      });
    const resolveModelState = async (owner: string, threadId: string) => {
      const session = await sessionManager.peek(modelSessionId(owner, threadId));
      const defaultModel = config.llm.defaultModel ?? config.llm.model ?? "";
      const model = session?.modelOverride ?? defaultModel;
      const effort = effectiveEffort(config.llm, model, session?.effortOverride);
      const levels = modelPicker.effortLevelsFor(model);
      return {
        model,
        defaultModel,
        effort: {
          level: effort.source === "unsupported" ? "" : effort.level ?? "",
          levels,
          supported: effort.source !== "unsupported",
        },
      };
    };
    myClawApp.onModelController({
      list: () => ({
        models: modelPicker.options().map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.group ? { group: m.group } : {}),
        })),
        defaultModel: config.llm.defaultModel ?? config.llm.model ?? "",
      }),
      current: (owner, threadId) => resolveModelState(owner, threadId),
      set: async (owner, threadId, modelId) => {
        const sessionId = modelSessionId(owner, threadId);
        // Unlike rename, a missing session is not refused: the thread is already in the app's
        // list, and picking a model for it is exactly what /model does on the other channels.
        const session =
          (await sessionManager.peek(sessionId)) ??
          (await sessionManager.getOrCreateWithMeta(sessionId, "my-claw-app", "dm"));
        const previousModel = session.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        session.modelOverride = modelId === (config.llm.defaultModel ?? config.llm.model) ? undefined : modelId;
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
        const activeModel = session.modelOverride ?? config.llm.defaultModel ?? config.llm.model ?? "";
        const levels = modelPicker.effortLevelsFor(activeModel);
        if (!levels.includes(level as never)) throw new Error(`invalid effort level: ${level}`);
        session.effortOverride = level as never;
        session.lastActiveAt = new Date().toISOString();
        await sessionManager.persist(sessionId);
        return resolveModelState(owner, threadId);
      },
    });

    myClawApp.onSkillsController({
      list: () => ({
        skills: skillRegistry.list("all").map((s) => ({
          name: s.name,
          description: s.description,
          ...(s.version ? { version: s.version } : {}),
          source: s.source,
          path: s.path,
        })),
      }),
      read: async (source, name) => {
        if (source !== "built-in" && source !== "custom" && source !== "workspace") return null;
        return resolveSkillFile(source, name, { builtInDir: builtinDir, customDir, workspaceSkillsDir });
      },
    });

    myClawApp.onCommandHandler(createMyClawAppCommandHandler({
      config,
      sessionManager,
      modelPicker,
      skillRegistry,
      builtinDir,
      customDir,
      workspaceSkillsDir,
      listCronJobs: () => loadJobs(),
      sdkCompact: (session) => agent.compactSdkSession(session),
      postMessage: (owner, text, threadId) => myClawApp.send(owner, { text, threadId }),
      onAuthChanged,
      reloadConfigNow,
      toolRegistry,
      mcpStatus: () => mcpManager.status(),
      listSubAgents: (sessionId) => subAgentRunner.list(subAgentRegistry, sessionId),
      pricing,
    }));

    myClawApp.onStop((sessionId) => runRegistry.stop(sessionId));

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
                  messages: session.messages.length,
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

        if (myClawApp.streamingEnabled()) {
          // The streamer owns the output bubble for the whole run; a mid-run injected message
          // finalizes it and opens a fresh bubble replying to that message.
          let active = myClawApp.createStreamer(msg);
          hooks.emit("stream:start", { platform: "my-claw-app", chatId: msg.chatId });
          try {
            response = await routeWithReroute(router, msg, {
              onToken: (token) => active.push(token),
              onToolUse: (tools, verbose) => active.appendToolUse(tools, verbose),
              onTurnSwitch: async (injMsg) => {
                await active.finish();
                active = myClawApp.createStreamer(injMsg);
              },
            });
            await active.finish();
            hooks.emit("stream:finish", { platform: "my-claw-app", chatId: msg.chatId });
          } catch (err) {
            const brief = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
            await active.abort(brief);
            hooks.emit("stream:abort", { platform: "my-claw-app", chatId: msg.chatId, error: err });
            throw err;
          }
        } else {
          response = await routeWithReroute(router, msg, {});
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
              const mediaAttachments = refs.map((ref) => ({ type: "audio" as const, path: ref.path }));
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
    getTelegram: () => telegramRef,
    getMatrix: () => matrixRef,
    normalizeMatrixUserId,
    registerWebSearch,
    syncMcp: (mcp) => void mcpManager.sync(mcp),
    reloadCron: () => cronScheduler.restart(),
    reloadMemory: (memory) => void reloadMemoryEmbedding(memory),
    recreateTelegram: () => void recreateTelegramChannel(),
  });

  // Sequential recreate (stop old before start new) via the shared orchestration helper, then
  // re-point the cron adapters map that captured the concrete instance.
  async function recreateTelegramChannel(): Promise<void> {
    await recreateChannelAdapter({
      current: telegramRef,
      adapters,
      build: async () => {
        telegramRef = undefined;
        await startTelegramChannel();
        return telegramRef;
      },
      repoint: (next) => { if (next) cronScheduler.adapters.set("telegram", next); },
      label: "telegram",
    });
    log("info", "telegram channel recreated after identity change");
  }

  const stopSkillsWatcher = startSkillsWatcher(
    { builtInDir: builtinDir, customDir, workspaceDir: workspaceSkillsDir },
    skillRegistry,
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
  // arrive in the chat. Best-effort and unaddressed elsewhere: whitelist ids are Telegram user ids,
  // and a Matrix send needs a room, so this reaches Telegram only.
  if (fallback) {
    const owner = config.whitelist?.[0];
    if (owner && telegramRef) {
      void telegramRef
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

  // Same best-effort channel and same caveat as the fallback alert above: whitelist ids are
  // Telegram user ids, so this reaches Telegram only. A silently reduced scope is worth a message
  // because the symptom is an agent that just stops using a skill.
  if (unknownScopes.length > 0) {
    const owner = config.whitelist?.[0];
    if (owner && telegramRef) {
      const lines = unknownScopes.map(
        (e) => `- \`${e.path}\`: "${e.name}" (${e.kind === "skill" ? "aucune skill de ce nom" : "aucun serveur declare"})`,
      );
      void telegramRef
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
  if (telegramRef) activeChannels.push("telegram");
  if (matrixRef) activeChannels.push("matrix");
  if (myClawAppRef) activeChannels.push("my-claw-app");

  const shutdown = async (signal = "SIGINT") => {
    log("info", "shutting down...", { signal });
    hooks.emit("app:shutdown", { signal });
    clearTimeout(confirmTimer);
    configWatcher.stop();
    stopSkillsWatcher();
    pluginLoader?.stop();
    await mcpManager.stop().catch(() => undefined);
    cronScheduler.stop();
    clearInterval(modelCatalogTimer);
    if (memoryPurgeTimer) clearInterval(memoryPurgeTimer);
    for (const ch of activeChannels) hooks.emit("channel:stopped", { platform: ch });
    await Promise.allSettled(adapters.map((a) => a.stop()));
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
      const llmCfg = resolveOpenAiLlmConfig(config.llm, memCfg?.consolidation?.model);
      const res = await chatCompletion(llmCfg, [
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
  for (const tool of [bashTool, readTool, writeTool, fetchTool, findTool, grepTool, lsTool, createMemoryTool(config), createConversationSearchTool()]) {
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
): void {
  registry.register(createSpawnTool(runner, subRegistry, () => (config.llm.models ?? []).map((m) => m.id)));
  registry.register(createSendTool(runner, subRegistry));
  registry.register(createListAgentsTool(runner, subRegistry));
  registry.register(createKillAgentTool(runner));
  registry.register(createResetAgentTool(runner));
}

function registerSkillTools(
  registry: ToolRegistry, skillRegistry: SkillRegistry, config: MyClawConfig,
  builtinDir: string, customDir: string, workspaceSkillsDir: string,
): void {
  // config is the live object mutated in place by the hot-reload appliers, so a scope edit takes
  // effect on the next tool call without re-registering anything.
  registry.register(createListSkillsTool(skillRegistry, config));
  registry.register(createReadSkillTool(skillRegistry, config));
  registry.register(createManageSkillsTool(skillRegistry, builtinDir, customDir, workspaceSkillsDir));
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
    console.log(`Logged in to Claude (source: ${st.source}, ${st.masked}).`);
    return 0;
  }
  if (cmd === "logout") {
    await clearClaudeToken();
    console.log("Cleared the my-claw Claude token.");
    return 0;
  }
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

const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "codex" || cliArgs[0] === "claude" || cliArgs[0] === "config") {
  const runner =
    cliArgs[0] === "codex" ? runCodexCli : cliArgs[0] === "claude" ? runClaudeCli : runConfigCli;
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
