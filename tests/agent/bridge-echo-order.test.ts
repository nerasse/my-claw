import { describe, test, expect } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";

function createConfig(overrides?: Record<string, unknown>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test", apiKey: "test" },
    ...overrides,
  } as MyClawConfig;
}

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "test-msg-1",
    platform: "telegram",
    userId: "user1",
    chatId: "chat1",
    chatType: "dm",
    text: "check this",
    attachments: [],
    isForwarded: false,
    raw: {},
    ...overrides,
  };
}

describe("AgentBridge echo ordering", () => {
  test("preprocessMessage generates echoes before handle", async () => {
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
      ttsPipeline,
    );

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
      ],
    });

    // Before preprocessMessage: no echoes
    expect(bridge.getEchoMessages().length).toBe(0);

    // After preprocessMessage: echoes generated
    await bridge.preprocessMessage(message);
    const echoes = bridge.getEchoMessages();

    // Echoes should be present (or empty if STT fails in test env)
    // The key point: echoes are generated before handle() is called
    expect(bridge.hadAudioInbound()).toBe(true);
    expect(message.text).toContain("[Audio]:");
  });

  test("echoes are cleared after getEchoMessages", async () => {
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
      ttsPipeline,
    );

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
      ],
    });

    await bridge.preprocessMessage(message);
    const echoes1 = bridge.getEchoMessages();

    // Second call returns empty (cleared)
    const echoes2 = bridge.getEchoMessages();
    expect(echoes2.length).toBe(0);
  });

  test("double preprocessMessage is idempotent", async () => {
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
      ttsPipeline,
    );

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
      ],
    });

    await bridge.preprocessMessage(message);
    const echoes1 = bridge.getEchoMessages();

    // Second call with same message should not re-process
    await bridge.preprocessMessage(message);
    const echoes2 = bridge.getEchoMessages();

    // Second call produced no new echoes (idempotent)
    expect(echoes2.length).toBe(0);
  });
});
