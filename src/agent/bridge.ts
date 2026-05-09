import type { MyClawConfig } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData, SessionMessage } from "../sessions/store.ts";
import { buildSystemPrompt } from "./prompt/builder.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage } from "../llm/provider.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import { log } from "../utils/logger.ts";
import { ToolApprovalManager } from "./approvals.ts";
import type { VoiceManager, SttPipeline, TtsPipeline } from "../voice/index.ts";
import type { TranscriptionResult } from "../voice/types.ts";

const MAX_TOOL_ITERATIONS = 10;

function runLogData(message: UnifiedMessage, session: SessionData): Record<string, unknown> {
  return {
    messageId: message.id,
    sessionId: session.id,
    platform: message.platform,
    userId: message.userId,
    chatId: message.chatId,
    chatType: message.chatType,
    threadId: message.threadId,
    attachmentCount: message.attachments.length,
    textChars: message.text.length,
  };
}

function errorLogData(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return String(err);
}

export class AgentBridge {
  private approvalManager: ToolApprovalManager;
  private currentMessage?: UnifiedMessage;
  private echoMessages: OutgoingMessage[] = [];
  private inboundHadAudio = false;

  constructor(
    private config: MyClawConfig,
    private toolRegistry: ToolRegistry,
    private skillRegistry: SkillRegistry,
    private voiceManager: VoiceManager,
    private sttPipeline: SttPipeline,
    private ttsPipeline: TtsPipeline,
    private depth: number = 0,
    private workspaceDir?: string,
  ) {
    this.approvalManager = new ToolApprovalManager(config.blacklist);
  }

  getEchoMessages(): OutgoingMessage[] {
    const echoes = [...this.echoMessages];
    this.echoMessages = [];
    return echoes;
  }

  hadAudioInbound(): boolean {
    return this.inboundHadAudio;
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.approvalManager.setHandler(handler);
  }

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

  private async preprocessAudio(message: UnifiedMessage): Promise<TranscriptionResult> {
    const audioAttachments = message.attachments.filter((a) => a.type === "audio");
    if (audioAttachments.length === 0) {
      return { text: "" };
    }

    this.inboundHadAudio = true;
    const att = audioAttachments[0]!;

    // Media unavailable (encrypted, download failed, too large)
    if (!att.path) {
      const isEncrypted = att.summaryText?.includes("unavailable") ?? false;
      const reason = isEncrypted
        ? "Ce media est chiffre (E2EE) et inaccessible. Verifie mon device dans la room ou envoie un message non-chiffre."
        : "Media non telecharge (indisponible ou trop volumineux).";

      const existingText = message.text ? message.text.trim() : "";
      const audioPrefix = existingText ? `\n\n` : "";
      message.text = `${existingText}${audioPrefix}[Audio]: [unavailable — ${reason}]`;

      const { enabled } = this.voiceManager.getEchoConfig();
      if (enabled) {
        this.echoMessages.push({
          text: `⚠️ ${reason}`,
          replyToId: message.id,
          threadId: message.threadId,
        });
      }

      return { text: "", error: reason };
    }

    try {
      const { stat } = await import("node:fs/promises");
      const fileStat = await stat(att.path);
      void log("info", "STT processing audio", { path: att.path, size: fileStat.size, mimeType: att.mimeType });

      const result = await this.sttPipeline.transcribe(att.path);
      const existingText = message.text ? message.text.trim() : "";
      const audioPrefix = existingText ? `\n\n` : "";
      message.text = `${existingText}${audioPrefix}[Audio]: "${result.text}"`;

      const { enabled } = this.voiceManager.getEchoConfig();
      if (enabled) {
        this.echoMessages.push({
          text: this.voiceManager.formatEcho(result.text),
          replyToId: message.id,
          threadId: message.threadId,
        });
      }

      return { text: result.text };
    } catch (err) {
      const errorMsg = String(err);
      const existingText = message.text ? message.text.trim() : "";
      const audioPrefix = existingText ? `\n\n` : "";
      message.text = `${existingText}${audioPrefix}[Audio]: [Transcription failed: ${errorMsg}]`;

      const { enabled } = this.voiceManager.getEchoConfig();
      if (enabled) {
        this.echoMessages.push({
          text: `⚠️ STT failed: ${errorMsg}`,
          replyToId: message.id,
          threadId: message.threadId,
        });
      }

      return { text: "", error: errorMsg };
    }
  }

  async preprocessMessage(message: UnifiedMessage): Promise<void> {
    if (this.currentMessage?.id === message.id) return;
    this.currentMessage = message;
    this.echoMessages = [];
    this.inboundHadAudio = false;
    await this.preprocessAudio(message);
  }

  private async handle(
    message: UnifiedMessage,
    session: SessionData,
    onToken?: (token: string) => Promise<void>,
    onToolUse?: () => Promise<void>,
  ): Promise<string> {
    if (this.currentMessage?.id !== message.id) {
      this.currentMessage = message;
      this.echoMessages = [];
      this.inboundHadAudio = false;
      await this.preprocessAudio(message);
    }

    const tools = this.toolRegistry.getForAgent(this.depth === 0 ? "main" : this.depth === 1 ? "general" : "research");
    const model = session.modelOverride ?? this.config.llm.model;
    const llmConfig = { ...this.config.llm, model };
    const startedAt = Date.now();
    const streaming = Boolean(onToken);
    let toolExecutions = 0;

    void log("info", "agent run started", {
      ...runLogData(message, session),
      model,
      streaming,
      toolCount: tools.length,
      sessionMessageCount: session.messages.length,
    });

    try {
      const systemPrompt = await buildSystemPrompt({
        platform: message.platform,
        model,
        channelId: message.chatId,
        sessionId: session.id,
        tools,
        skills: this.skillRegistry.list(),
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
        const iteration = i + 1;
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
          void log("info", "agent run finished", {
            ...runLogData(message, session),
            model,
            streaming,
            iteration,
            toolExecutions,
            responseChars: response.content.length,
            sessionMessageCount: session.messages.length,
            durationMs: Date.now() - startedAt,
          });
          return response.content;
        }

        void log("info", "agent requested tool calls", {
          ...runLogData(message, session),
          model,
          iteration,
          toolCallCount: response.toolCalls.length,
          tools: response.toolCalls.map((tc) => tc.name),
        });

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
          const toolStartedAt = Date.now();
          void log("info", "tool execution started", {
            ...runLogData(message, session),
            model,
            iteration,
            toolCallId: tc.id,
            tool: tc.name,
            argKeys: Object.keys(tc.arguments),
          });

          const result = await this.executeTool({
            name: tc.name,
            args: tc.arguments,
            message,
            session,
            toolCallId: tc.id,
          });
          toolExecutions += 1;

          void log(result.success ? "info" : "warn", "tool execution finished", {
            ...runLogData(message, session),
            model,
            iteration,
            toolCallId: tc.id,
            tool: tc.name,
            success: result.success,
            outputChars: result.content.length,
            durationMs: Date.now() - toolStartedAt,
          });

          chatMessages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
          session.messages.push({ role: "tool", toolCallId: tc.id, content: result.content, timestamp: new Date().toISOString() });
        }
      }

      const fallback = "Reached maximum tool call iterations. Stopping here.";
      session.messages.push({ role: "assistant", content: fallback, timestamp: new Date().toISOString() });
      void log("warn", "agent run reached tool iteration limit", {
        ...runLogData(message, session),
        model,
        streaming,
        toolExecutions,
        maxToolIterations: MAX_TOOL_ITERATIONS,
        durationMs: Date.now() - startedAt,
      });
      return fallback;
    } catch (err) {
      void log("error", "agent run failed", {
        ...runLogData(message, session),
        model,
        streaming,
        toolExecutions,
        durationMs: Date.now() - startedAt,
        error: errorLogData(err),
      });
      throw err;
    }
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
    // Filter out audio attachments that were already transcribed —
    // the transcript is in message.text, raw audio binary would only waste tokens
    const visibleAttachments = message.attachments.filter((a) => a.type !== "audio");
    if (visibleAttachments.length > 0) {
      const lines = visibleAttachments.map((a) => {
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

  private async executeTool(params: {
    name: string;
    args: Record<string, unknown>;
    message: UnifiedMessage;
    session: SessionData;
    toolCallId: string;
  }): Promise<{ content: string; success: boolean }> {
    const tool = this.toolRegistry.get(params.name);
    if (!tool) {
      return {
        success: false,
        content: `Error: unknown tool "${params.name}"`,
      };
    }

    const approvalDecision = await this.approvalManager.decide({
      session: params.session,
      request: {
        id: params.toolCallId,
        platform: params.message.platform,
        chatId: params.message.chatId,
        userId: params.message.userId,
        chatType: params.message.chatType,
        messageId: params.message.id,
        sessionId: params.session.id,
        toolName: params.name,
        args: params.args,
        replyToId: params.message.replyToId,
        threadId: params.message.threadId,
      },
    });
    if (approvalDecision === "deny") {
      return {
        success: false,
        content: `Error: tool "${params.name}" was denied by approval policy`,
      };
    }

    try {
      const enrichedArgs = {
        ...params.args,
        __depth: this.depth,
        __message: this.currentMessage,
        __workspaceDir: this.workspaceDir,
      };
      const result = await tool.execute(enrichedArgs);
      if (result.success) {
        return {
          success: true,
          content: result.output,
        };
      }
      return {
        success: false,
        content: `Error: ${result.error ?? result.output}`,
      };
    } catch (err) {
      void log("error", "tool execution failed", { tool: params.name, error: errorLogData(err) });
      return {
        success: false,
        content: `Error: ${String(err)}`,
      };
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
