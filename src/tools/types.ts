import type { Attachment } from "../channels/types.ts";

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  attachments?: Attachment[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
