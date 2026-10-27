import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Tool, type ToolResult, numOpt, str, strOpt, bool } from "../types.ts";
import type { BrowserClient } from "../../browser/client.ts";
import type { BrowserConfig } from "../../core/config.ts";
import { MY_CLAW_DIR } from "../../core/config.ts";
import { windowed, workspaceOf } from "./state.ts";
import type { BrowserWindows } from "./windows.ts";

/**
 * Where the browser agent may write, and the only place: the download directory. The page chooses
 * the names of what it downloads, so this is the one spot in the agent's toolbox where a hostile
 * page gets a say in a path — every tool here resolves inside that root and refuses the rest.
 *
 * Everything the agent needs files for was measured (2026-10-27, 1631 runs): name what was
 * downloaded, move it next to the sources it belongs to, list what is there, check a size. All of
 * it fits in one directory, so the browser agent still gets no path to the rest of the disk.
 */
export function downloadRoot(config: BrowserConfig | undefined, args: Record<string, unknown>, workspaceDir?: string): string {
  if (config?.downloadDir) return resolve(config.downloadDir);
  const workspace = workspaceOf(args, workspaceDir);
  return workspace ? join(resolve(workspace), "downloads") : join(MY_CLAW_DIR, "workspace", "downloads");
}

/** A path the agent named, proven to be inside the root. Absolute paths are refused rather than
 *  reinterpreted: a caller that means "elsewhere" wants an error, not a file in the wrong place. */
export function resolveInRoot(root: string, path: string): string {
  if (isAbsolute(path) || path.startsWith("~")) {
    throw new Error(`Only paths inside the download directory are allowed: "${path}". Give it relative, e.g. "report.pdf" or "papers/report.pdf".`);
  }
  const target = resolve(root, path);
  const base = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(base)) {
    throw new Error(`"${path}" leaves the download directory (${root}); relative paths only, no "..".`);
  }
  return target;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the file is versus what its name claims, which is the failure an agent reports as a
 *  success: a paywall or a 504 answers a PDF link with an HTML page, and the name keeps ".pdf". */
function mismatch(kind: string | undefined, filename: string): string | undefined {
  if (kind !== "html") return undefined;
  const claimsDocument = /\.(pdf|docx?|xlsx?|pptx?|epub|zip|csv)$/i.test(filename);
  return claimsDocument ? `The site answered with an HTML page, not the file this name claims (${filename}): it is probably a login wall, a paywall or an error page.` : undefined;
}

function describe(claimed: { filename: string; path: string; bytes?: number; kind?: string; url?: string }): string {
  const kind = claimed.kind ? `, ${claimed.kind}` : "";
  const warning = mismatch(claimed.kind, claimed.filename);
  const source = claimed.url ? `\nfrom ${claimed.url}` : "";
  return `${claimed.filename} -> ${claimed.path} (${formatBytes(claimed.bytes)}${kind})${source}${warning ? `\nWARNING: ${warning}` : ""}`;
}

async function pageIdOf(pages: BrowserWindows, args: Record<string, unknown>): Promise<string | undefined> {
  try {
    return await pages.page(args);
  } catch {
    // The tab that downloaded is gone, which is exactly the case the staging registry exists for.
    return undefined;
  }
}

async function windowIdOf(pages: BrowserWindows, args: Record<string, unknown>): Promise<number | undefined> {
  try {
    return await pages.window(args);
  } catch {
    return undefined;
  }
}

export interface DownloadToolsOptions {
  config?: BrowserConfig;
  workspaceDir?: string;
}

export function createBrowserDownloadTool(client: BrowserClient, pages: BrowserWindows, opts: DownloadToolsOptions): Tool {
  return {
    name: "browser_download",
    description:
      "Save a file the page downloaded and get its path. Click the link first, then call this: the file is already secured (the browser holds it even if the tab closes), so this only names and places it. Give filename to rename it, dir to put it in a subdirectory of the download directory. Called again with no arguments, it takes the next download nobody has claimed yet. Reports the real type and size of the file.",
    parameters: windowed({
      type: "object",
      properties: {
        filename: { type: "string", description: "Name to save it under, e.g. \"hobart-2023.pdf\". Default: the page's own name, sanitised." },
        dir: { type: "string", description: "Subdirectory of the download directory, e.g. \"papers/2023\". Created if missing." },
        id: { type: "number", description: "The download to save, as browser_downloads lists it. Default: the oldest unclaimed one." },
        overwrite: { type: "boolean", description: "Replace a file of the same name instead of picking \"name (2)\"" },
        timeout_ms: { type: "number", description: "How long to wait for a download to appear, in ms (default 5000)" },
      },
    }),
    async execute(args): Promise<ToolResult> {
      try {
        const root = downloadRoot(opts.config, args, opts.workspaceDir);
        const dir = strOpt(args, "dir");
        const destination = dir ? resolveInRoot(root, dir) : root;
        const id = numOpt(args, "id");
        const filename = strOpt(args, "filename");
        if (filename !== undefined) resolveInRoot(root, filename); // refuses an escaping name before anything runs
        const claimed = await client.claimDownload({
          ...(id !== undefined ? { id } : {}),
          ...(filename !== undefined ? { filename } : {}),
          pageId: await pageIdOf(pages, args),
          windowId: await windowIdOf(pages, args),
          dir: destination,
          overwrite: bool(args, "overwrite", false),
          waitMs: numOpt(args, "timeout_ms") ?? 5000,
        });
        return { success: true, output: describe(claimed) };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserDownloadsTool(client: BrowserClient, pages: BrowserWindows): Tool {
  return {
    name: "browser_downloads",
    description:
      "The files this window downloaded: their id, the name the page gave, their state, size, real type and where each was saved. Read it when you are not sure what a click downloaded, or whether an earlier download already got the file. Downloads still in progress show as saving; a failed one says why.",
    parameters: windowed({ type: "object", properties: {} }),
    async execute(args): Promise<ToolResult> {
      try {
        const records = await client.downloads({
          pageId: await pageIdOf(pages, args),
          windowId: await windowIdOf(pages, args),
        });
        if (records.length === 0) return { success: true, output: "Nothing has been downloaded in this window." };
        const lines = records.map((r) => {
          const state = r.state === "ready" ? "" : ` [${r.state}${r.error ? `: ${r.error}` : ""}]`;
          const size = r.bytes !== undefined ? ` ${formatBytes(r.bytes)}` : "";
          const kind = r.kind ? ` ${r.kind}` : "";
          const where = r.claimedInto ? ` -> ${r.claimedInto}` : " (not saved yet: browser_download)";
          const warning = mismatch(r.kind, r.claimedInto ?? r.suggested);
          return `#${r.id} ${r.suggested}${state}${size}${kind}${where}${warning ? `\n   WARNING: ${warning}` : ""}`;
        });
        return { success: true, output: `${records.length} download(s):\n${lines.join("\n")}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

/**
 * The files the agent already has on disk. Read-only listing plus the three mutations that were
 * measured as needed: rename, move, remove. Every path resolves inside the download root, so this
 * never becomes a second way around the machine -- the browser agent reads hostile pages all day.
 */
export function createBrowserFileListTool(opts: DownloadToolsOptions): Tool {
  return {
    name: "browser_file_list",
    description:
      "List what is in the download directory (or one of its subdirectories): names, sizes and types, with directories marked. Use it to see what you already downloaded instead of downloading a file twice.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Subdirectory, relative to the download directory (default: all of it)" },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const root = downloadRoot(opts.config, args, opts.workspaceDir);
        const dir = strOpt(args, "dir");
        const target = dir ? resolveInRoot(root, dir) : root;
        await mkdir(target, { recursive: true });
        const entries = await readdir(target, { withFileTypes: true });
        if (entries.length === 0) return { success: true, output: `${target} is empty.` };
        const rows = await Promise.all(
          entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
            const path = join(target, entry.name);
            if (entry.isDirectory()) return `dir  ${entry.name}/`;
            const info = await stat(path).catch(() => undefined);
            return `     ${entry.name} (${formatBytes(info?.size)})`;
          }),
        );
        return { success: true, output: `${target}\n${rows.join("\n")}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFileStatTool(opts: DownloadToolsOptions): Tool {
  return {
    name: "browser_file_stat",
    description: "Whether a downloaded file exists, and its size, type and modification time. Cheaper than listing the whole directory when you only need one answer.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the download directory" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const root = downloadRoot(opts.config, args, opts.workspaceDir);
        const target = resolveInRoot(root, str(args, "path"));
        const info = await stat(target).catch(() => undefined);
        if (!info) return { success: true, output: `Does not exist: ${target}` };
        const kind = info.isDirectory() ? "directory" : "file";
        return { success: true, output: `${target}: ${kind}, ${formatBytes(info.size)}, modified ${new Date(info.mtimeMs).toISOString()}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFileMoveTool(opts: DownloadToolsOptions): Tool {
  return {
    name: "browser_file_move",
    description:
      "Rename or move a downloaded file inside the download directory: the page's own name is often unreadable, and a file sometimes belongs in a subdirectory. Both paths are relative to the download directory; missing parent directories are created.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current path, relative to the download directory" },
        to: { type: "string", description: "New path, relative to the download directory" },
        overwrite: { type: "boolean", description: "Replace the destination if it exists (default false: an existing file is an error)" },
      },
      required: ["from", "to"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const root = downloadRoot(opts.config, args, opts.workspaceDir);
        const from = resolveInRoot(root, str(args, "from"));
        const to = resolveInRoot(root, str(args, "to"));
        if (from === to) return { success: true, output: `Already at ${to}` };
        const source = await stat(from).catch(() => undefined);
        if (!source) return { success: false, output: "", error: `No such file: ${from}` };
        const existing = await stat(to).catch(() => undefined);
        if (existing && !bool(args, "overwrite", false)) {
          return { success: false, output: "", error: `${to} already exists. Pass overwrite=true to replace it, or give another name.` };
        }
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
        return { success: true, output: `${relative(root, from)} -> ${relative(root, to)}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}

export function createBrowserFileRemoveTool(opts: DownloadToolsOptions): Tool {
  return {
    name: "browser_file_remove",
    description: "Delete a file (or a directory) inside the download directory. Use it to drop a broken or duplicate download instead of leaving it behind.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the download directory" },
        recursive: { type: "boolean", description: "Delete a non-empty directory too (default false)" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const root = downloadRoot(opts.config, args, opts.workspaceDir);
        const target = resolveInRoot(root, str(args, "path"));
        if (target === resolve(root)) {
          return { success: false, output: "", error: "That is the download directory itself: name what to delete inside it." };
        }
        const info = await stat(target).catch(() => undefined);
        if (!info) return { success: false, output: "", error: `No such file: ${target}` };
        if (info.isDirectory() && !bool(args, "recursive", false)) {
          const left = await readdir(target).catch(() => []);
          if (left.length > 0) {
            return { success: false, output: "", error: `${target} is a non-empty directory (${left.length} entries). Pass recursive=true, or delete its files one by one.` };
          }
        }
        await rm(target, { recursive: info.isDirectory() && bool(args, "recursive", false), force: false });
        return { success: true, output: `Removed ${relative(root, target)}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };
}
