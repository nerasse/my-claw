import type { MyClawConfig } from "../config.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { ToolRegistry } from "../tools/registry.ts";

export class AgentBridge {
  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
  ) {}

  async handleMessage(
    message: UnifiedMessage,
    session: SessionData,
  ): Promise<string> {
    const tools = this.toolRegistry.getForAgent("main");

    const systemPrompt = await buildSystemPrompt({
      platform: message.platform,
      model: this.config.llm.model,
      channelId: message.chatId,
      sessionId: session.id,
      tools,
    });

    // TODO: call LLM via OpenAI-compatible API with systemPrompt + message history
    return "TODO: LLM response";
  }
}
