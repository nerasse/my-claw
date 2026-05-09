import type { Tool, ToolResult } from "./types.ts";
import type { TtsPipeline } from "../voice/tts.ts";

export function createTtsTool(pipeline: TtsPipeline): Tool {
  return {
    name: "tts",
    description: "Generate audio from text using the configured voice engine (cloud: Edge TTS, local: Piper). Returns the path to the generated audio file.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to convert to speech",
        },
        voice: {
          type: "string",
          description: "Voice ID override. Optional. Example: 'fr-FR-RemyMultilingualNeural' for cloud, 'fr_FR-siwis-medium' for local.",
        },
        forceCloud: {
          type: "boolean",
          description: "Force cloud provider for this call",
        },
        forceLocal: {
          type: "boolean",
          description: "Force local provider for this call",
        },
      },
      required: ["text"],
    },
    async execute(args): Promise<ToolResult> {
      const text = args.text as string;
      if (!text) {
        return { success: false, output: "", error: "text is required" };
      }

      try {
        const result = await pipeline.generate(text, {
          voice: args.voice as string | undefined,
          forceCloud: args.forceCloud as boolean | undefined,
          forceLocal: args.forceLocal as boolean | undefined,
        });
        return { success: true, output: result.path };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
