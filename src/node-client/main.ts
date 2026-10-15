import { exposedTools, loadClientTls, loadConfig, loadToken, nodeDir } from "./config.ts";
import { NodeRevokedError, runNode, type NodeLogLevel } from "./connection.ts";
import { pairNode } from "./pair.ts";
import { CLIENT_VERSION } from "./version.ts";

/**
 * `myclaw-node`: the client half of docs/remote-nodes.md. Three commands and nothing else:
 *
 *   myclaw-node pair --server wss://myclaw.example/node --code ABCD1234
 *   myclaw-node run          (what the service runs)
 *   myclaw-node status
 */

const USAGE = `usage: myclaw-node <command>

  pair --server <url> --code <code> [--name <name>] [--workdir <dir>] [--dir <config dir>]
                                 pair this machine with a my-claw (mint the code with
                                 \`myclaw node add\` there), then store the token
  run [--dir <config dir>]       connect and serve tool calls (the service's entry point)
  status [--dir <config dir>]    what this machine is paired to
  version                        print the client version
`;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        flags[name] = args[i + 1] ?? "";
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function logLine(level: NodeLogLevel, message: string, data?: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...(data ?? {}) })}\n`);
}

async function runPair(flags: Record<string, string>): Promise<number> {
  const server = flags["server"]?.trim();
  const code = flags["code"]?.trim();
  if (!server || !code) {
    process.stderr.write("pair needs --server <url> and --code <code>\n");
    return 1;
  }
  if (!server.startsWith("ws://") && !server.startsWith("wss://")) {
    process.stderr.write(`--server must be a ws:// or wss:// URL (got "${server}")\n`);
    return 1;
  }
  try {
    const paired = await pairNode({
      server,
      code,
      ...(flags["name"] ? { name: flags["name"] } : {}),
      ...(flags["workdir"] ? { workdir: flags["workdir"] } : {}),
      ...(flags["dir"] ? { dir: flags["dir"] } : {}),
    });
    process.stdout.write(`Paired as ${paired.nodeId} ("${paired.name}").\n`);
    process.stdout.write("Start it with: myclaw-node run (or the service the installer set up)\n");
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function runService(flags: Record<string, string>): Promise<number> {
  const dir = flags["dir"] ?? nodeDir();
  const config = await loadConfig(dir);
  const token = await loadToken(dir);
  if (!config || !token) {
    process.stderr.write(`not paired yet (looked in ${dir}): run \`myclaw-node pair --server ... --code ...\` first\n`);
    return 1;
  }
  const tls = await loadClientTls(dir);
  logLine("info", "starting", {
    version: CLIENT_VERSION,
    server: config.server,
    tools: exposedTools(config),
    mtls: Boolean(tls),
  });
  // SIGTERM is how the service stops: close the socket, leave cleanly.
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await runNode({
      config,
      token,
      tls,
      log: logLine,
      dir,
      signal: controller.signal,
      ...(flags["once"] !== undefined ? { once: true } : {}),
    });
    return 0;
  } catch (err) {
    if (err instanceof NodeRevokedError) {
      logLine("error", "revoked", { error: err.message });
      // Nothing to retry: the token is dead server-side. Exit non-zero so systemd shows it.
      return 2;
    }
    throw err;
  }
}

async function runStatus(flags: Record<string, string>): Promise<number> {
  const dir = flags["dir"] ?? nodeDir();
  const config = await loadConfig(dir);
  const token = await loadToken(dir);
  if (!config) {
    process.stdout.write(`Not paired (no config in ${dir}).\n`);
    return 1;
  }
  const tls = await loadClientTls(dir);
  process.stdout.write(`Server  ${config.server}\n`);
  process.stdout.write(`Name    ${config.name ?? "(none)"}\n`);
  process.stdout.write(`Token   ${token ? "present" : "missing"}\n`);
  process.stdout.write(`mTLS    ${tls ? "certificate stored" : "none"}\n`);
  process.stdout.write(`Tools   ${exposedTools(config).join(", ") || "(none)"}\n`);
  process.stdout.write(`Workdir ${config.workdir ?? "(home)"}\n`);
  process.stdout.write(`Config  ${dir}\n`);
  return 0;
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || flags["help"] !== undefined) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command === "version") {
    process.stdout.write(`${CLIENT_VERSION}\n`);
    return 0;
  }
  if (command === "pair") return runPair(flags);
  if (command === "run") return runService(flags);
  if (command === "status") return runStatus(flags);
  process.stderr.write(USAGE);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
