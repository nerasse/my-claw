import { type Tool, type ToolResult, str, strOpt, bool } from "./types.ts";
import type { TtsPipeline } from "../voice/tts.ts";

export function createTtsTool(pipeline: TtsPipeline): Tool {
  return {
    name: "tts",
    description: "Generate audio from text using the configured voice engine (cloud: Edge TTS, local: Piper). Returns the path to the generated audio file; it is not sent until your answer includes MEDIA:<path>.",
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
      const text = str(args, "text");
      if (!text) {
        return { success: false, output: "", error: "text is required" };
      }

      try {
        const result = await pipeline.generate(text, {
          voice: strOpt(args, "voice"),
          forceCloud: bool(args, "forceCloud", false),
          forceLocal: bool(args, "forceLocal", false),
        });
        return {
          success: true,
          // Not sent by itself: the answer sends it, once, the version the agent keeps.
          output: `Audio generated: ${result.path}\nNot sent yet. To send it, put MEDIA:${result.path} in your answer.`,
          keepFromReply: true,
          attachments: [
            {
              type: "audio",
              path: result.path,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
