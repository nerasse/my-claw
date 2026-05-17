import { type Tool, type ToolResult, str } from "./types.ts";
import type { SttPipeline } from "../voice/stt.ts";

export function createSttTool(pipeline: SttPipeline): Tool {
  return {
    name: "stt",
    description: "Transcribe an audio file to text. Respects voice mode configuration (cloud or local).",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the audio file to transcribe",
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
        const result = await pipeline.transcribe(filePath);
        return { success: true, output: result.text };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
