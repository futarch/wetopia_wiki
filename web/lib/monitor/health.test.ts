// Deterministic monitoring suite: no model, no network.
//   node --experimental-strip-types lib/monitor/health.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, getWetopia, resetWetopia } from "../agent/runtime.ts";
import { computeHealth, lastLintRun } from "./health.ts";
import { SHARED_REPO, userRepo } from "../wiki.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, "..", "..", "..", "seed");
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

// Control the environment so the config check is deterministic.
process.env.MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "test-key";
process.env.WETOPIA_CRON_SECRET = "test-cron-secret";
delete process.env.NODE_ENV_PROD_MARKER;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-health-"));
const dataRoot = path.join(root, "data");
const bundleDir = path.join(root, "bundles");
const sharedLog = () => path.join(dataRoot, "shared", "log.md");
const check = (h: Awaited<ReturnType<typeof computeHealth>>, name: string) =>
  h.checks.find((c) => c.name === name)!;

/** Append a lint heartbeat exactly as the real lint does: through the queue. */
const recordLintRun = async (stamp: string, findings: number) => {
  const rt2 = getWetopia();
  await rt2.store.mutate(SHARED_REPO, () => {
    fs.appendFileSync(sharedLog(), `- ${stamp} [process:lint] MAJ /shared/lint.md — ${findings} signalement(s)\n`);
    fs.writeFileSync(path.join(dataRoot, "shared", "lint.md"), `# Rapport\n\n${findings} signalement(s).\n`);
  });
  await rt2.store.flushDirty("lint");
};

// ---- pure parsing ----
await t("lit l'horodatage du dernier passage du lint dans le journal", () => {
  const f = path.join(root, "log-sample.md");
  fs.writeFileSync(
    f,
    "# Journal\n- 2026-08-20T10:00Z [human:albert] CRÉÉ /shared/x.md — ...\n" +
      "- 2026-08-23T03:00Z [process:lint] MAJ /shared/lint.md — 2 signalement(s)\n" +
      "- 2026-08-24T03:00Z [process:lint] MAJ /shared/lint.md — 5 signalement(s)\n",
  );
  const last = lastLintRun(f);
  assert.ok(last, "aucun passage trouvé");
  assert.equal(last!.at.toISOString(), "2026-08-24T03:00:00.000Z", "doit prendre le DERNIER passage");
});

await t("journal sans passage de lint → null", () => {
  const f = path.join(root, "log-empty.md");
  fs.writeFileSync(f, "# Journal\n- 2026-08-20T10:00Z [human:albert] CRÉÉ /shared/x.md\n");
  assert.equal(lastLintRun(f), null);
  assert.equal(lastLintRun(path.join(root, "inexistant.md")), null);
});

// ---- health without a booted wiki ----
await t("wiki non démarré → status down", async () => {
  resetWetopia();
  const h = await computeHealth();
  assert.equal(h.status, "down");
  assert.equal(check(h, "boot").level, "down");
});

// ---- booted wiki ----
resetWetopia();
await boot({ dataRoot, bundleDir, users: [USER], seedDir: SEED, keepBundles: 5 });
const rt = getWetopia();

await t("après démarrage : bundles créés et durables", async () => {
  const h = await computeHealth();
  assert.equal(check(h, "boot").level, "ok");
  assert.equal(check(h, "bundles").level, "ok", JSON.stringify(check(h, "bundles")));
  assert.equal(check(h, "durabilite").level, "ok");
});

await t("lint jamais exécuté → avertissement (et pas « tout va bien »)", async () => {
  const h = await computeHealth();
  const lint = check(h, "lint");
  assert.equal(lint.level, "warn");
  assert.match(String(lint.detail), /jamais tourné/);
  assert.equal(h.status, "warn", "le statut global doit refléter l'avertissement");
});

await t("passage de lint récent → ok", async () => {
  const stamp = new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 16) + "Z";
  await recordLintRun(stamp, 3);
  const h = await computeHealth();
  const lint = check(h, "lint");
  assert.equal(lint.level, "ok", JSON.stringify(lint));
  assert.equal(lint.findings, 3, "le nombre de signalements doit remonter");
});

await t("cron mort : dernier passage trop ancien → avertissement explicite", async () => {
  const old = new Date(Date.now() - 90 * 3_600_000).toISOString().slice(0, 16) + "Z";
  await recordLintRun(old, 0);
  // The heartbeat is the LAST line, so this stale entry now governs.
  const h = await computeHealth();
  const lint = check(h, "lint");
  assert.equal(lint.level, "warn");
  assert.match(String(lint.detail), /ne tourne plus/);
});

await t("le battement de cœur survit à un redémarrage du processus", async () => {
  // Simulate a restart: drop the runtime, reboot from the bundles, and check
  // the lint status is still known — it lives in the wiki, not in memory.
  const before = check(await computeHealth(), "lint").lastRunAt;
  assert.ok(before, "un passage doit avoir été enregistré avant le test");
  resetWetopia();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  await boot({ dataRoot, bundleDir, users: [USER], seedDir: SEED, keepBundles: 5 });
  const after = check(await computeHealth(), "lint").lastRunAt;
  assert.equal(after, before, "l'horodatage du lint doit survivre au redémarrage");
});

await t("écritures en attente signalées", async () => {
  const rt2 = getWetopia();
  await rt2.store.mutate(SHARED_REPO, () => {
    fs.writeFileSync(path.join(dataRoot, "shared", "brouillon.md"), "en attente\n");
  });
  const h = await computeHealth();
  assert.equal(check(h, "durabilite").level, "warn");
  assert.match(String(check(h, "durabilite").detail), /non encore sauvegardée/);
  await rt2.store.flushDirty("écriture");
  assert.equal(check(await computeHealth(), "durabilite").level, "ok");
});

await t("échec de sauvegarde → status down et message d'erreur remonté", async () => {
  const rt2 = getWetopia();
  const store: any = rt2.store;
  const real = store.store.put.bind(store.store);
  store.store.put = async () => {
    throw new Error("Cellar injoignable");
  };
  await rt2.store
    .write(SHARED_REPO, "écriture qui échoue", () => {
      fs.writeFileSync(path.join(dataRoot, "shared", "panne.md"), "x\n");
    })
    .catch(() => {});
  const h = await computeHealth();
  assert.equal(h.status, "down");
  assert.match(String(check(h, "durabilite").detail), /Cellar injoignable/);
  store.store.put = real;
});

await t("configuration incomplète signalée", async () => {
  delete process.env.WETOPIA_CRON_SECRET;
  const h = await computeHealth();
  assert.equal(check(h, "configuration").level, "warn");
  assert.match(String(check(h, "configuration").detail), /WETOPIA_CRON_SECRET/);
  process.env.WETOPIA_CRON_SECRET = "test-cron-secret";
});

await t("un bundle privé sans copie durable → down", async () => {
  const repo = userRepo(USER);
  const dir = path.join(bundleDir, repo);
  const stash = path.join(root, "stash");
  fs.renameSync(dir, stash);
  const h = await computeHealth();
  assert.equal(check(h, "bundles").level, "down");
  assert.equal(h.status, "down");
  fs.renameSync(stash, dir);
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} monitoring checks passed`);
process.exit(failed.length ? 1 : 0);
