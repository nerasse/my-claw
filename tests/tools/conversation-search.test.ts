import { expect, test } from "bun:test";
import { createConversationSearchTool } from "../../src/tools/conversation-search.ts";
import { cronCapabilityDeny, ToolRegistry } from "../../src/tools/registry.ts";

test("is exposed as one read-only tool to research and general agents", () => {
  const registry = new ToolRegistry();
  registry.register(createConversationSearchTool());
  expect(registry.getForAgent("research").map((tool) => tool.name)).toContain("conversation_search");
  expect(registry.getForAgent("general").map((tool) => tool.name)).toContain("conversation_search");
  // In the cron baseline, withheld per job unless the job turns it on: docs/cron.md.
  expect(registry.getForAgent("cron").map((tool) => tool.name)).toContain("conversation_search");
  expect(cronCapabilityDeny(undefined)).toContain("conversation_search");
});

test("has a single search/read action surface", () => {
  const tool = createConversationSearchTool();
  expect(tool.name).toBe("conversation_search");
  expect(tool.parameters).toMatchObject({
    properties: { action: { enum: ["search", "read"] } },
    required: ["action"],
  });
});
