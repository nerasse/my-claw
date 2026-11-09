import type { Tool, ToolResult } from "./types.ts";
import { strOpt } from "./types.ts";
import type { UnifiedMessage } from "../channels/types.ts";
import { askOwner, hasApprovalSurface, pendingApprovals } from "../approvals/ask.ts";
import { rethrowIfAborted } from "../core/aborted.ts";
import type { ApprovalGrantConfig, MyClawConfig } from "../core/config.ts";
import { nodeRecords } from "../nodes/store.ts";
import { nodeState } from "../nodes/hub.ts";

/**
 * The agent asking the owner for permission, reading what is already waiting, and reading what it
 * may already do.
 *
 * Three actions in one tool on purpose: they are the same subject from three sides (my run is
 * blocked, another run is blocked, this call was already allowed), and a second tool for a listing
 * would cost every prompt a definition for nothing. `notify` was the wrong neighbour: its subject is
 * reaching the owner, not what he already permitted.
 *
 * `request` waits with no timer. This is the one path where the run means to wait: the agent chose
 * to ask, so a timeout would be the machine answering "no" for the owner. Stop cancels it, and a
 * message typed into the conversation cancels it the way a question is cancelled.
 *
 * `grants` reads, never writes: a permission is the owner's to give, and a model that could grant
 * itself one would make the whole gate decorative.
 */
export function createApprovalTool(config?: MyClawConfig): Tool {
  return {
    name: "approval",
    description: [
      "Ask the owner before doing something risky or irreversible, see what is already waiting on him, and read what already runs without asking.",
      "action=request: raises the approval sheet with your sentence and the exact call, then the run waits -- no timeout, until he answers, stops the run or types. Returns approved, approved-always (he allowed this exact call for good), denied or cancelled.",
      "action=list: everything still waiting for an answer, across every conversation and machine, so you can tell a blocked sub-agent from a hung one.",
      "action=grants: per machine, whether anything asks before it runs, and the exact calls already allowed for good. Read this before planning work on a remote node: it says which calls go straight through instead of discovering the gate by hitting it. A grant matches the arguments exactly as written, key for key, so a call that adds or drops an argument asks again.",
      "Ask once per decision, not once per step: a shell command that needs a yes does not need a second yes for the check after it. Never ask for something you would not do if he said no.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["request", "list", "grants"], description: "request = ask and wait; list = what is waiting; grants = what already runs without asking." },
        what: { type: "string", description: "request: one sentence, what you are about to do and why it needs a yes." },
        tool: { type: "string", description: "request: the tool you will run (default bash when command is given)." },
        command: { type: "string", description: "request: the exact bash command. It is what \"always allow this exact call\" matches." },
        args: { type: "object", description: "request: the exact arguments of the call, when they are not a bash command." },
        origin: { type: "string", description: "grants: one machine only -- 'local', a node's name or its id. Omit for every machine." },
      },
      required: ["action"],
    },
    async execute(args): Promise<ToolResult> {
      const action = strOpt(args, "action") ?? "request";
      const message = args["__message"] as UnifiedMessage | undefined;
      const signal = args["__signal"] as AbortSignal | undefined;
      const owner = message?.chatId ?? "";
      const sessionId = typeof args["__sessionId"] === "string" ? args["__sessionId"] : "";

      if (action === "grants") return grantsReport(config, strOpt(args, "origin"));

      if (action === "list") {
        const waiting = pendingApprovals(owner);
        if (waiting.length === 0) return { success: true, output: "Nothing is waiting for approval." };
        const lines = waiting.map((entry) => {
          const detail = summaryOf(entry.args);
          return `- ${entry.id} · ${entry.origin} · ${entry.toolName}${detail ? `: ${detail}` : ""} · waiting since ${entry.since}${entry.waitForever ? " (no timeout)" : ""}`;
        });
        return { success: true, output: `${waiting.length} waiting:\n${lines.join("\n")}` };
      }

      if (action !== "request") {
        return { success: false, output: "", error: `approval: unknown action "${action}"` };
      }
      if (!hasApprovalSurface()) return { success: false, output: "", error: "No channel surface to ask for approval on" };

      const what = (strOpt(args, "what") ?? "").trim();
      if (!what) return { success: false, output: "", error: "approval: what is required for a request" };
      const command = strOpt(args, "command");
      const callArgs = command !== undefined ? { command } : (args["args"] as Record<string, unknown> | undefined) ?? {};
      const toolName = strOpt(args, "tool") ?? (command !== undefined ? "bash" : "action");

      try {
        const decision = await askOwner({
          id: `ask-${crypto.randomUUID()}`,
          platform: message?.platform ?? "my-claw-app",
          chatId: owner,
          userId: message?.userId ?? "",
          chatType: message?.chatType ?? "dm",
          messageId: message?.id ?? "",
          sessionId,
          toolName,
          args: callArgs,
          ...(message?.threadId ? { threadId: message.threadId } : {}),
          ...(typeof args["__toolCallId"] === "string" ? { replyToId: args["__toolCallId"] } : {}),
          headline: what,
        });
        if (signal?.aborted) rethrowIfAborted(new Error("aborted"), signal);
        switch (decision) {
          case "allow-always":
            return { success: true, output: "approved-always: the owner allowed this exact call for good on this machine. Run it now." };
          case "allow-session":
          case "allow-once":
            return { success: true, output: "approved: the owner said yes. Run it now." };
          default:
            return { success: true, output: "denied: the owner said no. Do not run it, and do not ask again for the same thing." };
        }
      } catch (err) {
        rethrowIfAborted(err, signal);
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}

/** Whole output, not per machine: six machines each showing everything is unreadable. */
const MAX_REPORT_LINES = 50;
/** One grant's canonical JSON, kept on one line. A longer call is read from the config by hand. */
const MAX_ARGS_CHARS = 300;

interface MachineReport {
  /** What the owner calls it: `local`, or the node's display name. */
  name: string;
  /** `local` or the node id: the key a grant is stored under. */
  key: string;
  /** Beside the name when the machine is not simply available: `offline`, `disabled`, `not paired`. */
  state: string;
  /** What happens before a call here, in the words the owner would use. */
  gate: string;
  /** False for a machine that is not paired any more: its grants are inert. */
  live: boolean;
  grants: ApprovalGrantConfig[];
}

/**
 * The machines a grant can name, and whether anything asks before a call there.
 *
 * The gate has two sources and either one is enough: the global `blacklist` (names, so it catches a
 * node's tool of the same name) and the node's own "ask before running" flag, which asks for every
 * call. A revoked node keeps its grants in the config -- nothing prunes them -- so they are shown
 * as inert rather than counted as available.
 */
function machinesOf(config: MyClawConfig | undefined): MachineReport[] {
  const byOrigin = new Map<string, ApprovalGrantConfig[]>();
  for (const grant of config?.tools?.alwaysAllow ?? []) {
    byOrigin.set(grant.origin, [...(byOrigin.get(grant.origin) ?? []), grant]);
  }
  const blacklist = config?.blacklist ?? [];
  const reports: MachineReport[] = [{
    name: "local",
    key: "local",
    state: "",
    gate: gateLabel(blacklist, false),
    live: true,
    grants: byOrigin.get("local") ?? [],
  }];
  for (const record of nodeRecords()) {
    // The state rides next to the name: "can I use this machine right now" is what the gate line is
    // read to answer, and a roster of names alone does not say it.
    const state = nodeState(record.nodeId);
    reports.push({
      name: record.name,
      key: record.nodeId,
      state: state === "online" ? "" : state,
      gate: gateLabel(blacklist, record.approval === true),
      live: true,
      grants: byOrigin.get(record.nodeId) ?? [],
    });
  }
  const paired = new Set(reports.map((report) => report.key));
  for (const [origin, grants] of byOrigin) {
    if (paired.has(origin)) continue;
    reports.push({ name: origin, key: origin, state: "not paired", gate: "nothing runs here", live: false, grants });
  }
  return reports;
}

function gateLabel(blacklist: readonly string[], everyCall: boolean): string {
  if (everyCall) return "asks before every call";
  if (blacklist.length === 0) return "nothing asks";
  return `asks before: ${blacklist.join(", ")}`;
}

/**
 * `origin` matches `local`, a node's id, or its display name, case-insensitively. A name is what
 * the owner says out loud and what the approval sheet shows, so it has to work without a lookup.
 */
function findMachine(reports: MachineReport[], origin: string): MachineReport | undefined {
  const wanted = origin.trim().toLowerCase();
  if (!wanted) return undefined;
  return reports.find((report) => report.key.toLowerCase() === wanted)
    ?? reports.find((report) => report.name.toLowerCase() === wanted);
}

function grantsReport(config: MyClawConfig | undefined, origin: string | undefined): ToolResult {
  const reports = machinesOf(config);
  let shown = reports;
  if (origin !== undefined && origin.trim() !== "") {
    const one = findMachine(reports, origin);
    if (!one) {
      const known = reports.map((report) => (report.name === report.key ? report.key : `${report.name} (${report.key})`));
      return { success: false, output: "", error: `approval: unknown machine "${origin}". Known: ${known.join(", ") || "none"}` };
    }
    shown = [one];
  }

  const lines: string[] = [];
  let cut = 0;
  for (const report of shown) {
    const count = report.grants.length;
    // The id rides along because a grant is stored under it: a reader correlating with
    // `config.json` or the approvals page needs the pair, and a name alone does not give it.
    const id = report.key === "local" || report.key === report.name ? "" : ` (${report.key})`;
    const state = report.state ? ` [${report.state}]` : "";
    const head = `${report.name}${id}${state} -- ${report.gate} | ${count === 0 ? "no grants" : `${count} grant${count === 1 ? "" : "s"}`}`;
    if (lines.length >= MAX_REPORT_LINES) {
      cut += 1 + count;
      continue;
    }
    lines.push(head);
    for (const grant of report.grants) {
      if (lines.length >= MAX_REPORT_LINES) {
        cut += 1;
        continue;
      }
      lines.push(`  ${grant.tool} ${argsOf(grant)}${report.live ? "" : " (inert)"}`);
    }
  }
  if (cut > 0) lines.push(`+${cut} lines not shown -- narrow with origin, or read tools.alwaysAllow`);
  return {
    success: true,
    output: `Where a call still asks, and which exact calls do not. Arguments match key for key, so send them as written.\n${lines.join("\n")}`,
  };
}

function argsOf(grant: ApprovalGrantConfig): string {
  const text = grant.args.trim() || "{}";
  return text.length > MAX_ARGS_CHARS
    ? `${text.slice(0, MAX_ARGS_CHARS)}... (truncated, the full call is in tools.alwaysAllow)`
    : text;
}

/** The argument that says what the pending call is about, for the one-line listing. */
function summaryOf(args: Record<string, unknown>): string {
  const key = ["command", "path", "url", "pattern"].find((name) => typeof args[name] === "string" && (args[name] as string).trim().length > 0);
  return key ? (args[key] as string).trim().slice(0, 160) : "";
}
