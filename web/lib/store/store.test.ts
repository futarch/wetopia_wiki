// Durability regression suite: git + bundles + restore.
// Deterministic, no network, no API key:  node --experimental-strip-types store.test.ts
//
// The pre-build audit flagged restore-on-boot as "the most critical recovery
// path, never tested". This is that test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBundleStore } from "./bundleStore.ts";
import { WikiStore } from "./wikiStore.ts";

const results: [string, boolean, string?][] = [];
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-store-"));
const cellar = path.join(root, "cellar"); // stands in for object storage
const REPOS = ["shared", "users-albert"];

const newStore = (workDir: string, clock?: () => number) =>
  new WikiStore({
    workDir,
    store: new LocalBundleStore(cellar),
    keepBundles: 3,
    now: clock,
    seed: (repo, dir) => {
      fs.writeFileSync(path.join(dir, "index.md"), `# index ${repo}\n`);
      fs.writeFileSync(path.join(dir, "log.md"), `# journal ${repo}\n`);
    },
  });

const workA = path.join(root, "work-a");
let store = newStore(workA);

await t("open() crée les repos absents et les sème", async () => {
  const rep = await store.open(REPOS);
  assert.equal(rep.length, 2);
  assert.ok(rep.every((r) => r.source === "created"));
  assert.ok(fs.existsSync(path.join(workA, "shared", "index.md")));
});

await t("open() a déjà produit un bundle durable pour chaque repo", async () => {
  const s = new LocalBundleStore(cellar);
  for (const repo of REPOS) assert.equal((await s.list(repo)).length, 1, `bundle manquant : ${repo}`);
});

await t("write() persiste et crée un nouveau bundle (upload-avant-ACK)", async () => {
  const s = new LocalBundleStore(cellar);
  const before = (await s.list("shared")).length;
  await store.write("shared", "CRÉÉ /shared/people/rene.md", () => {
    fs.mkdirSync(path.join(workA, "shared", "people"), { recursive: true });
    fs.writeFileSync(path.join(workA, "shared", "people", "rene.md"), "# René\nmaraîcher\n");
  });
  // Once write() resolves, durability must ALREADY hold — that is the whole point.
  assert.equal((await s.list("shared")).length, before + 1);
});

await t("write() sans changement ne crée pas de bundle", async () => {
  const s = new LocalBundleStore(cellar);
  const before = (await s.list("shared")).length;
  await store.write("shared", "no-op", () => {});
  assert.equal((await s.list("shared")).length, before);
});

await t("CRASH: disque éphémère perdu → open() restaure tout le contenu", async () => {
  // Simulate exactly what Clever Cloud does on redeploy: the working disk is gone.
  fs.rmSync(workA, { recursive: true, force: true });
  assert.ok(!fs.existsSync(workA));

  const workB = path.join(root, "work-b"); // a brand-new container
  const revived = newStore(workB);
  const rep = await revived.open(REPOS);

  assert.ok(rep.every((r) => r.source === "restored"), "les repos devaient être restaurés");
  const page = path.join(workB, "shared", "people", "rene.md");
  assert.ok(fs.existsSync(page), "la page écrite avant le crash a disparu");
  assert.match(fs.readFileSync(page, "utf8"), /maraîcher/);
  store = revived;
});

await t("l'historique git survit à la restauration", async () => {
  const { git } = await import("./git.ts");
  const log = await git(path.join(root, "work-b", "shared"), ["log", "--oneline"]);
  assert.ok(log.split("\n").length >= 2, "l'historique devrait contenir seed + écriture");
  assert.match(log, /rene\.md/);
});

await t("écriture après restauration, puis re-restauration (cycle complet)", async () => {
  await store.write("users-albert", "CRÉÉ /users/albert/profile.md", () => {
    fs.writeFileSync(path.join(root, "work-b", "users-albert", "profile.md"), "# Albert\nnotes privées\n");
  });
  fs.rmSync(path.join(root, "work-b"), { recursive: true, force: true });
  const workC = path.join(root, "work-c");
  const third = newStore(workC);
  await third.open(REPOS);
  assert.match(fs.readFileSync(path.join(workC, "users-albert", "profile.md"), "utf8"), /notes privées/);
  assert.ok(fs.existsSync(path.join(workC, "shared", "people", "rene.md")), "le repo partagé doit survivre aussi");
  store = third;
});

await t("la file d'écriture sérialise les mutations concurrentes", async () => {
  const dir = path.join(root, "work-c", "shared");
  const order: number[] = [];
  let inFlight = 0;
  let overlapped = false;
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      store.write("shared", `écriture ${n}`, async () => {
        if (inFlight > 0) overlapped = true;
        inFlight++;
        await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(path.join(dir, `p${n}.md`), `page ${n}\n`);
        order.push(n);
        inFlight--;
      }),
    ),
  );
  assert.equal(overlapped, false, "deux écritures se sont chevauchées");
  assert.equal(order.length, 5);
  for (const n of [1, 2, 3, 4, 5]) assert.ok(fs.existsSync(path.join(dir, `p${n}.md`)));
});

await t("une écriture qui échoue ne bloque pas la file", async () => {
  await assert.rejects(store.write("shared", "boom", () => { throw new Error("boom"); }));
  await store.write("shared", "après échec", () => {
    fs.writeFileSync(path.join(root, "work-c", "shared", "apres.md"), "ok\n");
  });
  assert.ok(fs.existsSync(path.join(root, "work-c", "shared", "apres.md")));
});

await t("prune conserve les N bundles les plus récents", async () => {
  const s = new LocalBundleStore(cellar);
  const kept = await s.list("shared");
  assert.equal(kept.length, 3, `keepBundles=3, trouvé ${kept.length}`);
  // Newest first, and the newest still restores the latest content.
  assert.ok(kept[0].key > kept[1].key);
});

await t("restauration depuis le bundle conservé le plus récent = dernier contenu", async () => {
  fs.rmSync(path.join(root, "work-c"), { recursive: true, force: true });
  const workD = path.join(root, "work-d");
  await newStore(workD).open(REPOS);
  assert.ok(fs.existsSync(path.join(workD, "shared", "apres.md")), "le dernier commit doit être présent");
});

await t("nom de repo hostile rejeté", async () => {
  assert.throws(() => store.dirFor("../evasion"));
  assert.throws(() => store.dirFor("a/b"));
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} durability checks passed`);
process.exit(failed.length ? 1 : 0);
