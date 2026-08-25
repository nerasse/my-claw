import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AgentBridge } from "../../src/agent/bridge.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { SkillRegistry } from "../../src/skills/registry.ts";
import { VoiceManager } from "../../src/voice/manager.ts";
import { SttPipeline } from "../../src/voice/stt.ts";
import { TtsPipeline } from "../../src/voice/tts.ts";
import { runRegistry } from "../../src/core/run-registry.ts";
import { setupSessionLog, writeLegacySessionFile } from "../helpers/session-log.ts";
import type { MyClawConfig } from "../../src/core/config.ts";
import type { UnifiedMessage } from "../../src/channels/types.ts";
import { deleteSession, type LegacySessionData } from "../../src/sessions/store.ts";
import type { SessionLog, UserEntry } from "../../src/sessions/log.ts";

const SESSION_ID = "test-voice";

function createConfig(overrides?: Record<string, unknown>): MyClawConfig {
  return {
    whitelist: [],
    blacklist: [],
    channels: {},
    agents: {},
    llm: { provider: "test", baseUrl: "http://test", model: "test", apiKey: "test" },
    memory: { enabled: false },
    ...overrides,
  } as MyClawConfig;
}

function createMessage(overrides?: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: "1",
    platform: "my-claw-app",
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

function createSession(): LegacySessionData {
  return {
    id: SESSION_ID,
    platform: "my-claw-app",
    chatType: "dm",
    messages: [],
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

let log: SessionLog;
let cleanupLog: () => void;

beforeEach(async () => {
  await deleteSession(SESSION_ID);
  await writeLegacySessionFile(SESSION_ID, createSession());
  const setup = await setupSessionLog(SESSION_ID);
  log = setup.log;
  cleanupLog = setup.cleanup;
});

afterEach(() => {
  cleanupLog();
  runRegistry.clear();
});

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
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

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
      await bridge.handleMessage(message, session, signal);
    } catch {
      // Expected to fail due to mocked LLM.
    } finally {
      end();
    }

    await log.flush();
    const userEntry = log.entries().find((e): e is UserEntry => e.type === "user");
    expect(userEntry).toBeDefined();
    expect(userEntry!.text).toContain("[Audio]:");
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
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/test.ogg" },
      ],
    });
    const session = createSession();

    expect(bridge.hadAudioInbound(message.id)).toBe(false);

    try {
      await bridge.handleMessage(message, session, signal);
    } catch {
      // Expected.
    } finally {
      end();
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
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const message = createMessage({ text: "hello" });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session, signal);
    } catch {
      // Expected.
    } finally {
      end();
    }

    expect(bridge.hadAudioInbound(message.id)).toBe(false);
  });

  test("lists the audio file alongside its transcript in the LLM prompt", async () => {
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
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const message = createMessage({
      text: "check this",
      attachments: [
        { type: "audio", path: "/tmp/test.ogg", mimeType: "audio/ogg" },
        { type: "image", path: "/tmp/photo.jpg", mimeType: "image/jpeg" },
      ],
    });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session, signal);
    } catch {
      // Expected to fail due to mocked LLM.
    } finally {
      end();
    }

    // The transcript is what the agent reads; the path is what lets it act on the recording.
    await log.flush();
    const userEntry = log.entries().find((e): e is UserEntry => e.type === "user");
    expect(userEntry).toBeDefined();
    const attachmentsMatch = userEntry!.text.match(/\[Attachments\][\s\S]*/);
    expect(attachmentsMatch).not.toBeNull();
    expect(attachmentsMatch![0]).toContain("image");
    expect(attachmentsMatch![0]).toContain("- audio: /tmp/test.ogg");
  });

  test("a failed transcription still leaves the file listed", async () => {
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
    const { signal, end } = runRegistry.startRoot(SESSION_ID);

    const message = createMessage({
      attachments: [
        { type: "audio", path: "/tmp/nonexistent.ogg" },
      ],
    });
    const session = createSession();

    try {
      await bridge.handleMessage(message, session, signal);
    } catch {
      // Expected.
    } finally {
      end();
    }

    await log.flush();
    const userEntry = log.entries().find((e): e is UserEntry => e.type === "user");
    expect(userEntry).toBeDefined();
    expect(userEntry!.text).toContain("[Audio]: [Transcription failed");
    // The words are lost, so the file is the only thing left to work with.
    expect(userEntry!.text).toContain("- audio: /tmp/nonexistent.ogg");
  });
});
