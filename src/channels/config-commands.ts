import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { CONFIG_PATH, HOT_OBJECT_SECTIONS, HOT_ARRAY_SECTIONS } from "../core/config.ts";
import { history, readSnapshot, restore, protectedPaths, artifactId } from "../core/config-store.ts";

// Shared handler for `/config` on every channel. The channel passes `applyReload` so a restore is
// applied by the same code path as an editor save: relying on the watcher would silently apply
// nothing when the restored file is a dotfile the watcher never sees recreated.
export interface ConfigCommandParams {
  args: string;
  isDm: boolean;
  workspaceDir: string;
  applyReload?: () => Promise<{ changed: string[]; rebootRequired: string[] }> | void;
}

const DM_ONLY = "Cette commande n'est disponible qu'en message privé avec le bot.";
const USAGE = [
  "Usage :",
  "- `/config history [artefact]`",
  "- `/config diff <artefact> [ref]`",
  "- `/config rollback <artefact> <ref> [section]`",
].join("\n");

/** `.env` holds secrets: its values never reach a channel, and it is DM-only even to list. */
function isSecret(path: string): boolean {
  return basename(path) === ".env";
}

/** Accepts the artifact id, the file name, or a full path. */
async function resolveArtifact(token: string, workspaceDir: string): Promise<string | null> {
  const paths = await protectedPaths(workspaceDir);
  const needle = token.toLowerCase();
  return (
    paths.find((p) => p === token) ??
    paths.find((p) => artifactId(p).toLowerCase() === needle) ??
    paths.find((p) => basename(p).toLowerCase() === needle) ??
    paths.find((p) => artifactId(p).toLowerCase().includes(needle)) ??
    null
  );
}

function ago(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

export async function handleConfigCommand(p: ConfigCommandParams): Promise<string> {
  const parts = p.args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "history").toLowerCase();
  if (sub === "history") return listHistory(parts[1], p);
  if (sub === "diff") return showDiff(parts[1], parts[2], p);
  if (sub === "rollback") return rollback(parts[1], parts[2], parts[3], p);
  return USAGE;
}

async function listHistory(token: string | undefined, p: ConfigCommandParams): Promise<string> {
  if (!token) {
    const lines: string[] = [];
    for (const path of await protectedPaths(p.workspaceDir)) {
      if (isSecret(path) && !p.isDm) continue;
      const entries = await history(path);
      if (entries.length === 0) continue;
      const newest = entries.at(-1)!;
      const conf = entries.find((e) => e.confirmed);
      lines.push(
        `- \`${artifactId(path)}\` : ${entries.length} version(s), dernière ${ago(newest.ts)}` +
          (conf ? "" : " (aucune confirmée)"),
      );
    }
    return lines.length > 0
      ? ["Sauvegardes de config :", ...lines, "", "Détail : `/config history <artefact>`"].join("\n")
      : "Aucune sauvegarde pour l'instant.";
  }

  const path = await resolveArtifact(token, p.workspaceDir);
  if (!path) return `Artefact inconnu : "${token}". Liste : \`/config history\``;
  if (isSecret(path) && !p.isDm) return DM_ONLY;
  const entries = await history(path);
  if (entries.length === 0) return `Aucune sauvegarde pour \`${artifactId(path)}\`.`;
  const lines = entries
    .slice()
    .reverse()
    .map((e) => `- \`${e.ref}\` ${ago(e.ts)}, ${e.size} o${e.confirmed ? " — confirmée" : ""}`);
  return [`Sauvegardes de \`${artifactId(path)}\` :`, ...lines].join("\n");
}

async function showDiff(
  token: string | undefined,
  ref: string | undefined,
  p: ConfigCommandParams,
): Promise<string> {
  if (!token) return USAGE;
  const path = await resolveArtifact(token, p.workspaceDir);
  if (!path) return `Artefact inconnu : "${token}".`;
  if (isSecret(path) && !p.isDm) return DM_ONLY;

  const entries = await history(path);
  const target = ref ?? entries.at(-1)?.ref;
  if (!target) return `Aucune sauvegarde pour \`${artifactId(path)}\`.`;
  const snap = await readSnapshot(path, target);
  if (snap === null) return `Snapshot \`${target}\` introuvable.`;
  const current = await readFile(path, "utf-8").catch(() => "");
  if (snap === current) return `Identique à \`${target}\`.`;

  const lines = isSecret(path) ? diffEnvKeys(snap, current) : diffLines(snap, current);
  const head = `Diff \`${artifactId(path)}\` (snapshot \`${target}\` -> fichier actuel) :`;
  const shown = lines.slice(0, 40);
  const more = lines.length > shown.length ? [`... ${lines.length - shown.length} ligne(s) de plus`] : [];
  return [head, "```", ...shown, ...more, "```"].join("\n");
}

/** Key-level only: which keys appeared, disappeared or changed. Values stay out of the channel. */
function diffEnvKeys(snap: string, current: string): string[] {
  const keys = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trimStart().startsWith("#")) out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
    }
    return out;
  };
  const a = keys(snap);
  const b = keys(current);
  const out: string[] = [];
  for (const k of a.keys()) if (!b.has(k)) out.push(`- ${k} (supprimée)`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`+ ${k} (ajoutée)`);
  for (const [k, v] of a) if (b.has(k) && b.get(k) !== v) out.push(`~ ${k} (valeur modifiée)`);
  return out.length > 0 ? out : ["(aucun changement de clé)"];
}

/** Line-level presence diff. Enough to see what moved without pulling in a diff dependency. */
function diffLines(snap: string, current: string): string[] {
  const a = snap.split("\n");
  const b = current.split("\n");
  const out: string[] = [];
  const bSet = new Map<string, number>();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  const aSet = new Map<string, number>();
  for (const l of a) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  for (const [l, n] of aSet) {
    const kept = bSet.get(l) ?? 0;
    for (let i = 0; i < n - kept; i++) out.push(`- ${l}`);
  }
  for (const [l, n] of bSet) {
    const had = aSet.get(l) ?? 0;
    for (let i = 0; i < n - had; i++) out.push(`+ ${l}`);
  }
  return out;
}

const SECTIONS = new Set<string>([...HOT_OBJECT_SECTIONS, ...HOT_ARRAY_SECTIONS, "channels", "workspace"]);

async function rollback(
  token: string | undefined,
  ref: string | undefined,
  section: string | undefined,
  p: ConfigCommandParams,
): Promise<string> {
  if (!p.isDm) return DM_ONLY;
  if (!token || !ref) return USAGE;
  const path = await resolveArtifact(token, p.workspaceDir);
  if (!path) return `Artefact inconnu : "${token}".`;

  let merge: ((snap: string, current: string) => string) | undefined;
  if (section) {
    if (path !== CONFIG_PATH) return "L'argument `section` ne s'applique qu'à config.json.";
    if (!SECTIONS.has(section)) {
      return `Section inconnue : "${section}". Attendu : ${[...SECTIONS].join(", ")}`;
    }
    // Take one subtree from the snapshot and leave every later edit to the others in place.
    merge = (snap, current) => {
      const from = JSON.parse(snap) as Record<string, unknown>;
      const into = JSON.parse(current) as Record<string, unknown>;
      if (section in from) into[section] = from[section];
      else delete into[section];
      return `${JSON.stringify(into, null, 2)}\n`;
    };
  }

  const res = await restore(path, ref, merge);
  if (!res.ok) return `Rollback refusé : ${res.error}`;

  const applied = await p.applyReload?.();
  const scope = section ? ` (section \`${section}\`)` : "";
  const lines = [`\`${artifactId(path)}\` restauré depuis \`${ref}\`${scope}, ${res.bytes} o écrits.`];
  if (applied && typeof applied === "object") {
    if (applied.changed.length > 0) lines.push(`Appliqué à chaud : ${applied.changed.join(", ")}.`);
    if (applied.rebootRequired.length > 0) {
      lines.push(`Redémarrage requis pour : ${applied.rebootRequired.join(", ")}.`);
    }
    if (applied.changed.length === 0 && applied.rebootRequired.length === 0) {
      lines.push("Aucun changement de section détecté.");
    }
  }
  lines.push("L'état précédent est sauvegardé : `/config history` pour l'annuler.");
  return lines.join("\n");
}

/** For the CLI: no channel, so no DM restriction, and no watcher to apply a restore through. */
export async function configCommandCli(args: string[], workspaceDir: string): Promise<string> {
  return handleConfigCommand({ args: args.join(" "), isDm: true, workspaceDir });
}
