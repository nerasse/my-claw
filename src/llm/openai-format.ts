import type { Tool } from "../tools/types.ts";

export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export function toOpenAiToolDefinitions(tools: Tool[]): OpenAiToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toOpenAiToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> | string }>,
): OpenAiToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
}
