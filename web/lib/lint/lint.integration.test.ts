// The nightly lint against a real booted wiki: real bundles, real write queue,
// real durability — and the model pass for contradictions.
//
//   MISTRAL_API_KEY=... node --experimental-strip-types lib/lint/lint.integration.test.ts
//   (add --no-model to skip the one non-deterministic check)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBundleStore } from "../store/bundleStore.ts";
import { boot, getWetopia, resetWetopia } from "../agent/runtime.ts";
import { runLint } from "./run.ts";
import { SHARED_REPO, userRepo } from "../wiki.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, "..", "..", "..", "seed");
const withModel = !process.argv.includes("--no-model");
const USER = "albert";

const results: [string, boolean, string?][] = [];
const t = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-lintrun-"));
const dataRoot = path.join(root, "data");
const bundleDir = path.join(root, "bundles");

resetWetopia();
await boot({ dataRoot, bundleDir, users: [USER], seedDir: SEED, keepBundles: 5 });
const { store } = getWetopia();

// Seed content the way the agent does: through the queue, then flushed.
const write = (rel: string, text: string) => {
  const abs = path.join(dataRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

await store.mutate(SHARED_REPO, () => {
  write(
    "shared/events/fete-des-recoltes.md",
    `---\ntype: Event\ntitle: "Fête des récoltes"\ndescription: "Fête annuelle au jardin des Balmes."\nwhen: 2026-09-20\ntags: [jardin, Fete]\n---\n\nLa fête aura lieu le **20 septembre 2026** au [jardin des Balmes](/shared/places/jardin-des-balmes.md).\n`,
  );
  write(
    "shared/places/jardin-des-balmes.md",
    `---\ntype: Place\ntitle: "Jardin partagé des Balmes"\ndescription: "Jardin du quartier des Balmes à Lyon."\nstale_after: 2026-08-01\ntags: [jardin, fete]\n---\n\nLe jardin accueille la fête des récoltes, qui se tiendra cette année le **4 octobre 2026**.\nVoir aussi [le compost](/shared/projects/compost.md).\n`,
  );
  write(
    "shared/tasks/broyeur.md",
    `---\ntype: Task\ntitle: "Trouver un broyeur"\ndescription: "Avant les tailles d'automne."\ntask: { state: open, owner: "human:albert", due: 2026-01-05 }\n---\n\nPour le compost.\n`,
  );
});
await store.mutate(userRepo(USER), () => {
  write(
    `users/${USER}/jardin.md`,
    `---\ntype: Place\ntitle: "Jardin partagé des Balmes"\ndescription: "Ma copie privée de la page du jardin."\n---\n\nCopie.\n`,
  );
});
await store.flushDirty("fixture");

const now = new Date("2026-08-24T03:00:00Z");
const reports = await runLint({ users: [USER], withModel, now });
const shared = reports.find((r) => r.bundle === "/shared")!;
const priv = reports.find((r) => r.bundle === `/users/${USER}`)!;
const kinds = (r: typeof shared, k: string) => r.findings.filter((f) => f.kind === k);

await t("le lint couvre le bundle partagé et chaque bundle privé", () => {
  assert.equal(reports.length, 2);
});

await t("anomalies déterministes détectées sur le wiki réel", () => {
  assert.equal(kinds(shared, "stale").length, 1, "page périmée");
  assert.equal(kinds(shared, "task-overdue").length, 1, "tâche en retard");
  assert.equal(kinds(shared, "tag-drift").length, 1, "tags Fete/fete");
  assert.ok(kinds(shared, "gap").some((f) => f.path.endsWith("compost.md")), "lacune compost");
});

await t("index réparé : les nouvelles pages y sont ajoutées", () => {
  assert.ok(shared.indexAdded.length >= 3, JSON.stringify(shared.indexAdded));
  const index = fs.readFileSync(path.join(dataRoot, "shared", "index.md"), "utf8");
  assert.match(index, /fete-des-recoltes\.md/);
  assert.match(index, /# Index — wiki partagé/, "l'en-tête du seed doit survivre");
});

await t("rapport écrit dans le bundle et journal mis à jour", () => {
  const report = fs.readFileSync(path.join(dataRoot, "shared", "lint.md"), "utf8");
  assert.match(report, /Rapport du lint/);
  assert.match(report, /Pages périmées/);
  assert.match(fs.readFileSync(path.join(dataRoot, "shared", "log.md"), "utf8"), /\[process:lint\]/);
});

await t("le rapport privé reste dans le bundle privé", () => {
  assert.equal(kinds(priv, "duplicate-of-shared").length, 1, "recouvrement privé/partagé");
  const sharedReport = fs.readFileSync(path.join(dataRoot, "shared", "lint.md"), "utf8");
  assert.ok(!/jardin\.md/.test(sharedReport), "une page privée ne doit jamais apparaître dans /shared");
  assert.ok(!/users\//.test(sharedReport), "aucun chemin privé dans le rapport partagé");
  const privReport = fs.readFileSync(path.join(dataRoot, "users", USER, "lint.md"), "utf8");
  assert.match(privReport, /jardin\.md/);
});

await t("le lint ne supprime aucune page (§12)", () => {
  for (const rel of ["shared/events/fete-des-recoltes.md", "shared/places/jardin-des-balmes.md", `users/${USER}/jardin.md`]) {
    assert.ok(fs.existsSync(path.join(dataRoot, rel)), `${rel} a disparu`);
  }
});

await t("le travail du lint est rendu durable (nouveaux bundles)", async () => {
  const s = new LocalBundleStore(bundleDir);
  assert.ok((await s.list(SHARED_REPO)).length >= 2);
  assert.ok((await s.list(userRepo(USER))).length >= 2);
});

await t("deuxième passe idempotente sur l'index", async () => {
  const again = await runLint({ users: [USER], withModel: false, now });
  const s = again.find((r) => r.bundle === "/shared")!;
  assert.deepEqual(s.indexAdded, []);
  assert.deepEqual(s.indexRemoved, []);
});

if (withModel) {
  await t("contradiction de dates détectée par le passage modèle", () => {
    const c = kinds(shared, "contradiction");
    assert.ok(c.length >= 1, "aucune contradiction détectée");
    assert.match(
      c.map((x) => x.detail).join(" "),
      /septembre|octobre|20|4/i,
      `détail inattendu : ${JSON.stringify(c)}`,
    );
  });
  await t("aucune erreur du passage modèle", () => {
    assert.equal(shared.modelError ?? "", "");
  });
}

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} lint-run checks passed`);
process.exit(failed.length ? 1 : 0);
