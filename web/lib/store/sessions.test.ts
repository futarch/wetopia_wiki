// Transcript storage: out of the root user's home, and durable without ever
// entering the wiki's git history.
//   node --experimental-strip-types lib/store/sessions.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBundleStore } from "./bundleStore.ts";
import { S3BundleStore } from "./s3BundleStore.ts";
import { SESSIONS_PREFIX, archiveSessions } from "./sessionArchive.ts";
// @ts-ignore — plain JS helper
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-sessions-"));
const sessionsDir = path.join(root, "agent", "sessions");
const storeDir = path.join(root, "store");
const store = new LocalBundleStore(storeDir);

const transcript = (workspace: string, stamp: string, body: string) => {
  const dir = path.join(sessionsDir, workspace);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${stamp}_01a0.jsonl`);
  fs.writeFileSync(f, body);
  return f;
};

// ---- the configuration lever ----
await t("la config détourne pi de ~/.pi vers le runtime", async () => {
  const before = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.WETOPIA_RUNTIME = path.join(root, "rt");
  const { config } = await import(`./../server/config.ts?fresh=${Date.now()}`);
  assert.equal(process.env.PI_CODING_AGENT_DIR, config.agentDir, "pi doit pointer vers notre agentDir");
  assert.ok(config.agentDir.startsWith(path.join(root, "rt")), config.agentDir);
  assert.ok(!config.agentDir.includes(os.homedir()), "jamais dans le home de l'utilisateur");
  assert.equal(config.sessionsDir, path.join(config.agentDir, "sessions"));
  if (before) process.env.PI_CODING_AGENT_DIR = before;
});

// ---- archiving ----
await t("premier passage : tous les transcripts sont téléversés", async () => {
  transcript("albert--shared", "2026-08-24T10-00-00-000Z", "{}\n");
  transcript("albert--private", "2026-08-24T11-00-00-000Z", "{}\n");
  const r = await archiveSessions(store, sessionsDir);
  assert.equal(r.uploaded.length, 2, JSON.stringify(r));
  assert.equal(r.skipped, 0);
  assert.ok(r.uploaded.every((k) => k.startsWith(`${SESSIONS_PREFIX}/`)));
});

await t("deuxième passage : rien à refaire", async () => {
  const r = await archiveSessions(store, sessionsDir);
  assert.equal(r.uploaded.length, 0);
  assert.equal(r.skipped, 2);
});

await t("une conversation qui continue est re-téléversée", async () => {
  const f = path.join(sessionsDir, "albert--shared", "2026-08-24T10-00-00-000Z_01a0.jsonl");
  fs.appendFileSync(f, '{"role":"user"}\n');
  const r = await archiveSessions(store, sessionsDir);
  assert.equal(r.uploaded.length, 1, "seul le fichier qui a grandi");
  assert.equal(r.skipped, 1);
});

await t("le contenu archivé est fidèle", async () => {
  const stored = await store.listObjects(SESSIONS_PREFIX);
  const key = stored.find((b) => b.key.includes("albert--shared"))!.key;
  const dest = path.join(root, "relu.jsonl");
  await store.fetch(key, dest);
  assert.equal(
    fs.readFileSync(dest, "utf8"),
    fs.readFileSync(path.join(sessionsDir, "albert--shared", "2026-08-24T10-00-00-000Z_01a0.jsonl"), "utf8"),
  );
});

await t("les transcripts n'entrent jamais dans les bundles du wiki", async () => {
  const bundles = await store.list("shared");
  assert.deepEqual(bundles, [], "aucun bundle wiki ne doit exister ici");
  const keys = (await store.listObjects(SESSIONS_PREFIX)).map((b) => b.key);
  assert.ok(keys.every((k) => k.startsWith("sessions/")), keys.join(", "));
});

await t("rétention : les vieux transcripts sont supprimés, les récents gardés", async () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  transcript("albert--shared", "2026-06-01T09-00-00-000Z", "vieux\n");
  await archiveSessions(store, sessionsDir);
  const r = await archiveSessions(store, sessionsDir, { retentionDays: 30, now: () => now });
  assert.equal(r.deleted.length, 1, JSON.stringify(r.deleted));
  assert.match(r.deleted[0], /2026-06-01/);
  const left = (await store.listObjects(SESSIONS_PREFIX)).map((b) => b.key);
  assert.equal(left.length, 2, "les deux transcripts récents restent");
  assert.ok(!left.some((k) => k.includes("2026-06-01")));
});

await t("suppression par clé exacte : les autres workspaces sont intacts", async () => {
  const left = (await store.listObjects(SESSIONS_PREFIX)).map((b) => b.key);
  assert.ok(left.some((k) => k.includes("albert--private")), "le workspace privé ne doit pas être emporté");
});

// ---- same behaviour on the production driver ----
await t("comportement identique sur le driver S3", async () => {
  const mock = await startS3Mock({ bucket: "wetopia", pageSize: 2 });
  const s3 = new S3BundleStore({
    bucket: mock.bucket,
    endpoint: mock.endpoint,
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  const r1 = await archiveSessions(s3, sessionsDir);
  assert.equal(r1.uploaded.length, 3, JSON.stringify(r1));
  const r2 = await archiveSessions(s3, sessionsDir);
  assert.equal(r2.skipped, 3, "deuxième passage sans téléversement");
  const now = Date.parse("2026-08-24T12:00:00Z");
  const r3 = await archiveSessions(s3, sessionsDir, { retentionDays: 30, now: () => now });
  assert.equal(r3.deleted.length, 1);
  assert.equal((await s3.listObjects(SESSIONS_PREFIX)).length, 2);
  await mock.close();
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} session checks passed`);
process.exit(failed.length ? 1 : 0);
