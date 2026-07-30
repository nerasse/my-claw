/**
 * Characters that render as nothing, and are therefore the channel used to hide text from the
 * human while the model still reads it. Stripping them is the one measure against hidden
 * instructions with evidence behind it: it makes what the model sees match what a person sees.
 * It is not a defence against injection written in visible prose. See docs/untrusted-content.md.
 *
 * Explicit ranges rather than `\p{Cf}`: that category also holds the Arabic number signs
 * (U+0600-U+0605) and the Arabic letter mark (U+061C), which carry meaning in real Arabic text and
 * must survive. Variation selectors are deliberately absent too -- U+FE0F is what makes an emoji
 * render as an emoji, and it is not in `\p{Cf}` either.
 *
 * The tag block matters most: U+E0000-U+E007F is the vector Johann Rehberger demonstrated against
 * Google Jules in August 2025, invisible instructions carried inside a GitHub issue.
 */
// Deliberately not exported: `String.replace` resets `lastIndex` on a global regex, but `test` and
// `exec` do not, so handing this out invites a stateful-matching bug at some future call site.
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{E0000}-\u{E007F}]/gu;

export interface StripResult {
  text: string;
  /** Removed code points keyed `U+XXXX`, with counts. Empty when nothing was removed. */
  stripped: Record<string, number>;
}

export function stripInvisible(raw: string): StripResult {
  const stripped: Record<string, number> = {};
  const text = raw.replace(INVISIBLE, (char) => {
    const key = `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    stripped[key] = (stripped[key] ?? 0) + 1;
    return "";
  });
  return { text, stripped };
}
