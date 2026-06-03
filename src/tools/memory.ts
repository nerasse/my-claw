import type { MyClawConfig } from "../core/config.ts";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";
import {
  remember,
  recall,
  update,
  forget,
  search,
  list,
  isMemoryCategory,
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from "../memory/index.ts";

const DESCRIPTION = [
  "Persistent memory across sessions. Save durable facts proactively.",
  "WHEN: user corrections/preferences, environment facts, conventions, lessons learned.",
  "DO NOT store: task progress, session outcomes, TODO state, raw logs.",
  "Write declarative (\"User prefers X\"), not imperative (\"Always do X\").",
  "CATEGORIES: user, environment, convention, project, lesson.",
  "ACTIONS: remember, recall, update, forget, search, list.",
  "No size limit -- entries are deduplicated and consolidated automatically.",
].join(" ");

export function createMemoryTool(config: MyClawConfig): Tool {
  const memCfg = config.memory;

  return {
    name: "memory",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["remember", "recall", "update", "forget", "search", "list"],
          description: "Operation to perform",
        },
        content: { type: "string", description: "Fact to store (remember) or new text (update)" },
        category: {
          type: "string",
          enum: [...MEMORY_CATEGORIES],
          description: "Category for remember/list (default: lesson)",
        },
        query: { type: "string", description: "Search text (recall/search)" },
        old_text: { type: "string", description: "Existing text to update or forget" },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, "action");
      try {
        switch (action) {
          case "remember": {
            const content = str(args, "content");
            if (!content.trim()) return { success: false, output: "content is required for remember." };
            const categoryRaw = strOpt(args, "category");
            const category: MemoryCategory =
              categoryRaw && isMemoryCategory(categoryRaw) ? categoryRaw : "lesson";
            const gate = await hooks.check("gate:memory:write", { content, category });
            if (!gate.allowed) {
              return { success: false, output: `Write blocked by gate: ${gate.reason ?? "no reason"}` };
            }
            const res = await remember(content, category, memCfg);
            return { success: true, output: res.message };
          }
          case "recall": {
            const query = str(args, "query") || str(args, "content");
            if (!query.trim()) return { success: false, output: "query is required for recall." };
            const res = await recall(query, memCfg);
            return { success: true, output: res.text || "No relevant memories." };
          }
          case "search": {
            const query = str(args, "query") || str(args, "content");
            if (!query.trim()) return { success: false, output: "query is required for search." };
            const res = await search(query, memCfg);
            if (res.hits.length === 0) return { success: true, output: "No matching memories." };
            const lines = res.hits.map((h) => `- (${h.entry.category}) ${h.entry.content}`);
            return { success: true, output: lines.join("\n") };
          }
          case "update": {
            const oldText = str(args, "old_text");
            const content = str(args, "content");
            if (!oldText.trim() || !content.trim()) {
              return { success: false, output: "old_text and content are required for update." };
            }
            const gate = await hooks.check("gate:memory:write", { content, category: "lesson" });
            if (!gate.allowed) {
              return { success: false, output: `Write blocked by gate: ${gate.reason ?? "no reason"}` };
            }
            const res = await update(oldText, content, memCfg);
            return { success: true, output: res.message };
          }
          case "forget": {
            const oldText = str(args, "old_text") || str(args, "content");
            if (!oldText.trim()) return { success: false, output: "old_text is required for forget." };
            const res = forget(oldText);
            return { success: true, output: res.message };
          }
          case "list": {
            const categoryRaw = strOpt(args, "category");
            const category =
              categoryRaw && isMemoryCategory(categoryRaw) ? categoryRaw : undefined;
            const entries = list(category);
            if (entries.length === 0) return { success: true, output: "Memory is empty." };
            const lines = entries.map((e) => `- (${e.category}) ${e.content}`);
            return { success: true, output: lines.join("\n") };
          }
          default:
            return { success: false, output: `Invalid action: "${action}".` };
        }
      } catch (e) {
        return { success: false, output: "", error: formatError(`memory ${action} failed`, e) };
      }
    },
  };
}
