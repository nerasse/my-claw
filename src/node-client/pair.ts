import { rm } from "node:fs/promises";
import {
  httpBaseOf,
  loadClientTls,
  nodeDir,
  saveClientTls,
  saveConfig,
  saveToken,
  type NodeClientConfig,
} from "./config.ts";
import { buildFacts } from "./facts.ts";

/**
 * `myclaw-node pair`: trades a claim code for this machine's token, and stores what the service
 * will need. The server mints the node, generates its agent, and (in the mTLS mode) issues its
 * certificate, all in this one exchange (docs/remote-nodes.md).
 */

export interface PairOptions {
  server: string;
  code: string;
  name?: string;
  workdir?: string;
  dir?: string;
}

export interface PairedNode {
  nodeId: string;
  name: string;
}

const DENIALS: Record<string, string> = {
  unknown: "that code is not known on this server (check it, or mint a new one with `myclaw node add`)",
  expired: "that code has expired (mint a new one with `myclaw node add`)",
  used: "that code was already used (each one pairs exactly one machine)",
  attempts: "too many attempts from this address; wait a minute and retry",
};

export async function pairNode(options: PairOptions): Promise<PairedNode> {
  const dir = options.dir ?? nodeDir();
  const config: NodeClientConfig = {
    server: options.server,
    ...(options.workdir ? { workdir: options.workdir } : {}),
  };
  const facts = buildFacts(config);
  const response = await fetch(`${httpBaseOf(options.server)}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: options.code, facts }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    const reason = body.error ?? `HTTP ${response.status}`;
    throw new Error(DENIALS[reason] ?? `pairing refused: ${reason}`);
  }

  const body = (await response.json()) as {
    nodeId?: unknown;
    name?: unknown;
    token?: unknown;
    mtls?: { ca?: unknown; cert?: unknown; key?: unknown };
  };
  if (typeof body.nodeId !== "string" || typeof body.token !== "string" || typeof body.name !== "string") {
    throw new Error("the server's answer is missing the node id or token");
  }

  await saveConfig({ ...config, name: options.name ?? body.name }, dir);
  await saveToken(body.token, dir);
  if (
    body.mtls &&
    typeof body.mtls.ca === "string" &&
    typeof body.mtls.cert === "string" &&
    typeof body.mtls.key === "string"
  ) {
    await saveClientTls({ ca: body.mtls.ca, cert: body.mtls.cert, key: body.mtls.key }, dir);
  } else if (await loadClientTls(dir)) {
    // A re-pair on a server that no longer issues certificates must not keep presenting a stale
    // one: the proxy would refuse it and the socket would never open.
    await rm(`${dir}/ca.pem`, { force: true });
    await rm(`${dir}/client.pem`, { force: true });
    await rm(`${dir}/client-key.pem`, { force: true });
  }

  return { nodeId: body.nodeId, name: typeof body.name === "string" ? body.name : body.nodeId };
}
