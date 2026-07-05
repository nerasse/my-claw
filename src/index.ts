import { unlink } from "node:fs/promises";
import { closeDb, pruneOldRecords } from "./analytics/usage-db.ts";
import { pruneOldSessions } from "./sessions/store.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMatrixChannelEnabled, isTelegramChannelEnabled, loadConfig, MY_CLAW_DIR, type MyClawConfig } from "./core/config.ts";
import { TelegramAdapter } from "./channels/telegram/adapter.ts";
import { MatrixAdapter } from "./channels/matrix/adapter.ts";
import { ModelPicker } from "./channels/model-picker.ts";
import { startConfigWatcher } from "./core/config-watcher.ts";
import {
  createTelegramCommandHandler,
  createTelegramCallbackHandler,
} from "./channels/telegram/session-handlers.ts";
import {
  createMatrixApprovalHandler,
  createMatrixActionHandler,
  createMatrixCommandHandler,
} from "./channels/matrix/session-handlers.ts";
import { SessionManager } from "./sessions/manager.ts";
import { MessageRouter, type RouteResult } from "./core/router.ts";
import { RerouteSignal } from "./core/run-registry.ts";
import type { UnifiedMessage } from "./channels/types.ts";
import { AgentBridge } from "./agent/bridge.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { bashTool } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { fetchTool } from "./tools/fetch.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
import { lsTool } from "./tools/ls.ts";
import { createMemoryTool } from "./tools/memory.ts";
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
import { createDelegateBrowserTool } from "./tools/browser.ts";
import { createCronTool } from "./tools/cron.ts";
import { CronScheduler } from "./cron/scheduler.ts";
import { loadJobs } from "./cron/store.ts";
import { normalizeMatrixUserId } from "./channels/matrix/helpers.ts";
import { SubAgentRunner } from "./subagents/runner.ts";
import { SubAgentRegistry } from "./subagents/registry.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { loadAllSkills } from "./skills/loader.ts";
import { syncBuiltIn } from "./skills/sync.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "./voice/index.ts";
import { extractMediaRefs, cleanupGeneratedTempFiles } from "./utils/media.ts";
import { chatCompletion } from "./llm/provider.ts";
import { resolveLlmConfig } from "./llm/resolver.ts";
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
import { log, pruneOldLogs } from "./utils/logger.ts";
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
  const config = await loadConfig();
  pruneOldRecords();
  void pruneOldLogs();
  void pruneOldSessions();
  const workspacePath = config.workspace!;
  process.env["MY_CLAW_WORKSPACE"] = workspacePath;
  const memoryPurgeTimer = initMemory(config);
  const modelPicker = new ModelPicker(config.llm.models ?? []);

  const voiceManager = new VoiceManager(config);
  const sttPipeline = new SttPipeline(voiceManager);
  const ttsPipeline = new TtsPipeline(voiceManager);

  const toolRegistry = new ToolRegistry();
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

  const subAgentRegistry = new SubAgentRegistry();
  const subAgentRunner = new SubAgentRunner(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, ttsPipeline);
  registerSubAgentTools(toolRegistry, subAgentRunner, subAgentRegistry);
  registerSkillTools(toolRegistry, skillRegistry, builtinDir, customDir, workspaceSkillsDir);

  const sessionManager = new SessionManager();
  const agent = new AgentBridge(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, ttsPipeline);
  const router = new MessageRouter(sessionManager, agent, config);
  const cronScheduler = new CronScheduler(router, sessionManager, config);
  toolRegistry.register(createCronTool(cronScheduler));

  const adapters: Array<{ stop(): Promise<void> }> = [];
  let telegramRef: TelegramAdapter | undefined;
  let matrixRef: MatrixAdapter | undefined;

  if (isTelegramChannelEnabled(config)) {
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
    });
    const callbackHandler = createTelegramCallbackHandler({
      config,
      sessionManager,
      modelPicker,
    });

    telegram.onMessage(async (msg) => {
      let response: RouteResult | undefined;
      try {
        // Pre-process audio (STT + echo) before routing so echoes arrive first
        await agent.preprocessMessage(msg);
        const echoes = agent.getEchoMessages();
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
    });

    telegram.onCommand(commandHandler);
    telegram.onCallbackQuery(callbackHandler);

    if (!isMatrixChannelEnabled(config)) {
      router.setApprovalHandler(async (request) => {
        if (request.platform === "telegram") {
          const args = JSON.stringify(request.args, null, 2).slice(0, 500);
          const text = `Approval required for tool <b>${request.toolName}</b>\n\n<pre>${args}</pre>`;
          const accepted = await telegram.confirm(request.chatId, text, request.messageId);
          return accepted ? "allow-session" : "deny";
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
  }

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
    });
    const approvalHandler = createMatrixApprovalHandler(matrixStoragePaths.pendingApprovalsPath);
    const actionHandler = createMatrixActionHandler({
      config,
      sessionManager,
      modelPicker,
      approvalHandler,
      skillRegistry,
      builtinDir,
      customDir,
      workspaceSkillsDir,
    });

    matrix.onMessage(async (msg) => {
      let response: RouteResult | undefined;
      try {
        // Pre-process audio (STT + echo) before routing so echoes arrive first
        await agent.preprocessMessage(msg);
        const echoes = agent.getEchoMessages();
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
    });

    matrix.onCommand(commandHandler);
    matrix.onAction(actionHandler);
    router.setApprovalHandler(async (request) => {
      if (request.platform === "matrix") {
        return await matrix.confirmTool(request, approvalHandler);
      }
      if (request.platform === "telegram" && telegramRef) {
        const args = JSON.stringify(request.args, null, 2).slice(0, 500);
        const text = `Approval required for tool <b>${request.toolName}</b>\n\n<pre>${args}</pre>`;
        const accepted = await telegramRef.confirm(request.chatId, text, request.messageId);
        return accepted ? "allow-session" : "deny";
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
  cronScheduler.start();

  const stopConfigWatcher = startConfigWatcher(config, {
    modelPicker,
    getTelegram: () => telegramRef,
    getMatrix: () => matrixRef,
    normalizeMatrixUserId,
    registerWebSearch,
  });

  log("info", "my-claw started", { channels: Object.keys(config.channels) });
  hooks.emit("app:ready", { channels: Object.keys(config.channels) });

  const activeChannels: string[] = [];
  if (telegramRef) activeChannels.push("telegram");
  if (matrixRef) activeChannels.push("matrix");

  const shutdown = async () => {
    log("info", "shutting down...");
    hooks.emit("app:shutdown", { signal: "SIGINT" });
    stopConfigWatcher();
    cronScheduler.stop();
    if (memoryPurgeTimer) clearInterval(memoryPurgeTimer);
    for (const ch of activeChannels) hooks.emit("channel:stopped", { platform: ch });
    await Promise.allSettled(adapters.map((a) => a.stop()));
    closeDb();
    closeMemoryDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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

async function cleanupAttachments(attachments: Array<{ path?: string }>): Promise<void> {
  for (const att of attachments) {
    if (att.path) {
      await unlink(att.path).catch(() => {});
    }
  }
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
      const llmCfg = resolveLlmConfig(config.llm, memCfg?.consolidation?.model);
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
        void consolidateMemory(caller, memCfg).finally(() => {
          running = false;
        });
      }
    });
  }

  return setInterval(() => purgeOldMemory(memCfg), DAY_MS);
}

function registerCoreTools(registry: ToolRegistry, config: MyClawConfig): void {
  for (const tool of [bashTool, readTool, writeTool, fetchTool, findTool, grepTool, lsTool, createMemoryTool(config)]) {
    registry.register(tool);
  }
}

function registerVoiceTools(registry: ToolRegistry, stt: SttPipeline, tts: TtsPipeline, voice: VoiceManager): void {
  registry.register(createSttTool(stt));
  registry.register(createTtsTool(tts));
  registry.register(createVoiceModeTool(voice));
}

function registerSubAgentTools(
  registry: ToolRegistry, runner: SubAgentRunner, subRegistry: SubAgentRegistry,
): void {
  registry.register(createSpawnTool(runner, subRegistry));
  registry.register(createSendTool(runner, subRegistry));
  registry.register(createListAgentsTool(runner, subRegistry));
  registry.register(createKillAgentTool(runner));
  registry.register(createResetAgentTool(runner));
}

function registerSkillTools(
  registry: ToolRegistry, skillRegistry: SkillRegistry,
  builtinDir: string, customDir: string, workspaceSkillsDir: string,
): void {
  registry.register(createListSkillsTool(skillRegistry));
  registry.register(createReadSkillTool(skillRegistry));
  registry.register(createManageSkillsTool(skillRegistry, builtinDir, customDir, workspaceSkillsDir));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
