import type { ResolvedLlmConfig } from "../core/config.ts";
import type { LlmUsage } from "./provider.ts";
import { estimateTokens } from "./tokens.ts";

// Synthetic reported 613 reasoning tokens out of 615 alongside 2,042 answer characters and
// no reasoning text. Estimates are approximate and other endpoints may account for output differently.
export function syntheticReasoningMismatch(
  config: ResolvedLlmConfig,
  content: string,
  reasoning: string,
  usage: LlmUsage | undefined,
): boolean {
  if (!usage || reasoning) return false;
  if ((config.apiModel ?? config.model) !== "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017") return false;
  if (URL.parse(config.baseUrl)?.hostname !== "api.synthetic.new") return false;
  const { completionTokens, reasoningTokens = 0 } = usage;
  if (!Number.isSafeInteger(completionTokens) || !Number.isSafeInteger(reasoningTokens) ||
      reasoningTokens <= 0 || reasoningTokens > completionTokens) return false;
  return estimateTokens(content.trim()) > 2 * (completionTokens - reasoningTokens) + 16;
}
