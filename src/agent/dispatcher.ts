import type { MyClawConfig } from "../core/config.ts";
import type { ToolApprovalHandler, UnifiedMessage, OutgoingMessage } from "../channels/types.ts";
import type { SessionData } from "../sessions/store.ts";
import type { AgentBackend, TokenCallback, ToolUseCallback, TurnSwitchCallback } from "./backend.ts";
import { AgentBridge } from "./bridge.ts";
import { ClaudeSdkBackend } from "./claude-sdk/backend.ts";
import { MessagePreprocessor } from "./preprocess.ts";
import { resolveLlmConfigForMessage } from "../llm/resolver.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { SkillRegistry } from "../skills/registry.ts";
import type { VoiceManager, SttPipeline } from "../voice/index.ts";

/**
 * Routes each run to the engine of its resolved model: the home OpenAI-compatible loop
 * or the Claude Agent SDK (docs/claude-sdk-backend.md). The choice is per run, driven by
 * `providers[].type` and the session's `modelOverride`, so `/model` flips a chat between
 * engines with zero process state. Both backends share one preprocessor: echoes and
 * response attachments stay retrievable regardless of which engine handled the message.
 */
export class BackendDispatcher implements AgentBackend {
  private preprocessor: MessagePreprocessor;
  private home: AgentBridge;
  private sdk: ClaudeSdkBackend;

  constructor(
    private config: MyClawConfig,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    voiceManager?: VoiceManager,
    sttPipeline?: SttPipeline,
    // Test seam: routing behavior is observable without spinning real engines.
    overrides?: { home?: AgentBridge; sdk?: ClaudeSdkBackend },
  ) {
    this.preprocessor = new MessagePreprocessor(voiceManager, sttPipeline);
    this.home = overrides?.home ?? new AgentBridge(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor,
    );
    this.sdk = overrides?.sdk ?? new ClaudeSdkBackend(
      config, toolRegistry, skillRegistry, voiceManager, sttPipeline,
      0, undefined, undefined, undefined, this.preprocessor,
    );
  }

  private backendFor(message: UnifiedMessage, session: SessionData): AgentBackend {
    const resolved = resolveLlmConfigForMessage(
      this.config.llm,
      session.modelOverride,
      message.attachments.some((a) => a.type === "image" && Boolean(a.path)),
    );
    return resolved.backend === "claude-sdk" ? this.sdk : this.home;
  }

  preprocessMessage(message: UnifiedMessage): Promise<void> {
    return this.preprocessor.preprocessMessage(message);
  }

  getEchoMessages(messageId: string): OutgoingMessage[] {
    return this.preprocessor.consumeEchoMessages(messageId);
  }

  getResponseAttachments(messageId: string): OutgoingMessage["attachments"] {
    return this.preprocessor.consumeResponseAttachments(messageId);
  }

  hadAudioInbound(messageId: string): boolean {
    return this.preprocessor.inboundHadAudio(messageId);
  }

  setApprovalHandler(handler: ToolApprovalHandler | undefined): void {
    this.home.setApprovalHandler(handler);
    this.sdk.setApprovalHandler(handler);
  }

  handleMessage(message: UnifiedMessage, session: SessionData, signal?: AbortSignal): Promise<string> {
    return this.backendFor(message, session).handleMessage(message, session, signal);
  }

  handleMessageStreaming(
    message: UnifiedMessage,
    session: SessionData,
    onToken: TokenCallback,
    onToolUse?: ToolUseCallback,
    signal?: AbortSignal,
    onTurnSwitch?: TurnSwitchCallback,
  ): Promise<string> {
    return this.backendFor(message, session).handleMessageStreaming(message, session, onToken, onToolUse, signal, onTurnSwitch);
  }
}
