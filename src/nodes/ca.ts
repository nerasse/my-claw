import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MY_CLAW_DIR } from "../core/config.ts";
import { log } from "../utils/logger.ts";

/**
 * The small CA behind the mTLS deployment mode: my-claw signs each node a client certificate at
 * pairing, and the operator's proxy checks it against this CA (docs/remote-nodes.md).
 *
 * The CA is generated on first use with the system's openssl, kept under $MY_CLAW_DIR/nodes/ca/,
 * and never leaves the machine. The certificate is a second gate, checked by the proxy; the
 * per-node token stays the revocable lock, so revocation needs no CRL.
 */

const CA_DIR = join(MY_CLAW_DIR, "nodes", "ca");
const CA_KEY = join(CA_DIR, "ca.key");
const CA_CRT = join(CA_DIR, "ca.crt");
const CERT_DAYS = 3650;

export interface IssuedCertificate {
  ca: string;
  cert: string;
  key: string;
}

async function openssl(args: string[]): Promise<string> {
  const proc = Bun.spawn(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`openssl ${args[0]} failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`);
  return stdout;
}

let caReady: Promise<void> | undefined;

/** Generated once, on first use, and shared by every pairing that follows. */
export function ensureNodeCa(): Promise<void> {
  if (!caReady) {
    caReady = (async () => {
      if (existsSync(CA_KEY) && existsSync(CA_CRT)) return;
      await mkdir(CA_DIR, { recursive: true, mode: 0o700 });
      try {
        await openssl([
          "req", "-x509", "-newkey", "ec",
          "-pkeyopt", "ec_paramgen_curve:prime256v1",
          "-nodes", "-keyout", CA_KEY, "-out", CA_CRT,
          "-days", String(CERT_DAYS), "-subj", "/CN=my-claw nodes CA",
        ]);
        await chmod(CA_KEY, 0o600);
        void log("info", "node CA generated", { path: CA_DIR });
      } catch (err) {
        // A half-written CA would be trusted forever: start over next time.
        await rm(CA_KEY, { force: true });
        await rm(CA_CRT, { force: true });
        caReady = undefined;
        throw err;
      }
    })();
  }
  return caReady;
}

/** One certificate per node, CN = its id. The proxy accepts any cert this CA signed. */
export async function issueNodeCertificate(nodeId: string): Promise<IssuedCertificate> {
  await ensureNodeCa();
  const scratch = await mkdtemp(join(tmpdir(), "my-claw-node-cert-"));
  try {
    const keyPath = join(scratch, "client.key");
    const csrPath = join(scratch, "client.csr");
    const crtPath = join(scratch, "client.crt");
    await openssl([
      "req", "-new", "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-keyout", keyPath, "-out", csrPath,
      "-subj", `/CN=${nodeId}`,
    ]);
    await openssl([
      "x509", "-req", "-in", csrPath, "-CA", CA_CRT, "-CAkey", CA_KEY,
      "-CAcreateserial", "-days", String(CERT_DAYS), "-out", crtPath,
    ]);
    const [ca, cert, key] = await Promise.all([
      readFile(CA_CRT, "utf-8"),
      readFile(crtPath, "utf-8"),
      readFile(keyPath, "utf-8"),
    ]);
    void log("info", "node certificate issued", { nodeId });
    return { ca, cert, key };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Module-level state, reset between test files. */
export function resetNodeCa(): void {
  caReady = undefined;
}
