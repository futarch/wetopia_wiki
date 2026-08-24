// The Cellar driver, exercised over real HTTP against a minimal S3-compatible
// server: real signing, real XML, real pagination.
//
//   node --experimental-strip-types lib/store/s3.test.ts
//
// What this cannot cover: Cellar accepting our credentials. Everything that is
// our code's responsibility — protocol shape, ordering, pagination, atomic
// download, prune arithmetic, and the full write/crash/restore cycle — is here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBundleStore, bundleKey } from "./bundleStore.ts";
import { S3BundleStore, s3StoreFromEnv } from "./s3BundleStore.ts";
import { WikiStore } from "./wikiStore.ts";
// @ts-ignore — plain JS test helper
import { startS3Mock } from "./s3mock.mjs";

const results: [string, boolean, string?][] = [];
const t = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-s3-"));
const mock = await startS3Mock({ bucket: "wetopia", pageSize: 2 });
const store = new S3BundleStore({
  bucket: mock.bucket,
  endpoint: mock.endpoint,
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
});

const file = (name: string, content: string) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, content);
  return p;
};

await t("check() : bucket joignable", async () => {
  await store.check();
  assert.ok(mock.calls.head > 0);
});

await t("check() : bucket absent → message explicite", async () => {
  const wrong = new S3BundleStore({
    bucket: "inexistant",
    endpoint: mock.endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  await assert.rejects(wrong.check(), /magasin de bundles injoignable/);
});

await t("put + list + fetch : aller-retour fidèle", async () => {
  await store.put(bundleKey("shared", "aaaaaaa", 1000), file("a.bundle", "contenu-A"));
  const list = await store.list("shared");
  assert.equal(list.length, 1);
  assert.equal(list[0].size, "contenu-A".length);
  const dest = path.join(root, "recupere.bundle");
  await store.fetch(list[0].key, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), "contenu-A");
});

await t("fetch : aucun fichier .part ne subsiste", () => {
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => f.endsWith(".part")),
    [],
  );
});

await t("list : le plus récent d'abord", async () => {
  await store.put(bundleKey("shared", "bbbbbbb", 2000), file("b.bundle", "B"));
  await store.put(bundleKey("shared", "ccccccc", 3000), file("c.bundle", "C"));
  const list = await store.list("shared");
  assert.equal(list.length, 3);
  assert.match(list[0].key, /ccccccc/, "le plus récent doit être en tête");
  assert.match(list[2].key, /aaaaaaa/);
});

await t("list : la pagination est suivie jusqu'au bout", async () => {
  // The mock pages at 2 keys; 3 objects therefore require a continuation.
  const before = mock.calls.list;
  const list = await store.list("shared");
  assert.equal(list.length, 3, "une pagination ignorée masquerait le bundle le plus récent");
  assert.ok(mock.calls.list - before >= 2, "plusieurs pages doivent être demandées");
});

await t("list : les repos sont isolés par préfixe", async () => {
  await store.put(bundleKey("users-albert", "ddddddd", 4000), file("d.bundle", "D"));
  assert.equal((await store.list("shared")).length, 3);
  assert.equal((await store.list("users-albert")).length, 1);
});

await t("prune : conserve les N plus récents, supprime le reste", async () => {
  await store.prune("shared", 2);
  const left = await store.list("shared");
  assert.equal(left.length, 2);
  assert.match(left[0].key, /ccccccc/);
  assert.match(left[1].key, /bbbbbbb/);
  assert.equal((await store.list("users-albert")).length, 1, "prune ne doit pas toucher les autres repos");
});

await t("comportement identique au driver local (interchangeables)", async () => {
  const localDir = path.join(root, "local");
  const local = new LocalBundleStore(localDir);
  const s3b = new S3BundleStore({
    bucket: mock.bucket,
    endpoint: mock.endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
    prefix: "compare",
  });
  const seq = [
    ["cmp", "1111111", 1000, "un"],
    ["cmp", "2222222", 2000, "deux"],
    ["cmp", "3333333", 3000, "trois"],
  ] as const;
  for (const [repo, sha, at, body] of seq) {
    const f = file(`${sha}.bundle`, body);
    await local.put(bundleKey(repo, sha, at), f);
    await s3b.put(bundleKey(repo, sha, at), f);
  }
  assert.deepEqual(
    (await s3b.list("cmp")).map((b) => b.key),
    (await local.list("cmp")).map((b) => b.key),
    "même ordre et mêmes clés",
  );
  await local.prune("cmp", 1);
  await s3b.prune("cmp", 1);
  assert.deepEqual(
    (await s3b.list("cmp")).map((b) => b.key),
    (await local.list("cmp")).map((b) => b.key),
    "même résultat après prune",
  );
});

// ---- the whole durability path, on S3 ----
await t("cycle complet sur S3 : écriture → disque détruit → restauration", async () => {
  const workA = path.join(root, "work-a");
  const s3b = new S3BundleStore({
    bucket: mock.bucket,
    endpoint: mock.endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
    prefix: "wiki",
  });
  const make = (workDir: string) =>
    new WikiStore({
      workDir,
      store: s3b,
      keepBundles: 3,
      seed: (repo, dir) => fs.writeFileSync(path.join(dir, "index.md"), `# ${repo}\n`),
    });

  const first = make(workA);
  await first.open(["shared"]);
  await first.write("shared", "CRÉÉ /shared/page.md", () => {
    fs.writeFileSync(path.join(workA, "shared", "page.md"), "contenu durable\n");
  });

  // Exactly what a Clever Cloud redeploy does.
  fs.rmSync(workA, { recursive: true, force: true });

  const workB = path.join(root, "work-b");
  const reports = await make(workB).open(["shared"]);
  assert.equal(reports[0].source, "restored");
  assert.equal(fs.readFileSync(path.join(workB, "shared", "page.md"), "utf8"), "contenu durable\n");
});

// ---- environment wiring ----
await t("s3StoreFromEnv : rien sans configuration", () => {
  for (const k of ["WETOPIA_BUNDLE_BUCKET", "CELLAR_ADDON_HOST", "CELLAR_ADDON_KEY_ID", "CELLAR_ADDON_KEY_SECRET"]) {
    delete process.env[k];
  }
  assert.equal(s3StoreFromEnv(), null, "sans Cellar configuré, on reste sur le driver local");
});

await t("s3StoreFromEnv : construit depuis les variables Cellar de Clever Cloud", () => {
  process.env.WETOPIA_BUNDLE_BUCKET = "wetopia";
  process.env.CELLAR_ADDON_HOST = "cellar-c2.services.clever-cloud.com";
  process.env.CELLAR_ADDON_KEY_ID = "id";
  process.env.CELLAR_ADDON_KEY_SECRET = "secret";
  const s = s3StoreFromEnv();
  assert.ok(s instanceof S3BundleStore);
  for (const k of ["WETOPIA_BUNDLE_BUCKET", "CELLAR_ADDON_HOST", "CELLAR_ADDON_KEY_ID", "CELLAR_ADDON_KEY_SECRET"]) {
    delete process.env[k];
  }
});

await mock.close();
fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} S3 checks passed`);
process.exit(failed.length ? 1 : 0);
