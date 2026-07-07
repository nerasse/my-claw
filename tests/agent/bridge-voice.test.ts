import { describe, test, expect } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import type { SessionData } from "../../src/sessions/store.ts";

function createConfig(overrides?: Record<string, unknown>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test", apiKey: "test" },
    ...overrides,
  } as MyClawConfig;
}

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "1",
    platform: "telegram",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  };
}

function createSession(): SessionData {
  return {
    id: "test-session",
    platform: "telegram",
    chatType: "dm",
    messages: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

describe("AgentBridge voice integration", () => {
  test("preprocesses audio attachments and adds echo", async () => {
    const config = createConfig();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry(new Map());
    const voiceManager = new VoiceManager(config);
    const sttPipeline = new SttPipeline(voiceManager);
    const ttsPipeline = new TtsPipeline(voiceManager);

    const bridge = new AgentBridge(
      config,
      toolRegistry,
      skillRegistry,
      voiceManager,
      sttPipeline,
    );

    const message = createMessage({
      text: "check this audio",
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
      ],
    });
    const session = createSession();

    // Mock the LLM call to avoid actual network requests.
    // Since we can't easily mock the provider here, we verify preprocessing
    // indirectly via echo messages. The STT will fail (no server), but the
    // attachment should still be processed.
    try {
      await bridge.handleMessage(message, session);
    } catch {
      // Expected to fail due to mocked LLM.
    }

    const userMessage = session.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toContain("[Audio]:");
  });

  test("flags inbound audio correctly", async () => {
    const config = createConfig();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry(new Map());
    const voiceManager = new VoiceManager(config);
    const sttPipeline = new SttPipeline(voiceManager);
    const ttsPipeline = new TtsPipeline(voiceManager);

    const bridge = new AgentBridge(
      config,
      toolRegistry,
      skillRegistry,
      voiceManager,
      sttPipeline,
    );

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/test.ogg" },
      ],
    });
    const session = createSession();

    expect(bridge.hadAudioInbound(message.id)).toBe(false);

    try {
      await bridge.handleMessage(message, session);
    } catch {
      // Expected.
    }

    expect(bridge.hadAudioInbound(message.id)).toBe(true);
  });

  test("does not flag inbound audio when no audio attachments", async () => {
    const config = createConfig();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry(new Map());
    const voiceManager = new VoiceManager(config);
    const sttPipeline = new SttPipeline(voiceManager);
    const ttsPipeline = new TtsPipeline(voiceManager);

    const bridge = new AgentBridge(
      config,
      toolRegistry,
      skillRegistry,
      voiceManager,
      sttPipeline,
    );

    const message = createMessage({ text: "hello" });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session);
    } catch {
      // Expected.
    }

    expect(bridge.hadAudioInbound(message.id)).toBe(false);
  });

  test("hides audio attachments from LLM prompt after transcription", async () => {
    const config = createConfig();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry(new Map());
    const voiceManager = new VoiceManager(config);
    const sttPipeline = new SttPipeline(voiceManager);
    const ttsPipeline = new TtsPipeline(voiceManager);

    const bridge = new AgentBridge(
      config,
      toolRegistry,
      skillRegistry,
      voiceManager,
      sttPipeline,
    );

    const message = createMessage({
      text: "check this",
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
        { type: "image", path: "/tmp/photo.jpg", mimeType: "image/jpeg" },
      ],
    });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session);
    } catch {
      // Expected to fail due to mocked LLM.
    }

    // Check that the user message in session does not contain the audio attachment
    const userMessage = session.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    // Audio attachment should not appear in the [Attachments] section
    // (it was already transcribed into [Audio]: ...)
    const attachmentsMatch = userMessage!.content.match(/\[Attachments\][\s\S]*/);
    if (attachmentsMatch) {
      expect(attachmentsMatch[0]).toContain("image");
      expect(attachmentsMatch[0]).not.toContain("audio");
      expect(attachmentsMatch[0]).not.toContain("test.ogg");
    }
  });

  test("hides audio attachments even when STT fails", async () => {
    const config = createConfig();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry(new Map());
    const voiceManager = new VoiceManager(config);
    const sttPipeline = new SttPipeline(voiceManager);
    const ttsPipeline = new TtsPipeline(voiceManager);

    const bridge = new AgentBridge(
      config,
      toolRegistry,
      skillRegistry,
      voiceManager,
      sttPipeline,
    );

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/nonexistent.ogg" },
      ],
    });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session);
    } catch {
      // Expected.
    }

    const userMessage = session.messages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    expect(userMessage!.content).toContain("[Audio]: [Transcription failed");
    expect(userMessage!.content).not.toContain("[Attachments]");
  });
});
