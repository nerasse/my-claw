import { describe, test, expect } from "bun:test";
import { handleUpload, type MyClawAppFilesDeps } from "../../../src/channels/my-claw-app/files-http.ts";
import type { SessionFile, SessionFileStore } from "../../../src/channels/my-claw-app/files.ts";

/**
 * The name of an uploaded file, across the wire.
 *
 * An HTTP header value is ISO-8859-1. Both clients percent-encode the name for that reason (the
 * browser because it would otherwise send mojibake, the phone because OkHttp throws outright on a
 * value outside the range), and the server is the only place that can undo it.
 */

function depsRecording(seen: string[]): MyClawAppFilesDeps {
  const files = {
    saveStream(_owner: string, _thread: string, filename: string): Promise<SessionFile> {
      seen.push(filename);
      return Promise.resolve({
        id: "file-1",
        filename,
        type: "file",
        mimeType: "application/pdf",
        sizeBytes: 3,
      } as SessionFile);
    },
  } as unknown as SessionFileStore;
  return { files, media: new Map(), mediaOrder: [], thumbnails: new Map() };
}

function upload(name: string | null): Request {
  const headers: Record<string, string> = { "x-thread-id": "t1" };
  if (name !== null) headers["x-filename"] = name;
  return new Request("http://localhost/upload", { method: "POST", body: "pdf", headers });
}

describe("upload filename", () => {
  test("a percent-encoded name is stored as the name the owner typed", async () => {
    const seen: string[] = [];
    const response = await handleUpload(depsRecording(seen), "neras", upload(encodeURIComponent("résumé final.pdf")));

    expect(response.status).toBe(200);
    // Without the decode this was stored, listed and downloaded as r%C3%A9sum%C3%A9%20final.pdf.
    expect(seen).toEqual(["résumé final.pdf"]);
  });

  test("a plain ascii name is untouched", async () => {
    const seen: string[] = [];
    await handleUpload(depsRecording(seen), "neras", upload("report.pdf"));

    expect(seen).toEqual(["report.pdf"]);
  });

  test("a name carrying a literal percent is kept rather than dropped", async () => {
    const seen: string[] = [];
    // decodeURIComponent throws on this: an older client that never encoded still gets its file.
    await handleUpload(depsRecording(seen), "neras", upload("100% done.pdf"));

    expect(seen).toEqual(["100% done.pdf"]);
  });

  test("a missing name falls back instead of writing an empty one", async () => {
    const seen: string[] = [];
    await handleUpload(depsRecording(seen), "neras", upload(null));

    expect(seen).toEqual(["attachment"]);
  });
});
