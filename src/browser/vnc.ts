import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";

/** x11vnc's password file, read back.
 *
 *  The file is not a hash: `vncpasswd` DES-encrypts the password under a key that is a constant
 *  of the protocol, so the value is recoverable and the file stays the single place the password
 *  lives. Copying it into config.json instead would put a secret in a hot-reloaded file and leave
 *  two versions to drift apart the first time it is rotated.
 *
 *  Both this and the VNC handshake feed DES key bytes in reversed bit order, a quirk of the
 *  original implementation that every VNC client reproduces. Node exposes no single-DES cipher
 *  under that name reliably, so it is expressed as TripleDES with three identical subkeys, which
 *  is the same permutation. */
const OBFUSCATION_KEY = [23, 82, 107, 6, 35, 78, 88, 7];

function reverseBits(byte: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) out |= ((byte >> i) & 1) << (7 - i);
  return out;
}

export function decodeVncPassword(blob: Buffer): string {
  if (blob.length < 8) throw new Error("VNC password file is shorter than one DES block");
  const key = Buffer.from(OBFUSCATION_KEY.map(reverseBits));
  const decipher = createDecipheriv("des-ede3", Buffer.concat([key, key, key]), null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(blob.subarray(0, 8)), decipher.final()]);
  // VNC keeps exactly 8 bytes and pads with NULs, so a shorter password comes back padded.
  const end = plain.indexOf(0);
  return plain.subarray(0, end === -1 ? 8 : end).toString("latin1");
}

/** The password, or null when the file is missing or unreadable. Absence is not an error: a
 *  deployment may run x11vnc without one, and the page has to say so rather than fail to load. */
export async function readVncPassword(path: string): Promise<string | null> {
  let blob: Buffer;
  try {
    blob = await readFile(path);
  } catch {
    return null;
  }
  try {
    const password = decodeVncPassword(blob);
    return /^[\x20-\x7e]+$/.test(password) ? password : null;
  } catch {
    return null;
  }
}
