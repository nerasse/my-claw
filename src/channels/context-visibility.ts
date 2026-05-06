export type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";
export type ContextVisibilityKind = "history" | "thread" | "quote";

export function shouldIncludeSupplementalContext(params: {
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  senderAllowed: boolean;
}): boolean {
  if (params.mode === "all") return true;
  if (params.senderAllowed) return true;
  if (params.mode === "allowlist_quote" && params.kind === "quote") return true;
  return false;
}
