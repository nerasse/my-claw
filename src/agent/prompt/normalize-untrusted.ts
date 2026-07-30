import { log } from "../../utils/logger.ts";
import { stripInvisible } from "../../utils/invisible.ts";

/**
 * Normalise content my-claw did not author -- fetched pages, tool results, browser output, nested
 * AGENTS.md from cloned repos, owner-editable prompt files, and the incoming user turn.
 *
 * This is normalisation, not detection. The pattern denylist that used to live here was removed
 * after it was measured: 4 of 11 known English phrasings caught, 0 of 12 in French, while it
 * blocked legitimate security documentation. Stripping invisible characters is kept because it is
 * the part with evidence behind it -- it guarantees the model reads the same text a human sees.
 *
 * It is NOT a security boundary. Nothing here stops an injection written in plain visible prose.
 * See docs/untrusted-content.md for what actually bounds the damage.
 */
export function normalizeUntrusted(content: string, label: string): string {
  const { text, stripped } = stripInvisible(content);
  if (Object.keys(stripped).length > 0) {
    void log("debug", "stripped invisible characters from untrusted content", { label, stripped });
  }
  return text;
}
