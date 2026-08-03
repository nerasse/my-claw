/**
 * `*` wildcard matching for flat identifiers: CDP method names, model ids. Anchored and
 * case-insensitive, because both callers match a whole name and neither wants case to matter.
 *
 * `?` is escaped rather than treated as a single-character wildcard: model ids contain literal
 * `?` far more often than anyone wants to match one position of them.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesAnyGlob(value: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}
