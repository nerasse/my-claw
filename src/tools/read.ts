import { readFile, access } from "node:fs/promises";
import { type Tool, type ToolResult, str, strOpt } from "./types.ts";
import { resolveWorkspacePath } from "./workspace.ts";
import { formatError } from "../utils/errors.ts";
import { hooks } from "../hooks/index.ts";

const MAX_READ_CHARS = 100_000;

// The four formats every vision endpoint accepts, sniffed by magic bytes: a screenshot pasted
// under a name with no extension is still an image, and extension trust is how a text file named
// .png would return garbage. Same set opencode reads; the model receives the image itself as an
// attachment of this result (owner, 2026-09-22: an agent could not load an image into its context).
const IMAGE_MIMES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  {
    mime: "image/webp",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

// No extension fallback on purpose: every supported format has magic bytes, so a name can only
// ever misfire (a text file called notes.png would be sent to the vision API as a picture).
function sniffImage(sample: Buffer): string | undefined {
  return IMAGE_MIMES.find((m) => m.test(sample))?.mime;
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a file from the filesystem. Image files (png, jpeg, gif, webp) return the image itself into the model's context, like an attachment would -- use this to look at a screenshot or any picture on disk.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
    },
    required: ["path"],
  },
  async execute(args): Promise<ToolResult> {
    const resolved = resolveWorkspacePath(str(args, "path"), strOpt(args, "__workspaceDir"));
    try {
      await access(resolved);
    } catch {
      return { success: false, output: `File not found: ${resolved}. Check the path and ensure the file exists.` };
    }
    try {
      const raw = await readFile(resolved);
      const sample = raw.subarray(0, 4096);
      const mime = sniffImage(sample);
      if (mime) {
        hooks.emit("tool:file:read", { path: resolved, size: raw.length });
        const kb = Math.max(1, Math.round(raw.length / 1024));
        return {
          success: true,
          output: `Image read successfully: ${resolved} (${mime}, ${kb} KB). The image itself follows this result and is now in your context.`,
          attachments: [{ type: "image", path: resolved, mimeType: mime }],
          modelOnly: true,
        };
      }
      if (sample.includes(0)) {
        return {
          success: false,
          output: `Binary file, not readable as text: ${resolved} (${Math.round(raw.length / 1024)} KB).`,
        };
      }
      const content = raw.toString("utf-8");
      hooks.emit("tool:file:read", { path: resolved, size: content.length });
      // Cap like the other text tools: one read of a huge log/file must not poison the session.
      if (content.length > MAX_READ_CHARS) {
        return { success: true, output: `${content.slice(0, MAX_READ_CHARS)}\n[output truncated at ${MAX_READ_CHARS} chars; file is ${content.length} chars]` };
      }
      return { success: true, output: content };
    } catch (e) {
      return { success: false, output: "", error: formatError(`Failed to read "${resolved}"`, e) };
    }
  },
};
