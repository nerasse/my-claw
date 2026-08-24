import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../llm/provider.ts";
import type { MyClawConfig } from "../core/config.ts";
import { MY_CLAW_DIR, contextPruningEnabled, resolveContextPruning } from "../core/config.ts";
import type { SessionMessage } from "../sessions/store.ts";
import { dropLeadingOrphanToolMessages } from "../sessions/store.ts";
import { toOpenAiToolCalls } from "../llm/openai-format.ts";
import { estimateMessagesTokens } from "../llm/tokens.ts";

export interface PruningOptions {
  /**
   * Tokens of tool output, counted from the newest backwards, that are never stubbed. A window in
   * turns cannot express this: five turns is a paragraph on one run and half a megabyte on the
   * next, and the thing that has to fit is a token budget.
   */
  protectTokens: number;
  /** Chars of the original output kept in the stub, split between its head and its tail. */
  headChars: number;
  /**
   * Writes the full output somewhere the agent can read it back. Absent means "measure only":
   * `/status` and the chat header run this same function to size the prompt and must not touch
   * the disk to do it. The marker names the path either way, so the measured string is the sent
   * string.
   */
  spill?: (path: string, content: string) => void;
}

// Stubbing a short result would grow the prompt instead of shrinking it: only prune
// when the cut saves at least this much beyond the kept head.
const MIN_SAVINGS_CHARS = 256;

/** Where a spilled tool output lives. Content-addressed, so writing it twice is writing it once. */
export function spillPath(content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 32);
  return join(MY_CLAW_DIR, "tool-output", `${digest}.txt`);
}

/**
 * What replaces the middle of an old tool result.
 *
 * It used to end with "re-run the tool if you need the full output". On a long run the prompt
 * carried a hundred and thirty of those, each one an instruction to do again what had already been
 * done -- a loop written into the context by the thing meant to shrink it. The output is spilled to
 * a file instead and the marker names it, so recovering the detail is a read, not a re-execution.
 */
export function pruneMarker(prunedChars: number, path: string): string {
  return `\n[... ${prunedChars} chars elided. Full output: ${path} — read that file, do not re-run the tool ...]\n`;
}

/** Head and tail, never head alone: a command's verdict is on its last line, not its first. */
function stub(content: string, headChars: number, path: string): string {
  const head = Math.ceil(headChars / 2);
  const tail = Math.floor(headChars / 2);
  const elided = content.length - head - tail;
  return content.slice(0, head) + pruneMarker(elided, path) + content.slice(content.length - tail);
}

/**
 * Replaces the body of tool results older than the protected token budget with a head/tail stub
 * naming the file that holds the whole thing. Prompt-side only: callers must never persist the
 * returned array. Returns the input array untouched (same reference) when nothing qualifies, so
 * callers can cheaply detect no-ops.
 */
export function pruneOldToolResults(messages: ChatMessage[], opts: PruningOptions): ChatMessage[] {
  // Backwards, because the budget protects the newest output: an agent reasons over what it just
  // read, and the oldest result is the one it can most afford to go and look up again.
  const prunable = new Set<number>();
  let protectedTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    if (protectedTokens < opts.protectTokens) {
      protectedTokens += estimateMessagesTokens([m]);
      continue;
    }
    prunable.add(i);
  }
  if (prunable.size === 0) return messages;

  let changed = false;
  const out = messages.map((m, i) => {
    if (!prunable.has(i) || m.role !== "tool") return m;
    const content = m.content;
    if (content.length <= opts.headChars + MIN_SAVINGS_CHARS) return m;
    const path = spillPath(content);
    opts.spill?.(path, content);
    changed = true;
    return { ...m, content: stub(content, opts.headChars, path) };
  });
  return changed ? out : messages;
}

/**
 * Session turns as the chat API takes them. One mapper, exported, because three places measure
 * how full the window is -- the compaction gate, `/status` and the app's header -- and a private
 * copy in each is how they came to disagree by a factor of eight about the same conversation.
 */
export function sessionChatMessages(messages: readonly SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Defense in depth: a session loaded from disk may start with orphan tool messages; emitting
  // them verbatim makes the LLM API reject the whole request.
  for (const msg of dropLeadingOrphanToolMessages([...messages])) {
    switch (msg.role) {
      case "user":
        out.push({ role: "user", content: msg.content });
        break;
      case "assistant":
        if (msg.toolCalls?.length) {
          out.push({ role: "assistant", content: msg.content, tool_calls: toOpenAiToolCalls(msg.toolCalls) });
        } else {
          out.push({ role: "assistant", content: msg.content });
        }
        break;
      case "tool":
        out.push({ role: "tool", tool_call_id: msg.toolCallId, content: msg.content });
        break;
    }
  }
  return out;
}

/**
 * The history as the prompt actually carries it, which is the only thing an occupancy reading may
 * measure.
 *
 * `session.messages` holds every tool result in full; the prompt does not, because the loop runs
 * `pruneOldToolResults` over it before every call. Estimating the untouched history counts tokens
 * that are never sent: on a long agentic run the gap reached 8.7x on this install (410k estimated
 * against 47k billed) and fired thirty compactions on a session using nine percent of its window.
 * Pruning is prompt-side, so the measure of the prompt has to be too.
 *
 * No `spill` is passed: this is the measuring path. The marker names the same content-addressed
 * path the sending path writes, so both sides count the same string.
 *
 * `backend` is the resolved engine. Anthropic never prunes -- its cache is a prefix, so the loop
 * leaves the prompt whole -- and measuring it as pruned would under-read the one gate that must not.
 */
export function promptSideChat(
  messages: readonly SessionMessage[],
  config: MyClawConfig,
  backend?: string,
): ChatMessage[] {
  const chat = sessionChatMessages(messages);
  if (!promptSidePruned(config, backend)) return chat;
  return pruneOldToolResults(chat, resolveContextPruning(config));
}

/**
 * Whether `promptSideChat` prunes, for this engine and this config.
 *
 * Exported because a billed prompt size is only comparable to an estimate taken on the same shape.
 * The same history is 5.2x larger unpruned (measured on a 2820-message session: 2 824 235 tokens
 * against 541 929), so a measurement carried across a switch describes a prompt that no longer
 * exists. Reading it as a floor made a model change look like a full window: the gate compacted on
 * a codex measurement the moment the session moved to Anthropic. See docs/context-window.md.
 */
export function promptSidePruned(config: MyClawConfig, backend?: string): boolean {
  return backend !== "anthropic" && contextPruningEnabled(config);
}

/**
 * Writes a spilled tool output, once. Content-addressed, so a result stubbed on twenty consecutive
 * prompt builds is written on the first and skipped on the other nineteen.
 *
 * Failures are swallowed on purpose: the prompt is already correct without the file, the marker
 * only becomes a dead path, and an unwritable disk must not take a run down.
 */
export function spillToolOutput(path: string, content: string): void {
  try {
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  } catch {
    // see above
  }
}

/** Spilled outputs older than this are swept: they exist to be re-read during a run, not kept. */
export const SPILL_RETENTION_MS = 7 * 86_400_000;

export function sweepSpilledToolOutput(now = Date.now()): number {
  const dir = join(MY_CLAW_DIR, "tool-output");
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const s = statSync(full);
      if (now - s.mtimeMs <= SPILL_RETENTION_MS) continue;
      rmSync(full, { force: true });
      removed += 1;
    }
  } catch {
    // no directory yet, or a racing sweep: nothing to report
  }
  return removed;
}
