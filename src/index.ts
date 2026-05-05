import { unlink } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { ModelPicker } from "./channels/telegram-model-picker.ts";
import { SessionManager } from "./sessions/manager.ts";
import { MessageRouter } from "./router/router.ts";
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
import { log } from "./utils/logger.ts";

async function main() {
  const config = await loadConfig();
  const modelPicker = new ModelPicker(config.llm.models ?? []);

  const toolRegistry = new ToolRegistry();
  for (const tool of [bashTool, readTool, writeTool, fetchTool, findTool, grepTool, lsTool, memoryTool]) {
    toolRegistry.register(tool);
  }

  const sessionManager = new SessionManager();
  const agent = new AgentBridge(config, toolRegistry);
  const router = new MessageRouter(config.whitelist, sessionManager, agent);

  const adapters: Array<{ stop(): Promise<void> }> = [];

  if (config.channels.telegram) {
    const whitelist = new Set(config.whitelist);
    const telegram = new TelegramAdapter(config.channels.telegram, whitelist);

    telegram.onMessage(async (msg) => {
      try {
        let response: string | undefined;

        if (telegram.streamingEnabled()) {
          const streamer = telegram.createStreamer(msg);
          try {
            response = await router.route(msg, {
              onToken: (token) => streamer.push(token),
              onToolUse: () => streamer.splitForToolUse(),
            });
            await streamer.finish();
          } catch (err) {
            await streamer.abort();
            throw err;
          }
        } else {
          response = await router.route(msg);
        }

        if (response) {
          if (!telegram.streamingEnabled()) {
            await telegram.send(msg.chatId, { text: response, replyToId: msg.id });
          }
        }
      } finally {
        await cleanupAttachments(msg.attachments);
      }
    });

    telegram.onCommand(async (chatId, userId, chatType, command, args) => {
      const sessionId = SessionManager.resolveSessionId("telegram", chatType, chatId, userId);

      switch (command) {
        case "new":
          await sessionManager.resetSession(sessionId, "telegram", chatType);
          return "New session started.";

        case "clear":
          await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
          sessionManager.clearHistory(sessionId);
          await sessionManager.persist(sessionId);
          return "History cleared.";

        case "model": {
          const existingSession = await sessionManager.peek(sessionId);
          const currentModel = existingSession?.modelOverride ?? config.llm.model;

          if (args) {
            const match = modelPicker.find(args);
            if (!match) {
              return `Unknown model: ${args}`;
            }

            const session = existingSession ?? await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
            session.modelOverride = match.id === config.llm.model ? undefined : match.id;
            session.lastActiveAt = new Date().toISOString();
            await sessionManager.persist(sessionId);
            return `Model changed to ${modelPicker.labelFor(match.id)}`;
          }

          if (!modelPicker.hasModels()) {
            return `Current model: ${currentModel}`;
          }

          return {
            text: `Current model: ${modelPicker.labelFor(currentModel)}`,
            buttons: modelPicker.buildButtons(currentModel),
          };
        }

        case "status": {
          const session = await sessionManager.peek(sessionId);
          const currentModel = session?.modelOverride ?? config.llm.model;
          if (!session) return `Model: ${currentModel}\nSession: none active`;
          return [
            `Model: ${currentModel}`,
            `Session: ${sessionId}`,
            `Messages: ${session.messages.length}`,
            `Created: ${session.createdAt}`,
            `Last active: ${session.lastActiveAt}`,
          ].join("\n");
        }

        default:
          return undefined;
      }
    });

    telegram.onCallbackQuery(async ({ chatId, userId, chatType, data }) => {
      const modelId = modelPicker.parseCallback(data);
      if (!modelId) return undefined;

      const sessionId = SessionManager.resolveSessionId("telegram", chatType, chatId, userId);
      const session = await sessionManager.getOrCreateWithMeta(sessionId, "telegram", chatType);
      session.modelOverride = modelId === config.llm.model ? undefined : modelId;
      session.lastActiveAt = new Date().toISOString();
      await sessionManager.persist(sessionId);

      return {
        text: `Model changed to ${modelPicker.labelFor(modelId)}`,
        buttons: modelPicker.hasModels() ? modelPicker.buildButtons(modelId) : undefined,
        answerText: "Model updated",
      };
    });

    await telegram.start();
    adapters.push(telegram);
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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
