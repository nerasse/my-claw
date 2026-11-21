/**
 * The fixtures are the real replies, taken from `entries.jsonl` of the threads that produced them:
 * 4d5775e7 seq 54912 and 54949 (2026-11-20, Synthetic DeepSeek V4.1 Flash), fbe927c6 seq 53276
 * and 53334 (2026-11-19, same lane), and 52568 (2026-11-17).
 *
 * The continuations in the last block come from a sweep of the whole corpus the same day: 48 587
 * phases of every thread, of which exactly nine open on whitespace -- all nine fragments.
 */

import { describe, expect, test } from "bun:test";
import { promptEchoIn } from "../../src/llm/prompt-echo.ts";

describe("a reply that repeats our own turn scaffolding", () => {
  test("the turn context, in the dialect the model rewrote it into", () => {
    const leaked = ` maggiore\n\n<context>\nCurrent time="2026-11-20T19:02:31.913Z">\n[Audio]: " Non, c'est très bien, AGPL, parfait.`;
    expect(promptEchoIn(leaked)).toBe("the turn context");
  });

  test("the same block in the dialect we actually send", () => {
    const leaked = `<context>\nCurrent time: 2026-11-17T23:52:05.168Z\n\nSkills possibly relevant to this request:\n- ui-design: ...`;
    expect(promptEchoIn(leaked)).toBe("the turn context");
  });

  test("the memory block", () => {
    expect(promptEchoIn("<memory-context>\nRelevant long-term memory\n</memory-context>\nsalut")).toBe(
      "the memory block",
    );
  });
});

describe("a reply that carries another harness's control markup", () => {
  test("the token budget gauge, mid-answer", () => {
    const leaked = `├── review de mon code?\n\n<budget:token_budget>200000</budget:token_budget>\n\nthe user message appears to end with a stray artifact`;
    expect(promptEchoIn(leaked)).toBe("a harness token gauge");
  });

  test("the gauge alone, after one stray character", () => {
    expect(promptEchoIn(`立て\n<budget:token_budget>200000</budget:token_budget>\n\nthe user message`)).toBe(
      "a harness token gauge",
    );
  });

  test("chat-template control tokens", () => {
    expect(promptEchoIn("<|im_start|>assistant")).toBe("raw chat-template tokens");
    expect(promptEchoIn("ok\n<|endoftext|>")).toBe("raw chat-template tokens");
  });

  test("a tool call spelled out in the model's own format", () => {
    expect(promptEchoIn('assistant to=functions.bash {"cmd": "echo hi"}')).toBe("a tool call as markup");
    expect(promptEchoIn('Voici.\nassistant to=functions.read {"path": "a.ts"}')).toBe("a tool call as markup");
  });

  test("the safety classifier, printed as its own verdict", () => {
    expect(promptEchoIn("«<ds_safety>[用户未成年]否</ds_safety>Safe")).toBe("its safety classifier");
    expect(promptEchoIn("Une réponse.\n#<ds_safety>Safe")).toBe("its safety classifier");
  });

  test("tool results rendered by a template", () => {
    expect(promptEchoIn('<function_results>{"output":"hi","exit_code":0}</function_results>')).toBe(
      "its tool results as markup",
    );
    expect(promptEchoIn("<result>\n<name>bash</name>\n<output>echo ok</output>\n</result>")).toBe(
      "its tool results as markup",
    );
    expect(promptEchoIn('<tool_call>{"name":"bash"}</tool_call>')).toBe("its tool calls as markup");
  });
});

describe("a reply that continues a text it had already begun", () => {
  test("the thinking delivered as an answer, twice in one run", () => {
    // Measured 2026-11-21, thread 4d5775e7, the two turns the owner saw as plain messages while
    // the app reported their reasoning as "not shared": the endpoint billed the thinking as
    // reasoning and handed the words over in `content` anyway.
    expect(promptEchoIn(" reward\n2 / 2\n")).toBe("a continuation of a text it had already begun");
    expect(
      promptEchoIn(" adipiscing\nLet me give him a straight answer, but first check one thing: whether he can"),
    ).toBe("a continuation of a text it had already begun");
  });

  test("another answer's tail, with the transcript envelope behind it", () => {
    // Named rather than generic, and that is the better diagnosis: the envelope inside the fragment
    // says what the model thought it was continuing.
    expect(promptEchoIn(" growing the team and expanding into new areas.\n[Audio]: \" Attends, attends, on va")).toBe(
      "the transcript line of a turn",
    );
  });

  test("a reply that opens on a blank line is ordinary formatting, not a continuation", () => {
    expect(promptEchoIn("\n\nVoici le resultat.")).toBeUndefined();
    expect(promptEchoIn("\n# Titre\n\ntexte")).toBeUndefined();
  });
});

describe("a reply that carries DeepSeek's own tool-call dialect", () => {
  // U+FF5C, the fullwidth bar the template puts around every DSML token.
  const bar = "\uFF5C";

  test("the call the serving stack failed to parse, handed over as the answer", () => {
    // 2026-11-21 18:30, thread fbe927c6: the owner said "release oui" and got this, 34 completion
    // tokens of which 33 were billed as reasoning.
    const leaked = `\n</${bar}DSML${bar} parameter>\n<${bar}DSML${bar} parameter name="path" string="true">/tmp/nothing.txt</${bar}DSML${bar} parameter>\n</${bar}DSML${bar} invoke>\n</${bar}DSML${bar} calls>`;
    expect(promptEchoIn(leaked)).toBe("its tool-call markup");
  });

  test("the whole reply is one call, with no prose in front of it", () => {
    // 2026-11-06: the same dialect at the head, and the name field carried a shell command. This
    // spelling wraps the token in two bars per side, the other in one; both are in the corpus.
    const leaked = `<${bar}${bar}DSML${bar}${bar} calls>\n<${bar}${bar}DSML${bar}${bar} invoke name="read">\n<${bar}${bar}DSML${bar}${bar} parameter name="path">a.txt`;
    expect(promptEchoIn(leaked)).toBe("its tool-call markup");
  });

  test("an answer that explains the dialect is still an answer", () => {
    // Both are real replies, 2026-11-02 and 2026-11-21: they quote the markup in a fence.
    const explaining = [
      "Oui, il y avait un vrai souci, et il n'etait pas dans ta config.",
      "",
      "```json",
      `"name": "docker 2>/dev/null; true</${bar}DSML${bar} parameter>\n</${bar}DSML${bar} invoke>"`,
      "```",
      "",
      "Un modele a emis un tool-call malforme.",
    ].join("\n");
    expect(promptEchoIn(explaining)).toBeUndefined();
    expect(promptEchoIn(`Le texte exact de la reponse contenait ${bar}DSML${bar}.`)).toBeUndefined();
  });
});

/**
 * The false positives that got the previous detector deleted (70f65cd): it matched a tag wherever
 * it appeared, so an Opus answer that quoted one was refused as if the model had printed its
 * template. A tag named in prose is an answer, and it has to stay one.
 */
describe("an answer that talks about the markup is an answer", () => {
  test("a tag named in prose", () => {
    expect(promptEchoIn("Le bloc <context> est injecté au début du tour.")).toBeUndefined();
    expect(promptEchoIn("The model printed <function_results>, so the template was not applied.")).toBeUndefined();
    expect(promptEchoIn("Le modèle écrit `assistant to=functions.bash` dans sa réponse.")).toBeUndefined();
  });

  test("the Opus answer the old detector refused", () => {
    expect(promptEchoIn("Sa sortie contenait «<ds_safety>[用户未成年]否</ds_safety>Safe», son propre verdict.")).toBeUndefined();
  });

  test("our scaffolding named without its clock", () => {
    expect(promptEchoIn("Le bloc <context> et le bloc <memory-context> sont ajoutés par le moteur.")).toBeUndefined();
  });

  test("a leak quoted inside a fence, which is how every report of it is written", () => {
    const quoted = [
      "c'est quoi ce bug :",
      "```",
      "├── review de mon code?",
      "<budget:token_budget>200000</budget:token_budget>",
      "the user message appears to end with a stray artifact line",
      "```",
      "voilà ce qui s'est passé.",
    ].join("\n");
    expect(promptEchoIn(quoted)).toBeUndefined();
  });

  test("a fence does not swallow the rest of the answer", () => {
    const afterFence = ["Exemple :", "```ts", "const a = 1;", "```", "Ensuite le modèle a écrit :", "<context>", "Current time: 2026-11-20T19:02:31.913Z"].join("\n");
    expect(promptEchoIn(afterFence)).toBe("the turn context");
  });

  test("a budget tag without a figure", () => {
    expect(promptEchoIn("Le tag `<budget:token_budget>` est ajouté par l'harnais.")).toBeUndefined();
  });
});

/**
 * The leak the transcription envelope carries, which the table promised and never held.
 *
 * Three replies, all on the same lane, all refused now: the fragment of an earlier answer followed
 * by an `[Audio]: "…"` line the owner never recorded (2026-11-21, d1b09fdd seq 9530), the same
 * shape under `水煎服` (2026-11-20), and one that opened straight on the marker.
 */
describe("a reply that continues our transcript instead of answering", () => {
  test("a fragment, then a voice note the owner never recorded", () => {
    const leaked = ` growing the team and expanding into new areas.
[Audio]: " Attends, attends, on va peut-être pas tout jeter non plus. Le message de MyClaude, le mail MyClaude, on l'a envoyé dans la conversation Carrière."

Je vois : les mails sont ici, donc traiter ici est plus simple.`;
    expect(promptEchoIn(leaked)).toBe("the transcript line of a turn");
  });

  test("the same shape under a stray word", () => {
    const leaked = `水煎服
[Audio]: " Oui j'ai vu que tu as eu des nouvelles de mes potes du coup sur my claw."`;
    expect(promptEchoIn(leaked)).toBe("the transcript line of a turn");
  });

  test("the marker alone, at the head of the reply", () => {
    expect(promptEchoIn('[Audio]: " Bonjour."')).toBe("the transcript line of a turn");
    expect(promptEchoIn('[Audio 2]: " Deuxième prise."')).toBe("the transcript line of a turn");
  });

  test("its bracket notices, which the preprocessor writes too", () => {
    expect(promptEchoIn('[Audio]: [voice/STT not configured]')).toBe("the transcript line of a turn");
    expect(promptEchoIn('[Audio]: [Transcription failed: boom]')).toBe("the transcript line of a turn");
    expect(promptEchoIn('[Video]: [Frame extraction failed: boom]')).toBe("the transcript line of a turn");
  });

  test("the attachment block it appends to that turn", () => {
    const leaked = `[Attachments]
- audio: /home/neras/.my-claw/files/a/c6606af6__voice-2026-11-21T14-42-07.weba (3203 ms)

Je reprends là.`;
    expect(promptEchoIn(leaked)).toBe("the attachment block of a turn");
  });

  test("an image listing stays an answer: reporting what it received is the job", () => {
    const report = `J'ai reçu trois pièces.

[Attachments]
- image: /home/neras/a.png
- image: /home/neras/b.png`;
    expect(promptEchoIn(report)).toBeUndefined();
  });
});

describe("an answer that names the envelope is an answer", () => {
  test("the marker inside a sentence", () => {
    expect(promptEchoIn('Le préprocesseur écrit [Audio]: "salut" pour un vocal.')).toBeUndefined();
  });

  test("the heading without a file", () => {
    expect(promptEchoIn("Le bloc [Attachments] est ajouté à la fin du tour.")).toBeUndefined();
    expect(promptEchoIn("[Attachments]\n\nUne section de ma réponse.")).toBeUndefined();
  });

  test("a label followed by prose, not by a transcript", () => {
    expect(promptEchoIn("[Audio]: le préprocesseur ajoute la transcription ici.")).toBeUndefined();
  });

  test("the whole envelope quoted in a fence", () => {
    const quoted = ["Le tour ressemble à ça :", "```", '[Audio]: " Bonjour."', "", "[Attachments]", "- audio: /tmp/a.weba (12 ms)", "```"].join("\n");
    expect(promptEchoIn(quoted)).toBeUndefined();
  });
});
