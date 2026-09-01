import { test, expect, beforeEach } from "bun:test";
import { createQuestionTool } from "../../src/tools/question.ts";
import { questionManager } from "../../src/questions/manager.ts";

const tool = createQuestionTool();

beforeEach(() => questionManager.clear());

test("refuses without a surface", async () => {
  // No handler set yet: hasSurface() false.
  const r = await tool.execute({
    questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
    __toolCallId: "tc1",
  });
  expect(r.success).toBe(false);
  expect(r.error).toContain("surface");
});

test("invalid questions error", async () => {
  questionManager.setHandler(() => {});
  const r = await tool.execute({
    questions: "not an array",
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
  });
  expect(r.success).toBe(false);
  expect(r.error).toContain("questions");
});

test("empty options error", async () => {
  questionManager.setHandler(() => {});
  const r = await tool.execute({
    questions: [{ header: "h", question: "q", options: [] }],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
  });
  expect(r.success).toBe(false);
});

test("answers are returned in order", async () => {
  questionManager.setHandler((q) => {
    questionManager.reply(q.id, [["fr"], ["23", "24"]]);
  });
  const r = await tool.execute({
    questions: [
      { header: "Langue", question: "FR ou EN ?", options: [{ label: "fr" }, { label: "en" }] },
      { header: "Fenetres", question: "Combien ?", options: [{ label: "1" }, { label: "2" }], multiple: true },
    ],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
    __toolCallId: "tc1",
  });
  expect(r.success).toBe(true);
  expect(r.output).toContain('"Langue"="fr"');
  expect(r.output).toContain('"Fenetres"="23, 24"');
  expect(r.output).toContain("You can now continue");
});

test("cancel reports the cancel as a success, not an error", async () => {
  questionManager.setHandler((q) => {
    questionManager.cancel(q.id);
  });
  const r = await tool.execute({
    questions: [{ header: "h", question: "q", options: [{ label: "a" }] }],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
  });
  expect(r.success).toBe(true);
  expect(r.output).toContain("User canceled the questions");
  expect(r.output).toContain("Do not ask again");
});

test("a custom=false question carries the flag to the sheet", async () => {
  questionManager.setHandler((q) => {
    expect(q.questions[0]!.custom).toBe(false);
    questionManager.reply(q.id, [["a"]]);
  });
  const r = await tool.execute({
    questions: [{ header: "h", question: "q", options: [{ label: "a" }], custom: false }],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
  });
  expect(r.success).toBe(true);
});

test("description is carried to the sheet", async () => {
  questionManager.setHandler((q) => {
    expect(q.questions[0]!.options[0]!.description).toBe("The one");
    questionManager.reply(q.id, [["a"]]);
  });
  const r = await tool.execute({
    questions: [{ header: "h", question: "q", options: [{ label: "a", description: "The one" }] }],
    __message: { chatId: "o", threadId: "t", id: "m1" } as never,
    __sessionId: "s1",
  });
  expect(r.success).toBe(true);
});
