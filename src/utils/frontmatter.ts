const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Flat `key: value` frontmatter: no nesting, no lists, no quoting, no YAML dependency in the boot
 * path. The first `:` wins, so a value may contain more of them; `#` skips a whole line and is not
 * an inline comment.
 *
 * Shared by skills and agents so the two cannot disagree on what counts as a parseable header.
 * Callers own their own required fields: this returns the raw pairs and says nothing about meaning.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const match = FRONTMATTER_RE.exec(text.trimStart());
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    fields[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return { fields, body: match[2]!.trimStart() };
}

/**
 * A comma-separated field as a list. An absent field is undefined ("unset"); a present but empty
 * one is `[]` ("nothing"), which the scope resolvers already treat as a decision rather than a
 * default. Collapsing the two would turn `skills:` into "every skill", the opposite of the intent.
 */
export function listField(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
