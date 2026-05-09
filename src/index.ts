import { unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMatrixChannelEnabled, isTelegramChannelEnabled, loadConfig, MY_CLAW_DIR } from "./core/config.ts";
import { TelegramAdapter } from "./channels/telegram/adapter.ts";
import { MatrixAdapter } from "./channels/matrix/adapter.ts";
import { ModelPicker } from "./channels/model-picker.ts";
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
import { AgentBridge } from "./agent/bridge.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { bashTool } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { fetchTool } from "./tools/fetch.ts";
import { findTool } from "./tools/find.ts";
import { grepTool } from "./tools/grep.ts";
import { lsTool } from "./tools/ls.ts";
import { memoryTool } from "./tools/memory.ts";
import { createSpawnTool } from "./tools/spawn.ts";
import { createSendTool } from "./tools/send.ts";
import { createListAgentsTool } from "./tools/list-agents.ts";
import { createKillAgentTool } from "./tools/kill-agent.ts";
import { createResetAgentTool } from "./tools/reset-agent.ts";
import { createListSkillsTool, createReadSkillTool, createCreateSkillTool, createUpdateSkillTool, createDeleteSkillTool } from "./tools/skills.ts";
import { createSttTool } from "./tools/stt.ts";
import { createTtsTool } from "./tools/tts.ts";
import { createVoiceModeTool } from "./tools/voice-mode.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { SubAgentRunner } from "./subagents/runner.ts";
import { SubAgentRegistry } from "./subagents/registry.ts";
import { SkillRegistry } from "./skills/registry.ts";
import { loadAllSkills } from "./skills/loader.ts";
import { syncBuiltIn } from "./skills/sync.ts";
import { VoiceManager, SttPipeline, TtsPipeline } from "./voice/index.ts";
import { log } from "./utils/logger.ts";

async function main() {
  const config = await loadConfig();
  const workspacePath = config.workspace!;
  process.env["MY_CLAW_WORKSPACE"] = workspacePath;
  const modelPicker = new ModelPicker(config.llm.models ?? []);

  const voiceManager = new VoiceManager(config);
  const sttPipeline = new SttPipeline(voiceManager);
  const ttsPipeline = new TtsPipeline(voiceManager);

  const toolRegistry = new ToolRegistry();
  for (const tool of [bashTool, readTool, writeTool, fetchTool, findTool, grepTool, lsTool, memoryTool]) {
    toolRegistry.register(tool);
  }

  toolRegistry.register(createSttTool(sttPipeline));
  toolRegistry.register(createTtsTool(ttsPipeline));
  toolRegistry.register(createVoiceModeTool(voiceManager));
  if (config.webSearch?.baseUrl) {
    toolRegistry.register(createWebSearchTool(config.webSearch));
  }

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

  const subAgentRegistry = new SubAgentRegistry();
  await subAgentRegistry.load();
  const subAgentRunner = new SubAgentRunner(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, ttsPipeline);
  toolRegistry.register(createSpawnTool(subAgentRunner, subAgentRegistry));
  toolRegistry.register(createSendTool(subAgentRunner, subAgentRegistry));
  toolRegistry.register(createListAgentsTool(subAgentRunner, subAgentRegistry));
  toolRegistry.register(createKillAgentTool(subAgentRunner));
  toolRegistry.register(createResetAgentTool(subAgentRunner));

  toolRegistry.register(createListSkillsTool(skillRegistry));
  toolRegistry.register(createReadSkillTool(skillRegistry));
  toolRegistry.register(createCreateSkillTool(workspaceSkillsDir));
  toolRegistry.register(createUpdateSkillTool(workspaceSkillsDir, customDir, skillRegistry));
  toolRegistry.register(createDeleteSkillTool(workspaceSkillsDir, customDir, skillRegistry));

  const sessionManager = new SessionManager();
  const agent = new AgentBridge(config, toolRegistry, skillRegistry, voiceManager, sttPipeline, ttsPipeline);
  const router = new MessageRouter(config.whitelist, sessionManager, agent);

  const adapters: Array<{ stop(): Promise<void> }> = [];

  if (isTelegramChannelEnabled(config)) {
    const whitelist = new Set(config.whitelist);
    const telegram = new TelegramAdapter(config.channels.telegram!, whitelist);
    const commandHandler = createTelegramCommandHandler({
      config,
      sessionManager,
      modelPicker,
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
          const streamer = telegram.createStreamer(msg);
          try {
            response = await router.route(msg, {
              onToken: (token) => streamer.push(token),
              onToolUse: () => streamer.splitForToolUse(),
            });
            await streamer.finish(response?.text);
          } catch (err) {
            await streamer.abort();
            throw err;
          }
        } else {
          response = await router.route(msg);
        }

        if (response) {
          if (!telegram.streamingEnabled()) {
            await telegram.send(msg.chatId, { text: response.text, attachments: response.attachments, replyToId: msg.id });
          } else if (response.attachments?.length) {
            await telegram.send(msg.chatId, { text: "", attachments: response.attachments, replyToId: msg.id });
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
        await cleanupTtsTempFiles(response?.attachments);
      }
    });

    telegram.onCommand(commandHandler);
    telegram.onCallbackQuery(callbackHandler);

    await telegram.start();
    adapters.push(telegram);
  }

  if (isMatrixChannelEnabled(config)) {
    const whitelist = new Set(config.whitelist);
    const matrix = new MatrixAdapter(config.channels.matrix!, whitelist);
    const matrixStoragePaths = matrix.runtimeStoragePaths();
    const commandHandler = createMatrixCommandHandler({
      config,
      sessionManager,
      modelPicker,
    });
    const approvalHandler = createMatrixApprovalHandler(matrixStoragePaths.pendingApprovalsPath);
    const actionHandler = createMatrixActionHandler({
      config,
      sessionManager,
      modelPicker,
      approvalHandler,
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
          const streamer = matrix.createStreamer(msg);
          try {
            response = await router.route(msg, {
              onToken: (token) => streamer.push(token),
              onToolUse: () => streamer.splitForToolUse(),
            });
            await streamer.finish(response?.text);
          } catch (err) {
            await streamer.abort();
            throw err;
          }
        } else {
          response = await router.route(msg);
        }

        if (response) {
          if (!matrix.streamingEnabled()) {
            await matrix.send(msg.chatId, {
              text: response.text,
              attachments: response.attachments,
              replyToId: msg.id,
              threadId: msg.threadId,
            });
          } else if (response.attachments?.length) {
            await matrix.send(msg.chatId, {
              text: "",
              attachments: response.attachments,
              replyToId: msg.id,
              threadId: msg.threadId,
            });
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
        await cleanupTtsTempFiles(response?.attachments);
      }
    });

    matrix.onCommand(commandHandler);
    matrix.onAction(actionHandler);
    router.setApprovalHandler(async (request) => {
      if (request.platform !== "matrix") {
        return "deny";
      }
      return await matrix.confirmTool(request, approvalHandler);
    });
    await approvalHandler.restorePendingApprovals();
    await matrix.start();
    adapters.push(matrix);
  }

  log("info", "my-claw started", { channels: Object.keys(config.channels) });

  const shutdown = async () => {
    log("info", "shutting down...");
    await Promise.allSettled(adapters.map((a) => a.stop()));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cleanupAttachments(attachments: Array<{ path?: string }>): Promise<void> {
  for (const att of attachments) {
    if (att.path) {
      await unlink(att.path).catch(() => {});
    }
  }
}

async function cleanupTtsTempFiles(attachments?: Array<{ path?: string }>): Promise<void> {
  if (!attachments?.length) return;
  for (const att of attachments) {
    if (att.path?.startsWith("/tmp/tts-")) {
      await unlink(att.path).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
