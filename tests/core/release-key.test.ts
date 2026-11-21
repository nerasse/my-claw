import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../../src/core/config.ts";
import { DEFAULT_RELEASE_URL, runReleaseKeyCli } from "../../src/core/release-key.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

/**
 * `myclaw release-key`: the source is checked before anything is written, so a typo is said at
 * once instead of surfacing as an auto-update that never finds a release. A GitHub repository
 * needs no key; the neutral layout still does.
 */

const ENV = join(MY_CLAW_DIR, ".env");
let out: string[];
let err: string[];
const original = { log: console.log, error: console.error };

beforeEach(async () => {
  out = [];
  err = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  await writeFile(ENV, "# kept\nGROQ_API_KEY=g\nMY_CLAW_RELEASE_KEY=dlh_old\n", { mode: 0o600 });
});

afterEach(async () => {
  console.log = original.log;
  console.error = original.error;
  delete process.env["MY_CLAW_RELEASE_URL"];
  delete process.env["MY_CLAW_RELEASE_KEY"];
  await rm(ENV, { force: true });
});

function hub(answer: (auth: string | null) => Response) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const mock = mockFetch(async (input, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push({ url: String(input), auth });
    return answer(auth);
  });
  return { seen, mock };
}

const redirect = (repo: string, version: string) =>
  new Response(null, { status: 302, headers: { location: `${repo}/releases/tag/v${version}` } });

describe("myclaw release-key", () => {
  test("the default source is the GitHub repository: no key asked, the old one dropped", async () => {
    const { seen, mock } = hub(() => redirect(DEFAULT_RELEASE_URL, "0.7.202"));
    try {
      expect(
        await runReleaseKeyCli([], async () => {
          throw new Error("stdin must not be read for a GitHub source");
        }),
      ).toBe(0);
    } finally {
      mock.restore();
    }
    expect(seen).toEqual([{ url: `${DEFAULT_RELEASE_URL}/releases/latest`, auth: null }]);
    expect(await readFile(ENV, "utf8")).toBe(
      `# kept\nGROQ_API_KEY=g\nMY_CLAW_RELEASE_URL=${DEFAULT_RELEASE_URL}\n`,
    );
    expect((await stat(ENV)).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).toContain("latest release 0.7.202");
  });

  test("the old dl-hub URL is the GitHub source now, key ignored", async () => {
    const { seen, mock } = hub(() => redirect(DEFAULT_RELEASE_URL, "0.7.202"));
    try {
      expect(await runReleaseKeyCli(["--url", "https://dl.kssimi.fr/my-claw/", "dlh_old"])).toBe(0);
    } finally {
      mock.restore();
    }
    expect(seen).toEqual([{ url: `${DEFAULT_RELEASE_URL}/releases/latest`, auth: null }]);
    const env = await readFile(ENV, "utf8");
    expect(env).toContain(`MY_CLAW_RELEASE_URL=${DEFAULT_RELEASE_URL}\n`);
    expect(env).not.toContain("MY_CLAW_RELEASE_KEY");
  });

  test("a GitHub source with no release writes nothing and says so", async () => {
    const { mock } = hub(() => new Response("not found", { status: 404 }));
    try {
      expect(await runReleaseKeyCli([])).toBe(1);
    } finally {
      mock.restore();
    }
    expect(err.join("\n")).toContain("has no published release");
    expect(err.join("\n")).toContain("Nothing changed");
    expect(await readFile(ENV, "utf8")).toBe("# kept\nGROQ_API_KEY=g\nMY_CLAW_RELEASE_KEY=dlh_old\n");
  });

  test("--url keeps the neutral layout and writes both lines", async () => {
    const { seen, mock } = hub(() => Response.json({ version: "1.0.0" }));
    try {
      expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app/", "dlh_k"])).toBe(0);
    } finally {
      mock.restore();
    }
    expect(seen[0]).toEqual({ url: "https://dl.example.test/app/server/latest.json", auth: "Bearer dlh_k" });
    const env = await readFile(ENV, "utf8");
    expect(env).toContain("MY_CLAW_RELEASE_URL=https://dl.example.test/app\n");
    expect(env).toContain("MY_CLAW_RELEASE_KEY=dlh_k\n");
  });

  test("a refused key writes nothing and says why", async () => {
    for (const [status, words] of [[401, "the key was refused"], [403, "not valid for"], [502, "answered HTTP 502"]] as const) {
      err = [];
      const { mock } = hub(() => new Response("this key is for another product", { status }));
      try {
        expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app", "dlh_bad"])).toBe(1);
      } finally {
        mock.restore();
      }
      expect(err.join("\n")).toContain(words);
      expect(err.join("\n")).toContain("Nothing changed");
    }
    expect(await readFile(ENV, "utf8")).toBe("# kept\nGROQ_API_KEY=g\nMY_CLAW_RELEASE_KEY=dlh_old\n");
  });

  test("an answer that is not a release source is refused too", async () => {
    const { mock } = hub(() => new Response("<html>login</html>", { status: 200 }));
    try {
      expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app", "dlh_x"])).toBe(1);
    } finally {
      mock.restore();
    }
    expect(err.join("\n")).toContain("does not look like a release source");
  });

  test("without a key on the command line, the layout source reads it from standard input", async () => {
    const { seen, mock } = hub(() => Response.json({ version: "1.0.0" }));
    try {
      expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app"], async () => "  dlh_stdin  ")).toBe(0);
    } finally {
      mock.restore();
    }
    expect(seen[0]!.auth).toBe("Bearer dlh_stdin");
  });

  test("bad arguments are refused before any request", async () => {
    const { seen, mock } = hub(() => Response.json({ version: "1.0.0" }));
    try {
      expect(await runReleaseKeyCli(["a", "b"])).toBe(1);
      expect(await runReleaseKeyCli(["--url"])).toBe(1);
      expect(await runReleaseKeyCli(["--url", "dl.example.test", "k"])).toBe(1);
      expect(await runReleaseKeyCli(["--force", "k"])).toBe(1);
      expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app"], async () => "")).toBe(1);
      expect(await runReleaseKeyCli(["--url", "https://dl.example.test/app"], async () => "two words")).toBe(1);
    } finally {
      mock.restore();
    }
    expect(seen).toEqual([]);
  });
});
