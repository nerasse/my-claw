import { type Tool, type ToolResult, str, strOpt, bool } from "./types.ts";
import type { SttPipeline } from "../voice/stt.ts";
import type { TtsPipeline } from "../voice/tts.ts";
import type { VoiceManager } from "../voice/manager.ts";

type Mode = "cloud" | "local" | "auto";
const MODES: readonly string[] = ["cloud", "local", "auto"];

/**
 * Speech in both directions and the engine that does it, as one tool: `transcribe` (an audio file
 * to text), `speak` (text to an audio file), `mode` (cloud, local or auto). Three tools of their
 * own once, rare calls all three, and three definitions on every request of the orchestrator
 * (2026-10-04). Thin wrappers over voice/, as before.
 */
export function createAudioTool(voice: { stt: SttPipeline; tts: TtsPipeline; manager: VoiceManager }): Tool {
  async function transcribe(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = str(args, "filePath");
    if (!filePath) return { success: false, output: "", error: "transcribe needs filePath" };
    const result = await voice.stt.transcribe(filePath, strOpt(args, "language"));
    return { success: true, output: result.text };
  }

  async function speak(args: Record<string, unknown>): Promise<ToolResult> {
    const text = str(args, "text");
    if (!text) return { success: false, output: "", error: "speak needs text" };
    const result = await voice.tts.generate(text, {
      voice: strOpt(args, "voice"),
      forceCloud: bool(args, "forceCloud", false),
      forceLocal: bool(args, "forceLocal", false),
    });
    return {
      success: true,
      // Not sent by itself: the answer sends it, once, the version the agent keeps.
      output: `Audio generated: ${result.path}\nNot sent yet. To send it, put MEDIA:${result.path} in your answer.`,
      keepFromReply: true,
      attachments: [{ type: "audio", path: result.path, mimeType: result.mimeType }],
    };
  }

  function setMode(args: Record<string, unknown>): ToolResult {
    const mode = str(args, "mode");
    if (!MODES.includes(mode)) return { success: false, output: "", error: `Invalid mode: ${mode || "(none)"}. Use cloud, local or auto.` };
    const feature = strOpt(args, "feature") ?? "all";
    if (feature === "all") {
      voice.manager.setGlobalMode(mode as Mode);
      return { success: true, output: `Global voice mode set to ${mode}` };
    }
    if (feature !== "stt" && feature !== "tts") return { success: false, output: "", error: `Invalid feature: ${feature}. Use stt, tts or all.` };
    voice.manager.setFeatureMode(feature, mode as Mode);
    return { success: true, output: `Voice ${feature} mode set to ${mode}` };
  }

  return {
    name: "audio",
    description:
      "Speech, both ways. action='transcribe' (filePath): an audio file to text; the language is auto-detected unless " +
      "you pass `language`, so set it when you already know it and the audio is short or noisy, and leave it out " +
      "otherwise, because a forced language makes the transcriber invent plausible text instead of failing. " +
      "action='speak' (text): text to an audio file (cloud: Edge TTS, local: Piper); it is not sent until your answer " +
      "includes MEDIA:<path>. action='mode' (mode, feature): set the voice engine to cloud, local or auto, at runtime.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["transcribe", "speak", "mode"] },
        filePath: { type: "string", description: "transcribe: absolute path to the audio file" },
        language: { type: "string", description: "transcribe: optional ISO code (fr, en, es...). Omit to auto-detect." },
        text: { type: "string", description: "speak: the text to say" },
        voice: { type: "string", description: "speak: optional voice id, e.g. 'fr-FR-RemyMultilingualNeural' (cloud), 'fr_FR-siwis-medium' (local)" },
        forceCloud: { type: "boolean", description: "speak: force the cloud engine for this call" },
        forceLocal: { type: "boolean", description: "speak: force the local engine for this call" },
        mode: { type: "string", enum: ["cloud", "local", "auto"], description: "mode: the engine to use" },
        feature: { type: "string", enum: ["stt", "tts", "all"], description: "mode: which side; 'all' (default) sets the global mode" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      try {
        if (action === "transcribe") return await transcribe(args);
        if (action === "speak") return await speak(args);
        if (action === "mode") return setMode(args);
        return { success: false, output: "", error: `Unknown action "${action}": use transcribe, speak or mode.` };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
