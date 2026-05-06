import type { MyClawConfig } from "../config.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import type { SessionData, SessionMessage } from "../sessions/store.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage } from "../llm/provider.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { log } from "../utils/logger.ts";

const MAX_TOOL_ITERATIONS = 10;

export class AgentBridge {
  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
  ) {}

  async handleMessage(
    message: UnifiedMessage,
    session: SessionData,
  ): Promise<string> {
    return this.handle(message, session);
  }

  async handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: (token: string) => Promise<void>,
    onToolUse?: () => Promise<void>,
  ): Promise<string> {
    return this.handle(message, session, onToken, onToolUse);
  }

  private async handle(
    message: UnifiedMessage,
    session: SessionData,
    onToken?: (token: string) => Promise<void>,
    onToolUse?: () => Promise<void>,
  ): Promise<string> {
    const tools = this.toolRegistry.getForAgent("main");
    const model = session.modelOverride ?? this.config.llm.model;
    const llmConfig = { ...this.config.llm, model };

    const systemPrompt = await buildSystemPrompt({
      platform: message.platform,
      model,
      channelId: message.chatId,
      sessionId: session.id,
      tools,
    });

    const userContent = this.buildUserContent(message);
    const now = new Date().toISOString();
    session.messages.push({ role: "user", content: userContent, timestamp: now });

    const openaiTools = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const chatMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...this.toChatMessages(session.messages),
    ];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = onToken
        ? await chatCompletionStream(
            llmConfig,
            chatMessages,
            onToken,
            openaiTools.length > 0 ? openaiTools : undefined,
          )
        : await chatCompletion(
            llmConfig,
            chatMessages,
            openaiTools.length > 0 ? openaiTools : undefined,
          );

      if (!response.toolCalls?.length) {
        session.messages.push({ role: "assistant", content: response.content, timestamp: new Date().toISOString() });
        return response.content;
      }

      if (onToolUse) {
        await onToolUse();
      }

      const assistantToolCalls = response.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));

      chatMessages.push({
        role: "assistant",
        content: response.content,
        tool_calls: assistantToolCalls,
      });

      session.messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: assistantToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
        timestamp: new Date().toISOString(),
      });

      for (const tc of response.toolCalls) {
        const result = await this.executeTool(tc.name, tc.arguments);

        chatMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
        session.messages.push({ role: "tool", toolCallId: tc.id, content: result, timestamp: new Date().toISOString() });
      }
    }

    const fallback = "Reached maximum tool call iterations. Stopping here.";
    session.messages.push({ role: "assistant", content: fallback, timestamp: new Date().toISOString() });
    return fallback;
  }

  private buildUserContent(message: UnifiedMessage): string {
    const parts: string[] = [];

    if (message.replyToText) {
      const sender = message.replyToSender ? ` from ${message.replyToSender}` : "";
      parts.push(`[Reply${sender}]\n${message.replyToText}`);
    }

    if (message.threadRootText) {
      parts.push(`[Thread Root]\n${message.threadRootText}`);
    }

    if (message.roomContext) {
      parts.push(message.roomContext);
    }

    let content = message.text;
    if (message.attachments.length > 0) {
      const lines = message.attachments.map((a) => {
        const source = a.path ?? a.url ?? "unknown";
        const details = [
          a.mimeType,
          typeof a.sizeBytes === "number" ? `${a.sizeBytes} bytes` : undefined,
          a.filename,
          typeof a.width === "number" && typeof a.height === "number" ? `${a.width}x${a.height}` : undefined,
          typeof a.durationMs === "number" ? `${a.durationMs} ms` : undefined,
        ].filter(Boolean);
        return `- ${a.type}: ${source}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
      });
      content += `\n\n[Attachments]\n${lines.join("\n")}`;
    }

    parts.push(content);
    return parts.filter((part) => part.trim()).join("\n\n");
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.toolRegistry.get(name);
    if (!tool) return `Error: unknown tool "${name}"`;

    try {
      const result = await tool.execute(args);
      if (result.success) return result.output;
      return `Error: ${result.error ?? result.output}`;
    } catch (err) {
      log("error", "tool execution failed", { tool: name, error: String(err) });
      return `Error: ${String(err)}`;
    }
  }

  private toChatMessages(messages: SessionMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user":
          out.push({ role: "user", content: msg.content });
          break;
        case "assistant":
          if (msg.toolCalls?.length) {
            out.push({
              role: "assistant",
              content: msg.content,
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            });
          } else {
            out.push({ role: "assistant", content: msg.content });
          }
          break;
        case "tool":
          out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
          break;
      }
    }

    return out;
  }
}
