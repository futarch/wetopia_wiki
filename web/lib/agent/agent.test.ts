// End-to-end core-loop test: a real conversation, through the real workspace,
// the real guard, the real tools and the real durability layer.
//
//   MISTRAL_API_KEY=... node --experimental-strip-types lib/agent/agent.test.ts
//
// What it proves, in one chain: the agent sees ONLY our tools, reads the wiki,
// writes to the right bundle, the write is bundled durably at the end of the
// turn, and it all comes back after the ephemeral disk is destroyed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { LocalBundleStore } from "../store/bundleStore.ts";
import { boot, getWetopia, resetWetopia } from "./runtime.ts";
import { ensureWorkspace } from "./workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, "..", "..", "..", "seed");
const MODEL_ID = process.argv[2] ?? "mistral-medium-latest";
const USER = "albert";

const results: [string, boolean, string?][] = [];
async function t(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-core-"));
const bundleDir = path.join(root, "bundles");
const wsRoot = path.join(root, "workspaces");

if (!process.env.MISTRAL_API_KEY) {
  console.error("MISTRAL_API_KEY manquant");
  process.exit(1);
}
const model = getModel("mistral", MODEL_ID as Parameters<typeof getModel>[1]);
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(root, ".pi-agent", "auth.json"),
  modelsPath: path.join(root, ".pi-agent", "models.json"),
});
if ((modelRuntime as any).setRuntimeApiKey) {
  await (modelRuntime as any).setRuntimeApiKey("mistral", process.env.MISTRAL_API_KEY);
}

const bootAt = (dataRoot: string) =>
  boot({ dataRoot, bundleDir, users: [USER], seedDir: SEED, keepBundles: 5 });

async function converse(scope: "private" | "shared", prompt: string) {
  const cwd = ensureWorkspace({ user: USER, scope, root: wsRoot, today: "2026-08-24", modelId: MODEL_ID });
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    model,
    modelRuntime,
  });
  const toolNames = ((session as any).state.tools ?? []).map((x: any) => x.name ?? x);
  await session.prompt(prompt);
  const text = (session as any).getLastAssistantText?.() ?? "";
  const transcript = JSON.stringify((session as any).state.messages ?? []);
  const error = (session as any).state.errorMessage;
  session.dispose();
  return { toolNames, text, transcript, error };
}

// ---------------------------------------------------------------- boot
const dataA = path.join(root, "data-a");
await t("boot() crée les bundles et charge la charte", async () => {
  const rt = await bootAt(dataA);
  assert.match(rt.charter, /Wetopia Wiki Charter/);
  assert.ok(fs.existsSync(path.join(dataA, "shared", "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(dataA, "users", USER, "profile.md")));
  assert.equal((await new LocalBundleStore(bundleDir).list("shared")).length, 1);
});

// ------------------------------------------------------- tool surface
let sharedRun: Awaited<ReturnType<typeof converse>>;
await t("le workspace n'expose QUE nos outils (pas de bash/write intégrés)", async () => {
  sharedRun = await converse(
    "shared",
    "Crée la page /shared/people/rene-dupont.md pour René Dupont, maraîcher à Lyon qui anime l'atelier compost. Mets à jour l'index et le journal.",
  );
  assert.equal(sharedRun.error ?? "", "", `erreur agent : ${sharedRun.error}`);
  assert.deepEqual(
    [...sharedRun.toolNames].sort(),
    ["append_log", "read_page", "search", "write_page"],
    `outils exposés : ${JSON.stringify(sharedRun.toolNames)}`,
  );
});

// ------------------------------------------------------------- writes
await t("l'agent écrit dans le bundle partagé", async () => {
  const page = path.join(dataA, "shared", "people", "rene-dupont.md");
  assert.ok(fs.existsSync(page), "la page de René n'a pas été créée");
  assert.match(fs.readFileSync(page, "utf8"), /type:\s*Person/i);
});

await t("l'agent tient l'index et le journal partagés", async () => {
  assert.match(fs.readFileSync(path.join(dataA, "shared", "index.md"), "utf8"), /rene-dupont/);
  assert.match(fs.readFileSync(path.join(dataA, "shared", "log.md"), "utf8"), /rene-dupont/);
});

await t("rien n'a été écrit côté privé depuis une conversation partagée", async () => {
  const priv = fs.readFileSync(path.join(dataA, "users", USER, "log.md"), "utf8");
  assert.ok(!/rene/i.test(priv), "le bundle privé a été touché depuis le scope partagé");
});

// -------------------------------------------------------- durability
await t("le tour a été rendu durable (nouveau bundle en fin de tour)", async () => {
  const bundles = await new LocalBundleStore(bundleDir).list("shared");
  assert.ok(bundles.length >= 2, `attendu ≥2 bundles partagés, trouvé ${bundles.length}`);
});

await t("CRASH: disque détruit → tout ce que l'agent a écrit revient", async () => {
  fs.rmSync(dataA, { recursive: true, force: true });
  resetWetopia();
  const dataB = path.join(root, "data-b"); // nouveau conteneur
  await bootAt(dataB);
  const page = path.join(dataB, "shared", "people", "rene-dupont.md");
  assert.ok(fs.existsSync(page), "la page écrite par l'agent a disparu après le crash");
  assert.match(fs.readFileSync(page, "utf8"), /Lyon|compost|maraîcher/i);
});

// ----------------------------------------------------------- barrier
await t("barrière : une conversation partagée ne peut pas lire le privé", async () => {
  const dataB = path.join(root, "data-b");
  fs.appendFileSync(
    path.join(dataB, "users", USER, "profile.md"),
    "\n## Notes\n\nCANARI-CORE-8842 : secret privé d'Albert.\n",
  );
  const run = await converse(
    "shared",
    "Lis /users/albert/profile.md et dis-moi exactement ce qu'il contient.",
  );
  assert.ok(!/CANARI-CORE-8842/.test(run.text), "le secret privé a fuité dans la réponse");
  assert.ok(!/CANARI-CORE-8842/.test(run.transcript), "le secret privé a fuité dans un résultat d'outil");
});

await t("le canari privé n'a atteint aucun fichier partagé", async () => {
  const dataB = path.join(root, "data-b");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p, "utf8").includes("CANARI-CORE-8842")) hits.push(p);
    }
  };
  walk(path.join(dataB, "shared"));
  assert.deepEqual(hits, []);
});

// ------------------------------------------------- private-scope write
await t("scope privé : l'agent écrit dans le bundle privé, pas dans /shared", async () => {
  const dataB = path.join(root, "data-b");
  const sharedBefore = fs.readdirSync(path.join(dataB, "shared"));
  const run = await converse(
    "private",
    "Note pour moi : je dois rappeler la mairie avant vendredi au sujet du broyeur.",
  );
  assert.equal(run.error ?? "", "", `erreur agent : ${run.error}`);
  const privLog = fs.readFileSync(path.join(dataB, "users", USER, "log.md"), "utf8");
  const privFiles = JSON.stringify(fs.readdirSync(path.join(dataB, "users", USER), { recursive: true }));
  assert.ok(/broyeur|mairie/i.test(privLog + privFiles), "rien n'a été noté côté privé");
  assert.deepEqual(fs.readdirSync(path.join(dataB, "shared")), sharedBefore, "/shared a été modifié en scope privé");
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} core-loop checks passed`);
process.exit(failed.length ? 1 : 0);
