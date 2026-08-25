// La charte déployée rejoint le bundle partagé. Déterministe : ni modèle, ni réseau.
//   node --experimental-strip-types lib/agent/charter.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, getWetopia, resetWetopia } from "./runtime.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SEED = path.resolve(HERE, "..", "..", "..", "seed");

const results: [string, boolean, string?][] = [];
const t = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-charte-"));
const dataRoot = path.join(root, "data");
const bundleDir = path.join(root, "bundles");
// Une copie de la graine, pour la faire évoluer sans toucher au dépôt.
const seedDir = path.join(root, "seed");
fs.cpSync(REAL_SEED, seedDir, { recursive: true });
const seedCharter = path.join(seedDir, "shared", "AGENTS.md");
const liveCharter = () => path.join(dataRoot, "shared", "AGENTS.md");
const liveLog = () => path.join(dataRoot, "shared", "log.md");
const deployLines = () =>
  fs
    .readFileSync(liveLog(), "utf8")
    .split("\n")
    .filter((l) => l.includes("[process:deploy]"));

const restart = async () => {
  resetWetopia();
  return boot({ dataRoot, bundleDir, users: [], seedDir, keepBundles: 5 });
};

// --- premier démarrage : le bundle naît de la graine ---
await restart();
await t("un wiki neuf reçoit la charte de la graine", () => {
  assert.equal(fs.readFileSync(liveCharter(), "utf8"), fs.readFileSync(seedCharter, "utf8"));
});
await t("rien à aligner, donc rien au journal", () => {
  assert.equal(deployLines().length, 0);
});

// --- la charte évolue dans le dépôt, le wiki tourne déjà ---
const RULE = "- Nouvelle règle de charte, ajoutée par le test.";
fs.appendFileSync(seedCharter, `\n${RULE}\n`);

await restart();
await t("un wiki déjà en service reçoit la charte déployée", () => {
  assert.match(fs.readFileSync(liveCharter(), "utf8"), /Nouvelle règle de charte/);
});
await t("l'agent reçoit la charte alignée, pas l'ancienne", () => {
  assert.match(getWetopia().charter, /Nouvelle règle de charte/);
});
await t("le changement est noté dans le journal partagé", () => {
  const lines = deployLines();
  assert.equal(lines.length, 1, `attendu 1 ligne, trouvé ${lines.length}`);
  assert.match(lines[0], /MAJ \/shared\/AGENTS\.md/);
  assert.match(lines[0], /^- \d{4}-\d\d-\d\dT\d\d:\d\dZ /, "format de date de la charte §9");
});

// --- rien n'a bougé : on ne réécrit pas, on ne rejournalise pas ---
await restart();
await t("un démarrage sans changement ne réécrit rien", () => {
  assert.equal(deployLines().length, 1);
});

// --- la charte alignée est durable, pas seulement sur le disque éphémère ---
await t("l'alignement a bien été versé dans un bundle", async () => {
  resetWetopia();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  await boot({ dataRoot, bundleDir, users: [], seedDir, keepBundles: 5 });
  assert.match(fs.readFileSync(liveCharter(), "utf8"), /Nouvelle règle de charte/);
  assert.equal(deployLines().length, 1, "la ligne de journal survit à la restauration");
});

// --- une graine sans charte reste une erreur de démarrage ---
// Effacer le fichier du disque ne prouverait rien : le démarrage restaure le
// bundle par-dessus. C'est un bundle né sans charte qu'il faut, donc un wiki
// neuf, sur sa propre graine.
await t("charte absente du bundle : le démarrage refuse", async () => {
  resetWetopia();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-sans-charte-"));
  fs.cpSync(seedDir, path.join(bare, "seed"), { recursive: true });
  fs.rmSync(path.join(bare, "seed", "shared", "AGENTS.md"));
  await assert.rejects(
    () =>
      boot({
        dataRoot: path.join(bare, "data"),
        bundleDir: path.join(bare, "bundles"),
        users: [],
        seedDir: path.join(bare, "seed"),
        keepBundles: 5,
      }),
    /charte absente/,
  );
  fs.rmSync(bare, { recursive: true, force: true });
});

for (const [name, pass, msg] of results) console.log(` ${pass ? "✓" : "✗"} ${name}${msg ? " — " + msg : ""}`);
const failed = results.filter(([, p]) => !p).length;
console.log(`\n${results.length - failed}/${results.length} charter checks passed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
