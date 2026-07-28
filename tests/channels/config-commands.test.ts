import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MY_CLAW_DIR, CONFIG_PATH } from "../../src/core/config.ts";
import { snapshot, confirm, history } from "../../src/core/config-store.ts";
import { handleConfigCommand } from "../../src/channels/config-commands.ts";

const storeRoot = join(MY_CLAW_DIR, "backups");
const ws = join(MY_CLAW_DIR, "workspace");
const V1 = JSON.stringify({ llm: { defaultModel: "un" }, voice: { mode: "auto" }, channels: {} }, null, 2);

type ApplyReload = () => Promise<{ changed: string[]; rebootRequired: string[] }>;

async function dm(args: string, applyReload?: ApplyReload): Promise<string> {
  return handleConfigCommand({ args, isDm: true, workspaceDir: ws, applyReload });
}

beforeEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await mkdir(ws, { recursive: true });
  await writeFile(CONFIG_PATH, V1);
});

afterEach(async () => {
  await rm(storeRoot, { recursive: true, force: true });
  await rm(CONFIG_PATH, { force: true });
});

describe("/config history", () => {
  test("lists nothing before any snapshot", async () => {
    expect(await dm("history")).toContain("Aucune sauvegarde");
  });

  test("lists artifacts and marks the confirmed version", async () => {
    await snapshot(CONFIG_PATH, { origin: "boot" });
    // The list view flags an artifact with no confirmed version; the detail view marks the entry.
    expect(await dm("history")).toContain("config.json");
    expect(await dm("history")).toContain("aucune confirmée");
    expect(await dm("history config.json")).not.toContain("confirmée");

    await confirm(CONFIG_PATH);
    expect(await dm("history")).not.toContain("aucune confirmée");
    expect(await dm("history config.json")).toContain("confirmée");
  });

  test("an unknown artifact is named, not silently empty", async () => {
    expect(await dm("history nope.json")).toContain("Artefact inconnu");
  });

  test("hides .env outside a DM", async () => {
    await writeFile(join(MY_CLAW_DIR, ".env"), "TOKEN=secret\n", { mode: 0o600 });
    await snapshot(join(MY_CLAW_DIR, ".env"), { origin: "boot" });
    const inGroup = await handleConfigCommand({ args: "history .env", isDm: false, workspaceDir: ws });
    expect(inGroup).toContain("message privé");
  });
});

describe("/config diff", () => {
  test("reports an identical file", async () => {
    await snapshot(CONFIG_PATH, { origin: "boot" });
    expect(await dm("diff config.json")).toContain("Identique");
  });

  test("shows added and removed lines", async () => {
    await snapshot(CONFIG_PATH, { origin: "boot" });
    await writeFile(CONFIG_PATH, JSON.stringify({ llm: { defaultModel: "deux" }, channels: {} }, null, 2));
    const out = await dm("diff config.json");
    expect(out).toContain('- ');
    expect(out).toContain("deux");
  });

  test("never prints .env values, only key changes", async () => {
    const env = join(MY_CLAW_DIR, ".env");
    await writeFile(env, "TOKEN=tres-secret\nKEEP=1\n", { mode: 0o600 });
    await snapshot(env, { origin: "boot" });
    await writeFile(env, "TOKEN=autre-secret\nNEW=2\n", { mode: 0o600 });

    const out = await dm("diff .env");
    expect(out).not.toContain("tres-secret");
    expect(out).not.toContain("autre-secret");
    expect(out).toContain("~ TOKEN (valeur modifiée)");
    expect(out).toContain("+ NEW (ajoutée)");
    expect(out).toContain("- KEEP (supprimée)");
  });
});

describe("/config rollback", () => {
  test("is refused outside a DM", async () => {
    const out = await handleConfigCommand({ args: "rollback config.json ref", isDm: false, workspaceDir: ws });
    expect(out).toContain("message privé");
  });

  test("restores the whole file and reports what the reload applied", async () => {
    const ref = await snapshot(CONFIG_PATH, { origin: "boot" });
    await writeFile(CONFIG_PATH, JSON.stringify({ llm: { defaultModel: "casse" }, channels: {} }));

    let reloaded = false;
    const out = await dm(`rollback config.json ${ref}`, () => {
      reloaded = true;
      return Promise.resolve({ changed: ["llm"], rebootRequired: [] });
    });

    expect(reloaded).toBe(true);
    expect(out).toContain("restauré");
    expect(out).toContain("Appliqué à chaud : llm");
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe(V1);
  });

  test("says a restart is needed instead of claiming it is live", async () => {
    const ref = await snapshot(CONFIG_PATH, { origin: "boot" });
    await writeFile(CONFIG_PATH, JSON.stringify({ llm: {}, channels: { matrix: { homeserver: "x" } } }));
    const out = await dm(`rollback config.json ${ref}`, () =>
      Promise.resolve({ changed: [], rebootRequired: ["channels.matrix"] }),
    );
    expect(out).toContain("Redémarrage requis pour : channels.matrix");
  });

  test("keeps the overwritten state so the rollback is undoable", async () => {
    const ref = await snapshot(CONFIG_PATH, { origin: "boot" });
    await writeFile(CONFIG_PATH, JSON.stringify({ llm: { defaultModel: "intermediaire" }, channels: {} }));
    await dm(`rollback config.json ${ref}`);
    const entries = await history(CONFIG_PATH);
    expect(entries.length).toBe(2);
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe(V1);
  });

  test("a section rollback touches only that section", async () => {
    const ref = await snapshot(CONFIG_PATH, { origin: "boot" });
    await writeFile(
      CONFIG_PATH,
      JSON.stringify({ llm: { defaultModel: "deux" }, voice: { mode: "cloud" }, channels: {} }, null, 2),
    );

    const out = await dm(`rollback config.json ${ref} llm`);
    expect(out).toContain("section `llm`");
    const after = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as {
      llm: { defaultModel: string };
      voice: { mode: string };
    };
    expect(after.llm.defaultModel).toBe("un");
    expect(after.voice.mode).toBe("cloud");
  });

  test("an unknown section is refused with the list of valid ones", async () => {
    const ref = await snapshot(CONFIG_PATH, { origin: "boot" });
    const out = await dm(`rollback config.json ${ref} lmm`);
    expect(out).toContain("Section inconnue");
    expect(out).toContain("llm");
  });

  test("a section rollback is refused on a non-config artifact", async () => {
    const soul = join(ws, "SOUL.md");
    await writeFile(soul, "moi");
    const ref = await snapshot(soul, { origin: "boot" });
    expect(await dm(`rollback SOUL.md ${ref} llm`)).toContain("ne s'applique qu'à config.json");
  });

  test("an unknown ref fails without touching the file", async () => {
    await snapshot(CONFIG_PATH, { origin: "boot" });
    const out = await dm("rollback config.json 20260101-000000000-aaaaaaaaaaaa");
    expect(out).toContain("Rollback refusé");
    expect(await readFile(CONFIG_PATH, "utf-8")).toBe(V1);
  });
});

describe("usage", () => {
  test("an unknown subcommand returns the usage", async () => {
    expect(await dm("wat")).toContain("/config history");
  });
});
