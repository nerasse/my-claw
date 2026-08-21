import type { ResolvedLlmConfig } from "../core/config.ts";
import type { ReasoningSink } from "../agent/backend.ts";
import { chatCompletion, chatCompletionStream, type ChatMessage, type LlmResponse } from "./provider.ts";
import { codexResponse, codexResponseStream } from "./codex.ts";
import { anthropicResponse, anthropicResponseStream } from "./anthropic.ts";

/**
 * One call, routed to the wire protocol the resolved model actually speaks.
 *
 * Its own module because it has three callers with nothing else in common: the agent loop, the
 * compaction summarizer and memory consolidation. The last two used to call `chatCompletion`
 * directly and force their model onto an OpenAI-compatible one, which meant a 1M-context Opus
 * session was summarized by whichever chat-completions model happened to be listed first.
 */
export function llmComplete(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<LlmResponse> {
  if (config.backend === "codex") return codexResponse(config, messages, tools, signal);
  if (config.backend === "anthropic") return anthropicResponse(config, messages, tools, signal);
  return chatCompletion(config, messages, tools, signal);
}

export function llmCompleteStream(
  config: ResolvedLlmConfig,
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
  signal?: AbortSignal,
  reasoningSink?: ReasoningSink,
): Promise<LlmResponse> {
  if (config.backend === "codex") return codexResponseStream(config, messages, onToken, tools, signal, reasoningSink);
  if (config.backend === "anthropic") return anthropicResponseStream(config, messages, onToken, tools, signal, reasoningSink);
  return chatCompletionStream(config, messages, onToken, tools, signal, reasoningSink);
}
