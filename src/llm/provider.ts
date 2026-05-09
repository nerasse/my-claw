import type { MyClawConfig } from "../core/config.ts";

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ChatCompletionResponse {
  choices: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

function resolveApiKey(config: MyClawConfig["llm"]): string | undefined {
  return config.apiKey ?? process.env["FIREWORKS_API_KEY"] ?? process.env["OPENAI_API_KEY"];
}

function buildRequestBody(
  config: MyClawConfig["llm"],
  messages: ChatMessage[],
  tools?: unknown[],
  stream?: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  if (tools && tools.length > 0) {
    body["tools"] = tools;
  }
  if (stream) {
    body["stream"] = true;
  }
  if (config.limit?.output) {
    body["max_tokens"] = config.limit.output;
  }

  return body;
}

function parseToolCalls(
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>,
): ToolCall[] | undefined {
  return toolCalls?.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments.trim() ? JSON.parse(tc.function.arguments) : {},
  }));
}

export async function chatCompletion(
  config: MyClawConfig["llm"],
  messages: ChatMessage[],
  tools?: unknown[],
): Promise<LlmResponse> {
  const apiKey = resolveApiKey(config);

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody(config, messages, tools)),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;

  const choice = data.choices[0];
  if (!choice?.message) throw new Error("No response from LLM");

  return {
    content: choice.message.content ?? "",
    toolCalls: parseToolCalls(choice.message.tool_calls),
  };
}

export async function chatCompletionStream(
  config: MyClawConfig["llm"],
  messages: ChatMessage[],
  onToken: (token: string) => Promise<void> | void,
  tools?: unknown[],
): Promise<LlmResponse> {
  const apiKey = resolveApiKey(config);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildRequestBody(config, messages, tools, true)),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("LLM stream response has no body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  const handleChunk = async (payload: ChatCompletionStreamChunk): Promise<void> => {
    const delta = payload.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      await onToken(delta.content);
    }

    for (const toolCall of delta.tool_calls ?? []) {
      const index = toolCall.index ?? 0;
      const entry = toolCalls.get(index) ?? { id: `call_${index}`, name: "", arguments: "" };
      if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
        entry.id = toolCall.id;
      }
      if (typeof toolCall.function?.name === "string" && toolCall.function.name.length > 0) {
        entry.name += toolCall.function.name;
      }
      if (typeof toolCall.function?.arguments === "string" && toolCall.function.arguments.length > 0) {
        entry.arguments += toolCall.function.arguments;
      }
      toolCalls.set(index, entry);
    }
  };

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);

      if (rawLine.startsWith("data: ")) {
        const data = rawLine.slice(6);
        if (data === "[DONE]") {
          buffer = "";
          break;
        }
        if (data) {
          await handleChunk(JSON.parse(data) as ChatCompletionStreamChunk);
        }
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  const streamedToolCalls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, toolCall]) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments.trim() ? JSON.parse(toolCall.arguments) : {},
    }));

  return {
    content,
    toolCalls: streamedToolCalls.length > 0 ? streamedToolCalls : undefined,
  };
}
