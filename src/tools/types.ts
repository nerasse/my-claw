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
  /** `onProgress` lets a long-running tool stream output as it is produced rather than only at
   *  EOF (bash today; the others ignore it). The callback fires with stdout/stderr chunks; the
   *  caller is responsible for throttling and appending to the final ToolResult.output. */
  execute(args: Record<string, unknown>, onProgress?: (chunk: ToolProgress) => void): Promise<ToolResult>;
}

export interface ToolProgress {
  stdout?: string;
  stderr?: string;
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

export function numOpt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

/** Same grammar as `bool`, but absent stays absent: "don't touch" is not "false". */
export function boolOpt(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
