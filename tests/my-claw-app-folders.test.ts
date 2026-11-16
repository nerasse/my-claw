import { test, describe, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore, FOLDER_NAME_LIMIT, MAX_FOLDERS } from "../src/channels/my-claw-app/folders.ts";

const OWNER = "neras";
const OTHER = "quelqu-un";

let path: string;
let store: FolderStore;

beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), "folders-")), "folders.json");
  store = new FolderStore(path);
});

/** The names in rank order, which is what the drawer draws. */
async function names(owner = OWNER): Promise<string[]> {
  return (await store.list(owner)).map((folder) => folder.name);
}

describe("FolderStore", () => {
  test("a folder lands at the end, on a dense rank", async () => {
    await store.create(OWNER, "CubeFlow");
    await store.create(OWNER, "Carrière");

    assert.deepEqual(await names(), ["CubeFlow", "Carrière"]);
    assert.deepEqual(
      (await store.list(OWNER)).map((folder) => folder.rank),
      [0, 1],
    );
  });

  test("the folder's own id is stable and its name is what was typed, trimmed", async () => {
    const folder = await store.create(OWNER, "  CubeFlow  ");

    assert.equal(folder.name, "CubeFlow");
    assert.ok(folder.id.length > 0);
    await store.rename(OWNER, folder.id, "CubeFlow Desk");
    assert.deepEqual(await names(), ["CubeFlow Desk"]);
    assert.equal((await store.list(OWNER))[0]?.id, folder.id);
  });

  test("two folders the owner cannot tell apart are refused, case included", async () => {
    await store.create(OWNER, "CubeFlow");

    await assert.rejects(() => store.create(OWNER, "cubeflow"), /already exists/);
    await assert.rejects(() => store.create(OWNER, "  CUBEFLOW "), /already exists/);
    assert.deepEqual(await names(), ["CubeFlow"]);
  });

  test("renaming onto another folder's name is refused, but keeping its own is not", async () => {
    const first = await store.create(OWNER, "CubeFlow");
    const second = await store.create(OWNER, "Carrière");

    await assert.rejects(() => store.rename(OWNER, second.id, "cubeflow"), /already exists/);
    await store.rename(OWNER, first.id, "CubeFlow");
    assert.deepEqual(await names(), ["CubeFlow", "Carrière"]);
  });

  test("an empty name and one over the limit are refused, nothing is written", async () => {
    await assert.rejects(() => store.create(OWNER, "   "), /needs a name/);
    await assert.rejects(() => store.create(OWNER, "x".repeat(FOLDER_NAME_LIMIT + 1)), /stop at/);

    assert.deepEqual(await names(), []);
  });

  // 200 folders means 200 awaited atomic writes, each one a write plus a rename: on a busy disk that
  // is past the default five seconds, and a timed-out test leaves its loop writing into the next
  // test's store. The timeout is the thing to raise, not the number of folders.
  test("the store refuses more folders than a person can read", async () => {
    for (let index = 0; index < MAX_FOLDERS; index += 1) await store.create(OWNER, `folder ${index}`);

    await assert.rejects(() => store.create(OWNER, "one too many"), /at most/);
    assert.equal((await store.list(OWNER)).length, MAX_FOLDERS);
  }, 60_000);

  test("the folders of one owner are not the folders of another", async () => {
    await store.create(OWNER, "CubeFlow");

    assert.deepEqual(await names(OTHER), []);
  });

  test("removing a folder leaves no hole in the ranks", async () => {
    await store.create(OWNER, "CubeFlow");
    const middle = await store.create(OWNER, "Carrière");
    await store.create(OWNER, "Perso");

    assert.equal(await store.remove(OWNER, middle.id), true);
    assert.deepEqual(await names(), ["CubeFlow", "Perso"]);
    assert.deepEqual(
      (await store.list(OWNER)).map((folder) => folder.rank),
      [0, 1],
    );
    // And the hole is not handed to the next folder either.
    await store.create(OWNER, "Infra");
    assert.deepEqual(
      (await store.list(OWNER)).map((folder) => folder.rank),
      [0, 1, 2],
    );
  });

  test("removing a folder that is not there answers so instead of throwing", async () => {
    assert.equal(await store.remove(OWNER, "jamais-cree"), false);
  });

  test("a reorder moves the ids it names and leaves the others where they were, after them", async () => {
    await store.create(OWNER, "CubeFlow");
    await store.create(OWNER, "Carrière");
    const third = await store.create(OWNER, "Perso");

    // The device dragged a list it had loaded before Perso existed for it.
    await store.reorder(OWNER, [third.id, (await store.list(OWNER))[0]!.id]);
    assert.deepEqual(await names(), ["Perso", "CubeFlow", "Carrière"]);

    await store.reorder(OWNER, ["inconnu", third.id]);
    assert.deepEqual(await names(), ["Perso", "CubeFlow", "Carrière"]);
  });

  test("what was written is what is read back, and an unreadable file is an empty store", async () => {
    const first = await store.create(OWNER, "CubeFlow", "cf");
    await store.create(OWNER, "Carrière");

    const reopened = new FolderStore(path);
    const folders = await reopened.list(OWNER);
    assert.deepEqual(folders.map((folder) => folder.name), ["CubeFlow", "Carrière"]);
    assert.equal(folders[0]?.id, first.id);
    assert.equal(folders[0]?.workspace, "cf");
    assert.equal(folders[1]?.workspace, undefined);

    await writeFile(path, "{ pas du json", "utf-8");
    const after = new FolderStore(path);
    assert.deepEqual(await after.list(OWNER), []);
  });

  test("a workspace is kept on the folder that was born in it, and only there", async () => {
    await store.create(OWNER, "CubeFlow", "cf");
    await store.create(OWNER, "Sans workspace");

    const raw = JSON.parse(await readFile(path, "utf-8")) as { owners: Record<string, unknown[]> };
    assert.equal(raw.owners[OWNER]?.length, 2);
    assert.deepEqual(await names(), ["CubeFlow", "Sans workspace"]);
  });
});
