import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import type { SttPipeline } from "../voice/stt.ts";

export function createSttTool(pipeline: SttPipeline): Tool {
  return {
    name: "stt",
    description: "Transcribe an audio file to text. Respects voice mode configuration (cloud or local). Language is auto-detected unless you pass one, so set `language` when you already know it and the audio is short or noisy — and leave it out for anything you are not sure about, because a forced language makes the transcriber invent plausible text instead of failing.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the audio file to transcribe",
        },
        language: {
          type: "string",
          description: "Optional ISO code (fr, en, es...). Omit to auto-detect.",
        },
      },
      required: ["filePath"],
    },
    async execute(args): Promise<ToolResult> {
      const filePath = str(args, "filePath");
      if (!filePath) {
        return { success: false, output: "", error: "filePath is required" };
      }

      try {
        const result = await pipeline.transcribe(filePath, strOpt(args, "language"));
        return { success: true, output: result.text };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
