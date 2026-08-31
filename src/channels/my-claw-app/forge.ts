/**
 * The Forgejo instance the app channel releases from, and the one credential that reaches it.
 *
 * Both `myclaw web` and the app-update relay read the same pair of environment variables, and
 * both must agree on the rule that the token only travels to the configured forge: a `--from`
 * pointing at a mirror, or an upstream URL on another host, is a plain download and never a
 * credential handover.
 */

const DEFAULT_FORGE = "https://git.kssimi.fr";

/** The repository that carries the app's releases (APK + web bundle). */
export const APP_REPO = "claw/my-claw-app";

export function forgeBase(): string {
  return (process.env["FORGEJO_URL"] ?? DEFAULT_FORGE).replace(/\/+$/, "");
}

export function forgeToken(): string | undefined {
  const token = process.env["FORGEJO_TOKEN"];
  return token && token.length > 0 ? token : undefined;
}

/**
 * The release repository is private, and a private release asset answers an anonymous GET with a
 * 404 rather than a 401: an unauthenticated download reads as "the version does not exist".
 *
 * The token only ever travels to the forge itself. A source pointing anywhere else is a plain
 * download: handing a credential to whatever host was typed is how the forge token ends up in
 * someone else's logs.
 */
export function authHeaders(source: string): Record<string, string> {
  const token = forgeToken();
  if (!token) return {};
  try {
    const target = new URL(source);
    const forge = new URL(forgeBase());
    if (target.host !== forge.host || target.protocol !== forge.protocol) return {};
    return { Authorization: `token ${token}` };
  } catch {
    return {};
  }
}
