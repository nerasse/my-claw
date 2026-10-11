import { setEnvValue } from "./env-edit.ts";

/**
 * `myclaw release-key`: points this install at its release source, docs/release-source.md.
 *
 * The key is tried before anything is written: a mistyped key would otherwise only show up as an
 * auto-update that silently never finds a release. The running server picks the two lines up on
 * its own (.env is hot-reloaded), and the shell updaters read them on their next run.
 */

export const DEFAULT_RELEASE_URL = "https://dl.kssimi.fr/my-claw";

const USAGE = `usage: myclaw release-key [<key>] [--url <release url>]

  Sets the release source updates come from, after checking that the key works.
  Without <key>, the key is read from standard input (nothing is echoed to the terminal).
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

export async function checkReleaseKey(url: string, key: string): Promise<CheckResult> {
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
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) {
    console.error(`not a URL: ${url}`);
    return 1;
  }
  key = (key ?? (await read())).trim();
  if (!key) {
    console.error("no key given");
    return 1;
  }
  if (/\s/.test(key)) {
    console.error("a key has no spaces: copy it again");
    return 1;
  }

  const check = await checkReleaseKey(url, key);
  if (!check.ok) {
    console.error(`Nothing changed: ${check.error}`);
    return 1;
  }
  for (const [name, value] of [["MY_CLAW_RELEASE_URL", url], ["MY_CLAW_RELEASE_KEY", key]] as const) {
    const written = await setEnvValue(name, value);
    if (!written.ok) {
      console.error(`could not write ${name}: ${written.error}`);
      return 1;
    }
  }
  console.log(`Release source set: ${url} (latest server release ${check.version}).`);
  console.log("Updates come from there from now on: myclaw update, the 15-minute timer, the app and the web client.");
  return 0;
}
