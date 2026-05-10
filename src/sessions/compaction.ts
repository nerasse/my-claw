import type { MyClawConfig } from "../core/config.ts";
import { chatCompletion } from "../llm/provider.ts";
import { resolveLlmConfig } from "../llm/resolver.ts";
import type { SessionData, SessionMessage } from "./store.ts";

const MIN_MESSAGES_TO_COMPACT = 10;
const HEAD_KEEP = 3;
const TAIL_KEEP = 4;
const MAX_SUMMARY_CHARS = 8000;

export interface CompactionResult {
  ok: boolean;
  reason?: string;
  beforeCount: number;
  afterCount: number;
  summary?: string;
}

function isToolPairStart(msg: SessionMessage, next: SessionMessage | undefined): boolean {
  return msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0 && next !== undefined;
}

function isToolPairEnd(msg: SessionMessage, prev: SessionMessage | undefined): boolean {
  return msg.role === "tool" && prev?.role === "assistant" && prev.toolCalls && prev.toolCalls.some((tc) => tc.id === msg.toolCallId);
}

function alignTailBoundary(messages: SessionMessage[], tailStart: number): number {
  let idx = tailStart;
  if (idx <= 0) return 0;

  // Walk backward to avoid splitting a tool pair
  while (idx > 0) {
    const prev = messages[idx - 1];
    const curr = messages[idx];
    if (prev && isToolPairStart(prev, curr)) {
      // prev is assistant with tool_calls, curr is first tool result
      // move idx back to include the assistant message
      idx -= 1;
      continue;
    }
    if (curr && isToolPairEnd(curr, prev)) {
      // curr is a tool result whose assistant call is before prev
      // keep walking back to include the assistant
      idx -= 1;
      continue;
    }
    break;
  }
  return idx;
}

function alignHeadBoundary(messages: SessionMessage[], headEnd: number): number {
  let idx = headEnd;
  if (idx >= messages.length) return messages.length;

  // Walk forward to avoid splitting a tool pair
  while (idx < messages.length) {
    const prev = messages[idx - 1];
    const curr = messages[idx];
    if (prev && isToolPairStart(prev, curr)) {
      // prev is assistant with tool_calls, need to include tool results
      idx += 1;
      // Continue to include all tool results for this call
      while (idx < messages.length && messages[idx].role === "tool") {
        idx += 1;
      }
      continue;
    }
    break;
  }
  return idx;
}

function serializeForCompaction(messages: SessionMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`User: ${msg.content}`);
        break;
      case "assistant": {
        let text = `Assistant: ${msg.content}`;
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          text += `\n[Tool calls: ${msg.toolCalls.map((tc) => tc.name).join(", ")}]`;
        }
        parts.push(text);
        break;
      }
      case "tool":
        parts.push(`Tool result (${msg.toolCallId}): ${msg.content.slice(0, 1200)}`);
        break;
    }
  }
  return parts.join("\n\n---\n\n");
}

function buildCompactionPrompt(serialized: string, instructions?: string): string {
  const focus = instructions ? `Focus specifique: ${instructions}` : "Resume les faits cles, les decisions prises, l'etat technique, et les taches en cours.";
  return [
    "Tu es un agent de compaction de contexte. Résume les échanges ci-dessous en un résumé structuré et concis.",
    "",
    focus,
    "",
    "Directives:",
    "- Ecris dans la meme langue que la conversation originale",
    "- Preserve: la tache principale, les decisions cles, l'etat technique (fichiers modifies, branches, etc.), les erreurs rencontrees, le travail restant",
    "- Ignore: salutations, remerciements, confirmations generiques, meta-commentaires",
    "- Ne JAMAIS inclure de cles API, tokens, mots de passe, ou secrets",
    "- Format: texte continu, pas de markdown complexe",
    "",
    "Conversation a resumer:",
    "=== START ===",
    serialized,
    "=== END ===",
    "",
    "Résumé:",
  ].join("\n");
}

export async function compactSession(
  config: MyClawConfig,
  session: SessionData,
  instructions?: string,
): Promise<CompactionResult> {
  const messages = session.messages;

  if (messages.length < MIN_MESSAGES_TO_COMPACT) {
    return {
      ok: false,
      reason: `Session trop courte pour compacter (${messages.length} messages, minimum ${MIN_MESSAGES_TO_COMPACT}).`,
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  const headEndRaw = Math.min(HEAD_KEEP, messages.length);
  const headEnd = alignHeadBoundary(messages, headEndRaw);
  const tailStartRaw = Math.max(headEnd, messages.length - TAIL_KEEP);
  const tailStart = alignTailBoundary(messages, tailStartRaw);

  if (tailStart <= headEnd) {
    return {
      ok: false,
      reason: "Pas assez de messages entre la tete et la queue pour compacter.",
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }

  const head = messages.slice(0, headEnd);
  const middle = messages.slice(headEnd, tailStart);
  const tail = messages.slice(tailStart);

  const serialized = serializeForCompaction(middle);
  const prompt = buildCompactionPrompt(serialized, instructions);

  const llmConfig = resolveLlmConfig(config.llm, session.modelOverride);

  try {
    const response = await chatCompletion(
      llmConfig,
      [
        { role: "system", content: "Tu es un agent de compaction de contexte conversationnel." },
        { role: "user", content: prompt },
      ],
      undefined,
    );

    const summary = response.content.slice(0, MAX_SUMMARY_CHARS).trim();
    if (!summary) {
      return {
        ok: false,
        reason: "Le modele a retourne un resume vide.",
        beforeCount: messages.length,
        afterCount: messages.length,
      };
    }

    const summaryMessage: SessionMessage = {
      role: "user",
      content: `[Contexte anterieur resume]\n${summary}\n\n[Fin du resume — reponds au message suivant]`,
      timestamp: new Date().toISOString(),
    };

    session.messages = [...head, summaryMessage, ...tail];
    session.lastActiveAt = new Date().toISOString();

    return {
      ok: true,
      beforeCount: messages.length,
      afterCount: session.messages.length,
      summary,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Erreur lors de la compaction: ${errorMsg}`,
      beforeCount: messages.length,
      afterCount: messages.length,
    };
  }
}
