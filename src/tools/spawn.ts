import { resolve } from "node:path";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resumeHint, subagentIdOf, SubAgentRunner, type SubAgentStream } from "../subagents/runner.ts";
import { SubAgentRegistry } from "../subagents/registry.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { isAbort, rethrowIfAborted } from "../core/aborted.ts";
import type { AgentInfo } from "../agents/types.ts";

const SUGGESTIONS = 5;

const tokensOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The ids a mistyped model most looks like: the ones sharing the most of its name, the id that
 * contains it whole before the others, the shorter first. Tags are left out, they are listed apart.
 *
 * Exported for its own test.
 */
export function closestModels(query: string, ids: readonly string[], limit = SUGGESTIONS): string[] {
  const wanted = tokensOf(query);
  if (wanted.length === 0) return [];
  const floor = Math.max(1, Math.ceil(wanted.length / 2));
  const whole = query.toLowerCase();
  return ids
    .filter((id) => !id.startsWith("tag:"))
    .map((id) => {
      const own = new Set(tokensOf(id));
      return { id, score: wanted.filter((token) => own.has(token)).length, whole: id.toLowerCase().includes(whole) };
    })
    .filter((candidate) => candidate.score >= floor)
    .sort((a, b) => b.score - a.score || Number(b.whole) - Number(a.whole) || a.id.length - b.id.length)
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

/** Every id a spawn may name: the tags, as `tag:<name>`, then the catalog. */
export function spawnModelIds(config: { tags?: Record<string, unknown>; llm: { models?: Array<{ id: string }> } }): string[] {
  return [...Object.keys(config.tags ?? {}).map((tag) => `tag:${tag}`), ...(config.llm.models ?? []).map((m) => m.id)];
}

/**
 * `listModelIds` answers every id a spawn may name (`spawnModelIds`), the tags included as `tag:<name>`. None of
 * them is drawn in the schema: the catalog is hundreds of ids (544 on this install, about 5 000
 * tokens on every request) and it moves with discovery, while the tool definitions open the cached
 * prefix. The tags, a handful that change only with the config, are named in the description.
 */
export function createSpawnTool(
  runner: SubAgentRunner,
  registry: SubAgentRegistry,
  listModelIds?: () => string[],
  listAgents?: () => AgentInfo[],
  streamProvider?: (subagentId: string) => SubAgentStream | undefined,
): Tool {
  const agents = (): AgentInfo[] => listAgents?.() ?? [];
  return {
    name: "spawn",
    // A getter for the same reason as the parameters below: this sentence is how the model learns
    // which agents exist, and a file dropped in `agents/` must show up without a restart.
    get description() {
      const catalog = agents();
      const types = catalog.length > 0
        ? `Types:\n${catalog.map((a) => `- ${a.name}: ${a.description}`).join("\n")}\n`
        : "";
      return "Spawn a sub-agent. mode='run' = one-shot, answers once and is not meant to be driven again. " +
        "mode='session' = persistent on disk: the answer ends with the id to reuse with send(). " +
        types +
        "Provide workspaceDir to isolate the sub-agent's filesystem. " +
        "visibility decides who can later list and drive it: 'global' (default, every conversation), " +
        "'workspace' (only conversations of the workspace spawning it), 'private' (this conversation alone). " +
        "No cap on concurrent runs. Max depth 2.";
    },
    // Getter on purpose: both engines rebuild tool definitions per run, so the agent types and the
    // tags follow hot-reloads instead of freezing at boot.
    get parameters() {
      const tags = (listModelIds?.() ?? []).filter((id) => id.startsWith("tag:"));
      const names = agents().map((a) => a.name);
      return {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name for the sub-agent (e.g. 'researcher', 'coder')" },
          type: {
            type: "string",
            ...(names.length > 0 ? { enum: names } : {}),
            description: "Sub-agent type",
          },
          mode: { type: "string", enum: ["run", "session"], description: "'run' = one-shot, 'session' = persistent" },
          task: { type: "string", description: "Task description for the sub-agent" },
          workspaceDir: { type: "string", description: "Optional absolute workspace directory for the sub-agent" },
          visibility: {
            type: "string",
            enum: ["global", "workspace", "private"],
            description: "Who can list and drive this sub-agent later. 'global' (default) = any conversation; 'workspace' = only conversations of the workspace it was spawned from; 'private' = only this conversation.",
          },
          private: { type: "boolean", description: "Deprecated alias for visibility='private'. Ignored when visibility is set." },
          model: {
            type: "string",
            description: `Optional model for this sub-agent: ${tags.length > 0 ? `a tag (${tags.join(", ")}) or ` : ""}a model id (provider/model). Default: the configured sub-agent model.`,
          },
        },
        required: ["name", "type", "mode", "task"],
      };
    },
    async execute(args): Promise<ToolResult> {
      try {
        const name = str(args, "name");
        const known = agents().map((a) => a.name);
        // No hardcoded default any more: with an open set, falling back to a name that may not
        // exist would trade a clear error for a confusing one.
        const type = str(args, "type") || (known.includes("research") ? "research" : known[0] ?? "");
        const mode = str(args, "mode") || "run";
        const task = str(args, "task");
        const workspaceDir = strOpt(args, "workspaceDir");
        const model = strOpt(args, "model");
        if (model) {
          const known = listModelIds?.() ?? [];
          if (!known.includes(model)) {
            const near = closestModels(model, known);
            const tags = known.filter((id) => id.startsWith("tag:"));
            const hints = [
              near.length > 0 ? `Closest ids: ${near.join(", ")}.` : "No known id looks like it.",
              tags.length > 0 ? `Tags: ${tags.join(", ")}.` : "",
            ].filter(Boolean).join(" ");
            return { success: false, output: "", error: `Unknown model "${model}". ${hints} Omit model to use the configured one.` };
          }
        }
        // The confinement check lives in the runner: only it knows the sub-agent's base
        // workspace (the agent's configured one, else the parent's). See docs/multi-workspace.md.
        const parentWorkspaceDir = typeof args["__workspaceDir"] === "string"
          ? args["__workspaceDir"]
          : process.env["MY_CLAW_WORKSPACE"];
        const message = args["__message"] as UnifiedMessage | undefined;

        if (!message) {
          return { success: false, output: "", error: "Missing parent message context" };
        }
        if (!known.includes(type)) {
          return { success: false, output: "", error: `Unknown agent '${type}'. Available: ${known.join(", ") || "none"}` };
        }
        if (mode !== "run" && mode !== "session") {
          return { success: false, output: "", error: `Invalid mode '${mode}'` };
        }

        const signal = args["__signal"] as AbortSignal | undefined;
        const callerSessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";
        const toolCallId = typeof args["__toolCallId"] === "string" ? args["__toolCallId"] : undefined;
        // Global unless asked otherwise, so a sub-agent stays a shared worker by default. A
        // one-shot is forced private inside the runner regardless of what is passed here. The
        // scope of `workspace` is resolved there too, from the calling session: a value passed
        // here could name a workspace the caller is not in.
        const requested = strOpt(args, "visibility");
        if (requested !== undefined && requested !== "global" && requested !== "workspace" && requested !== "private") {
          return { success: false, output: "", error: `Invalid visibility '${requested}'. Use global, workspace or private.` };
        }
        const visibility: "global" | "workspace" | "private" = requested ?? (args["private"] === true ? "private" : "global");
        const existing = await registry.listExistingIds();
        const { id, result, attachments } = await runner.spawn({
          displayName: name,
          type,
          mode: mode as "run" | "session",
          task,
          workspaceDir,
          parentWorkspaceDir,
          parentMessage: message,
          existingIds: existing,
          generateId: (n, e) => registry.generateId(n, e),
          parentSessionId: callerSessionId,
          visibility,
          signal,
          model,
          enqueue: <T,>(i: string, task2: () => Promise<T>) => registry.enqueue(i, task2),
          ...(toolCallId ? { toolCallId } : {}),
          ...(streamProvider ? { streamProvider } : {}),
        });
        if (result.startsWith("Error:")) return { success: false, output: result, error: result };
        // A persistent sub-agent is only reachable by id, and the caller has no other way to learn
        // it: without this line the one thing `send` requires has to be guessed, and a guess is a
        // "sub-agent not found" every time. One-shots are left alone, nothing is meant to drive them.
        const handle = mode === "session" && id ? `\n\n[sub-agent id: ${id}]` : "";
        // A picture the sub-agent's tools produced (a screenshot, a chart) reaches the person who
        // asked the same way the answer does: through the caller's own reply.
        return { success: true, output: `${result}${handle}`, ...(attachments.length > 0 ? { attachments } : {}) };
      } catch (e) {
        // A real Stop of the caller ends the caller's run. Anything else is this call's own
        // failure, and a child stopped on its own has to say so instead of implicating the caller
        // (2026-09-21: one sub-agent of three dying read as the whole run being stopped). docs/stop.md
        rethrowIfAborted(e, args["__signal"] as AbortSignal | undefined);
        if (isAbort(e)) {
          return {
            success: false,
            output: "",
            error: `The sub-agent's run was stopped before it answered.${resumeHint(subagentIdOf(e))}`,
          };
        }
        return { success: false, output: "", error: `The sub-agent failed: ${String(e)}.${resumeHint(subagentIdOf(e))}` };
      }
    },
  };
}
