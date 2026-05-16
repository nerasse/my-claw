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

/** Runtime-safe argument extraction from LLM-provided tool args. */
export function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  return String(v);
}

export function strOpt(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

export function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}
