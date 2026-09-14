import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsDownload, fsUpload } from "../../src/channels/my-claw-app/fs-http.ts";

/**
 * The files page's transfer routes -- docs/files-page.md. Authentication is the adapter's (the
 * same credential /app-update/apk uses); what is exercised here is what a resolved device gets.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "fs-http-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uploadRequest(dir: string, files: Array<[string, File]>): Request {
  const form = new FormData();
  for (const [field, file] of files) form.append(field, file);
  return new Request(`http://localhost/fs/upload?path=${encodeURIComponent(dir)}`, { method: "POST", body: form });
}

test("an upload writes every part into the directory, keeping only the last name segment", async () => {
  const dir = temp();
  const response = await fsUpload(
    uploadRequest(dir, [
      ["one", new File([new Uint8Array([0, 1, 2, 255])], "../evil.bin")],
      ["two", new File(["résumé\n"], "résumé.txt")],
    ]),
    "dev",
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { path: string; files: Array<{ name: string; size: number }> };
  expect(body.path).toBe(dir);
  expect(body.files.map((file) => file.name).sort()).toEqual(["evil.bin", "résumé.txt"]);
  expect(Array.from(readFileSync(join(dir, "evil.bin")))).toEqual([0, 1, 2, 255]);
  expect(readFileSync(join(dir, "résumé.txt"), "utf8")).toBe("résumé\n");
});

test("an upload replacing a file keeps that file's mode", async () => {
  const dir = temp();
  const path = join(dir, "replace.txt");
  writeFileSync(path, "old");
  chmodSync(path, 0o600);

  const response = await fsUpload(uploadRequest(dir, [["f", new File(["new"], "replace.txt")]]), "dev");
  expect(response.status).toBe(200);
  expect(statSync(path).mode & 0o7777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe("new");
});

test("uploads need a directory and at least one file", async () => {
  const dir = temp();
  const noPath = await fsUpload(new Request("http://localhost/fs/upload", { method: "POST", body: "x" }), "dev");
  expect(noPath.status).toBe(400);

  const missing = await fsUpload(
    new Request(`http://localhost/fs/upload?path=${encodeURIComponent(join(dir, "nope"))}`, {
      method: "POST",
      body: new FormData(),
    }),
    "dev",
  );
  expect(missing.status).toBe(404);

  const empty = await fsUpload(uploadRequest(dir, []), "dev");
  expect(empty.status).toBe(400);
});

test("a download streams the file with an attachment disposition that survives accents", async () => {
  const dir = temp();
  const path = join(dir, "résumé.pdf");
  writeFileSync(path, "%PDF-1.4 fake");

  const response = await fsDownload(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  const disposition = response.headers.get("content-disposition") ?? "";
  expect(disposition).toContain("attachment");
  expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  expect(await response.text()).toBe("%PDF-1.4 fake");
});

test("a missing path, a missing file and a directory are all refused", async () => {
  expect((await fsDownload(null)).status).toBe(400);
  expect((await fsDownload(join(temp(), "nope"))).status).toBe(404);
  const dir = temp();
  mkdirSync(join(dir, "sub"));
  expect((await fsDownload(join(dir, "sub"))).status).toBe(404);
});
