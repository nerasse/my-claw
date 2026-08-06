# my-claw

Personal AI agent orchestrator built on top of pi-mono.

## What It Does

my-claw is a single-tenant personal agent that connects to Telegram and Matrix, handles messages, runs tools, manages sessions, and understands multimodal input (voice, images, video).

**Core capabilities:**
- Multi-channel: Telegram (grammy) + Matrix (matrix-js-sdk)
- Session memory: per-user/per-room persistent sessions
- Tool system: 8 base (bash, read, write, fetch, find, grep, ls, memory) + voice, browser, skill, subagent, search tools
- Sub-agents: general and research agents with persistent sessions
- Voice: STT auto (inbound audio transcribed), TTS manual (tool call only)
- Vision: images and video converted to LLM-compatible format
- Skills: built-in/custom/workspace skill system (SKILL.md format)
- Blacklist + approval UI for sensitive actions
- Streaming responses on both channels

## Architecture

- TypeScript, Bun runtime
- OpenAI-compatible LLM provider (Fireworks AI default)
- Router + session manager orchestrate inbound messages
- Agent bridge handles tool call loops (configurable: 90 orchestrator, 50 subagent), parallel execution
- Channel adapters are self-contained (telegram/, matrix/, my-claw-app/)

See `docs/architecture.md` for full details.

## Dependencies

### Required

| Dependency | Installation | Why |
|---|---|---|
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` | Runtime + package manager |
| `ffmpeg` | `apt install ffmpeg` (Debian/Ubuntu) or `brew install ffmpeg` (macOS) | Image resize, video frame extraction |

### Voice / Multimedia (optional)

| Dependency | Installation | Feature | Mode |
|---|---|---|---|
| `edge-tts` | `pip install edge-tts` | TTS (text-to-speech) | Cloud |
| `piper-tts` | [Download binary + model](https://github.com/rhasspy/piper) | TTS | Local |
| `faster-whisper` server | `pip install faster-whisper` then run server on `:18792` | STT (speech-to-text) | Local |
| `GROQ_API_KEY` env var | Get from [groq.com](https://groq.com) | STT | Cloud |

**STT local setup example:**
```bash
pip install faster-whisper
python -c "from faster_whisper import WhisperModel; m = WhisperModel('large-v3', device='cpu', compute_type='int8')"
# Run a simple HTTP server on port 18792 that accepts multipart/form-data with a "file" field
# and returns {"text": "...", "language": "..."}
```

**Notes:**
- Voice features work in **cloud**, **local**, or **auto** mode. No fallback — if the chosen mode fails, the error is explicit.
- TTS is **manual only** (agent calls `tts` tool when user asks). No automatic TTS post-response.
- For unlimited token plans, video frame extraction uses up to 20 frames per video (1 every 3 seconds).

### Skills (separate)

Skills may have their own dependencies (Python packages, CLIs, etc.). See individual `src/skills/*/SKILL.md` files. They are **not required** for core operation.

## Quick Start

```bash
# Install deps
bun install

# Create config directory
mkdir -p ~/.my-claw

# Copy and edit the config template
cp packaging/config.json ~/.my-claw/config.json
# Edit ~/.my-claw/config.json with your API keys and tokens

# Run
bun run start
```

## Configuration

Config lives in `~/.my-claw/config.json`. Key sections:

```json
{
  "whitelist": ["@your_telegram_handle"],
  "blacklist": ["bash", "write"],
  "llm": {
    "defaultProvider": "fireworks",
    "defaultModel": "accounts/fireworks/models/kimi-k2p6-turbo",
    "vision": true,
    "providers": {
      "fireworks": {
        "baseUrl": "https://api.fireworks.ai/inference/v1",
        "apiKeyEnv": "FIREWORKS_API_KEY"
      }
    },
    "limit": { "context": 128000, "output": 8192 }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "streaming": { "enabled": true }
    }
  },
  "voice": {
    "mode": "auto",
    "stt": { "mode": "cloud", "echoTranscript": true },
    "tts": { "mode": "cloud" }
  }
}
```

Secrets can also go in `~/.my-claw/.env`:
```
FIREWORKS_API_KEY=...
GROQ_API_KEY=...
```

## Project Structure

```
src/
  core/           # Config, router
  agent/          # Bridge, approvals, prompt builder
  channels/       # Telegram + Matrix adapters
  llm/            # OpenAI-compatible provider
  sessions/       # Session manager + store
  tools/          # Tool registry + all tools (base, voice, browser, skill, subagent, search)
  analytics/      # SQLite usage tracking (per-API-call token analytics)
  voice/          # VoiceManager, STT, TTS pipelines
  media/          # Image resize + base64, video frame extraction
  skills/         # Skill registry + built-in skills
  subagents/      # Sub-agent runner + registry
  utils/          # Logger, media helpers

docs/             # Architecture docs + plans
tests/            # Test suite (bun:test)
```

## Development

```bash
bun run check      # TypeScript check
bun test           # Run tests
bun run dev        # Watch mode
```

## License

PolyForm-Small-Business-1.0.0
