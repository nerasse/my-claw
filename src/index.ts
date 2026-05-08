import { unlink } from "node:fs/promises";
import { isMatrixChannelEnabled, isTelegramChannelEnabled, loadConfig } from "./config.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { MatrixAdapter } from "./channels/matrix.ts";
import { ModelPicker } from "./channels/model-picker.ts";
import {
  createTelegramCommandHandler,
  createTelegramCallbackHandler,
} from "./channels/telegram-session-handlers.ts";
import {
  createMatrixApprovalHandler,
  createMatrixActionHandler,
  createMatrixCommandHandler,
} from "./channels/matrix-session-handlers.ts";
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
      try {
        let response: string | undefined;

        if (telegram.streamingEnabled()) {
          const streamer = telegram.createStreamer(msg);
          try {
            response = await router.route(msg, {
              onToken: (token) => streamer.push(token),
              onToolUse: () => streamer.splitForToolUse(),
            });
            await streamer.finish(response);
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
      try {
        let response: string | undefined;

        if (matrix.streamingEnabled()) {
          const streamer = matrix.createStreamer(msg);
          try {
            response = await router.route(msg, {
              onToken: (token) => streamer.push(token),
              onToolUse: () => streamer.splitForToolUse(),
            });
            await streamer.finish(response);
          } catch (err) {
            await streamer.abort();
            throw err;
          }
        } else {
          response = await router.route(msg);
        }

        if (response && !matrix.streamingEnabled()) {
          await matrix.send(msg.chatId, {
            text: response,
            replyToId: msg.id,
            threadId: msg.threadId,
          });
        }
      } finally {
        await cleanupAttachments(msg.attachments);
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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
