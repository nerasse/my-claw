import type { MyClawConfig } from "../config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export async function chatCompletion(
  config: MyClawConfig["llm"],
  messages: ChatMessage[],
  tools?: unknown[],
): Promise<LlmResponse> {
  const apiKey = config.apiKey ?? process.env["FIREWORKS_API_KEY"] ?? process.env["OPENAI_API_KEY"];

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };
  if (tools && tools.length > 0) {
    body["tools"] = tools;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: Array<{
      message: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };

  const choice = data.choices[0];
  if (!choice) throw new Error("No response from LLM");

  return {
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    })),
  };
}
