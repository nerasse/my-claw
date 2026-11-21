import { removeEnvKey, setEnvValue } from "./env-edit.ts";
import { DEFAULT_RELEASE_URL, githubLatestVersion, isGithubSource, normalizeReleaseUrl } from "./release-source.ts";

/**
 * `myclaw release-key`: points this install at its release source, docs/release-source.md.
 *
 * The source is checked before anything is written: a mistyped URL or key would otherwise only
 * show up as an auto-update that silently never finds a release. The running server picks the
 * lines up on its own (.env is hot-reloaded), and the shell updaters read them on their next run.
 */

export { DEFAULT_RELEASE_URL };

const USAGE = `usage: myclaw release-key [<key>] [--url <release url>]

  Sets the release source updates come from, after checking that it answers.
  A GitHub repository needs no key:
    myclaw release-key --url https://github.com/<owner>/my-claw
  Any other source keeps the neutral layout and its key, read from standard input when the
  key is not on the command line (nothing is echoed).
  --url defaults to ${DEFAULT_RELEASE_URL}
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Release key: ");
  let text = "";
  for await (const chunk of Bun.stdin.stream()) {
    text += new TextDecoder().decode(chunk);
    if (text.includes("\n")) break;
  }
  if (process.stdin.isTTY) process.stderr.write("\n");
  return text.split("\n")[0]!.trim();
}

export type CheckResult = { ok: true; version: string } | { ok: false; error: string };

async function checkLayout(url: string, key: string): Promise<CheckResult> {
  let response: Response;
  try {
    response = await fetch(`${url}/server/latest.json`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `${url} did not answer: ${(err as Error).message}` };
  }
  if (response.status === 401) return { ok: false, error: "the key was refused: check it, or create a new one" };
  if (response.status === 403) {
    return { ok: false, error: `the key is not valid for ${url}: ${(await response.text()).trim() || "forbidden"}` };
  }
  if (!response.ok) return { ok: false, error: `${url} answered HTTP ${response.status}` };
  const body = (await response.json().catch(() => undefined)) as { version?: unknown } | undefined;
  if (typeof body?.version !== "string") return { ok: false, error: `${url} does not look like a release source` };
  return { ok: true, version: body.version };
}

export async function checkReleaseSource(url: string, key?: string): Promise<CheckResult> {
  const normalized = normalizeReleaseUrl(url);
  if (isGithubSource(normalized)) {
    const version = await githubLatestVersion(normalized);
    return version
      ? { ok: true, version }
      : { ok: false, error: `${normalized} has no published release` };
  }
  return checkLayout(normalized, key ?? "");
}

export async function runReleaseKeyCli(args: string[], read: () => Promise<string> = readStdin): Promise<number> {
  let url = DEFAULT_RELEASE_URL;
  let key: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--url") {
      const value = args[++i];
      if (!value) {
        console.error(USAGE);
        return 1;
      }
      url = value;
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else if (arg.startsWith("-") || key !== undefined) {
      console.error(USAGE);
      return 1;
    } else {
      key = arg;
    }
  }
  url = normalizeReleaseUrl(url);
  if (!/^https?:\/\//.test(url)) {
    console.error(`not a URL: ${url}`);
    return 1;
  }

  const github = isGithubSource(url);
  if (!github) {
    key = (key ?? (await read())).trim();
    if (!key) {
      console.error("no key given");
      return 1;
    }
    if (/\s/.test(key)) {
      console.error("a key has no spaces: copy it again");
      return 1;
    }
  }

  const check = await checkReleaseSource(url, key);
  if (!check.ok) {
    console.error(`Nothing changed: ${check.error}`);
    return 1;
  }

  const written = await setEnvValue("MY_CLAW_RELEASE_URL", url);
  if (!written.ok) {
    console.error(`could not write MY_CLAW_RELEASE_URL: ${written.error}`);
    return 1;
  }
  if (github) {
    const removed = await removeEnvKey("MY_CLAW_RELEASE_KEY");
    if (!removed.ok) {
      console.error(`could not remove MY_CLAW_RELEASE_KEY: ${removed.error}`);
      return 1;
    }
  } else {
    const writtenKey = await setEnvValue("MY_CLAW_RELEASE_KEY", key!);
    if (!writtenKey.ok) {
      console.error(`could not write MY_CLAW_RELEASE_KEY: ${writtenKey.error}`);
      return 1;
    }
  }

  console.log(`Release source set: ${url} (latest release ${check.version}).`);
  console.log("Updates come from there from now on: myclaw update, the 15-minute timer, the app and the web client.");
  return 0;
}
