/**
 * What a model says when its chat template was never applied.
 *
 * Measured 2026-11-19 on `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`: tool calls spelled
 * out as `assistant to=functions.bash`, tool results as `<function_results>`, and the injected
 * `<context>`/`<memory-context>` blocks coming back at the head of the reply with the owner's own
 * question behind them. None of those strings exists in either repository: it is the model, and
 * the predicate is narrow on purpose -- a model discussing that markup is a legitimate answer.
 */

import { test, expect } from "bun:test";
import { protocolLeakIn } from "../../src/agent/protocol-leak.ts";

test("the tool markup a template would have emitted is a leak", () => {
  expect(protocolLeakIn('assistant to=functions.bash {"cmd": "echo hi"}')).toBe("a tool call, as markup");
  expect(protocolLeakIn('Voici.\nassistant to=functions.read {"path": "a.ts"}')).toBe("a tool call, as markup");
  expect(protocolLeakIn('<function_results>{"output":"hi","exit_code":0}</function_results>')).toBe("its tool results, as markup");
  expect(protocolLeakIn('<|im_start|>assistant')).toBe("raw template tokens");
  // The other dialects the same lane emitted: XML-shaped results and tool blocks.
  expect(protocolLeakIn('<result>\n<name>bash</name>\n<output>echo ok</output>\n</result>')).toBe("its tool results, as markup");
  expect(protocolLeakIn('<tool_call>{"name":"bash"}</tool_call>')).toBe("its tool calls, as markup");
});

test("our own scaffolding, echoed, is a leak", () => {
  expect(protocolLeakIn("<context>\nCurrent time: 2026-11-19T22:31:12.713Z\n</context>\n\nsalut")).toBe(
    "the turn context, echoed",
  );
  expect(protocolLeakIn("<memory-context>\nRelevant long-term memory\n</memory-context>\n\nsalut")).toBe(
    "the memory block, echoed",
  );
  // Mid-answer, our scaffolding is text the owner asked about, not an echo of the prompt.
  expect(protocolLeakIn("Le bloc <context> est injecte au debut du tour.")).toBeUndefined();
});

test("an answer that only talks about the markup is an answer", () => {
  expect(protocolLeakIn("The model printed <function_results>, so the template was not applied.")).toBeUndefined();
  expect(protocolLeakIn("Le modele ecrit `assistant to=functions.bash` dans sa reponse.")).toBeUndefined();
  expect(protocolLeakIn("Un tour normal, avec du texte et du code.")).toBeUndefined();
  expect(protocolLeakIn("   ")).toBeUndefined();
});
