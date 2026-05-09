import type { Tool, ToolResult } from "./types.ts";
import type { VoiceManager } from "../voice/manager.ts";

export function createVoiceModeTool(manager: VoiceManager): Tool {
  return {
    name: "voice_mode",
    description: "Configure voice mode (cloud/local/auto) for STT and/or TTS. Changes are runtime only and do not require a reboot.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["cloud", "local", "auto"],
          description: "Voice mode to set",
        },
        feature: {
          type: "string",
          enum: ["stt", "tts", "all"],
          description: "Target feature. 'all' sets the global mode. Defaults to 'all'.",
        },
      },
      required: ["mode"],
    },
    async execute(args): Promise<ToolResult> {
      const mode = args.mode as "cloud" | "local" | "auto";
      const feature = (args.feature as "stt" | "tts" | "all" | undefined) ?? "all";

      if (!["cloud", "local", "auto"].includes(mode)) {
        return { success: false, output: "", error: `Invalid mode: ${mode}` };
      }

      try {
        if (feature === "all") {
          manager.setGlobalMode(mode);
          return { success: true, output: `Global voice mode set to ${mode}` };
        }
        manager.setFeatureMode(feature, mode);
        return { success: true, output: `Voice ${feature} mode set to ${mode}` };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
