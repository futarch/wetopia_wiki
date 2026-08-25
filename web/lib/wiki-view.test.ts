// The graph and page reader must obey the same barrier as the agent's tools.
//   node --experimental-strip-types lib/wiki-view.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGraph, readPageView } from "./wiki-view.ts";

const results: [string, boolean, string?][] = [];
const t = (name: string, fn: () => void) => {
  try {
    fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-view-"));
const page = (rel: string, fm: string, body = "") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${fm}\n---\n\n${body}\n`);
};

page("shared/projects/compost.md", `type: Project\ntitle: "Compost des Balmes"\ndescription: "."`,
  "Animé par [René](/shared/people/rene.md), au [jardin](/shared/places/jardin.md).");
page("shared/people/rene.md", `type: Person\ntitle: "René Dupont"\ndescription: "."`, "Maraîcher.");
fs.writeFileSync(path.join(root, "shared", "index.md"), "# Index\n");
fs.writeFileSync(path.join(root, "shared", "log.md"), "# Journal\n");
page("users/albert/notes.md", `type: Concept\ntitle: "Mes notes"\ndescription: "."`,
  "Idées perso sur le [compost](/shared/projects/compost.md). CANARI-VUE-88");
page("users/marie/prive.md", `type: Concept\ntitle: "Secret de Marie"\ndescription: "."`, "CANARI-MARIE");

t("scope partagé : ne voit que les pages partagées", () => {
  const g = buildGraph(root, "albert", "shared");
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes("/shared/projects/compost.md"));
  assert.ok(!ids.some((i) => i.startsWith("/users/")), ids.join(", "));
});

t("scope privé : voit le partagé ET son propre bundle", () => {
  const ids = buildGraph(root, "albert", "private").nodes.map((n) => n.id);
  assert.ok(ids.includes("/users/albert/notes.md"));
  assert.ok(ids.includes("/shared/projects/compost.md"));
});

t("aucun scope ne montre le bundle d'un autre utilisateur", () => {
  for (const scope of ["private", "shared"] as const) {
    const ids = buildGraph(root, "albert", scope).nodes.map((n) => n.id);
    assert.ok(!ids.some((i) => i.startsWith("/users/marie/")), `${scope} : ${ids.join(", ")}`);
  }
});

t("fichiers réservés absents du graphe", () => {
  const ids = buildGraph(root, "albert", "shared").nodes.map((n) => n.id);
  assert.ok(!ids.some((i) => /\/(index|log|lint)\.md$/.test(i)), ids.join(", "));
});

t("les liens deviennent des arêtes", () => {
  const g = buildGraph(root, "albert", "shared");
  assert.ok(g.edges.some((e) => e.source.endsWith("compost.md") && e.target.endsWith("rene.md")));
});

t("une page attendue mais absente apparaît comme lacune", () => {
  const g = buildGraph(root, "albert", "shared");
  const jardin = g.nodes.find((n) => n.id === "/shared/places/jardin.md");
  assert.ok(jardin, "le lien vers une page inexistante doit créer un nœud");
  assert.equal(jardin!.missing, true);
});

t("les nœuds portent leur titre et leur type", () => {
  const n = buildGraph(root, "albert", "shared").nodes.find((x) => x.id.endsWith("rene.md"))!;
  assert.equal(n.label, "René Dupont");
  assert.equal(n.type, "Person");
});

t("lecture d'une page partagée", () => {
  const v = readPageView(root, "albert", "shared", "/shared/people/rene.md");
  assert.equal(v.title, "René Dupont");
  assert.equal(v.type, "Person");
  assert.match(v.markdown, /Maraîcher/);
  assert.ok(!v.markdown.includes("---"), "le frontmatter ne doit pas être affiché");
});

t("barrière : lire une page privée en scope partagé est refusé", () => {
  assert.throws(() => readPageView(root, "albert", "shared", "/users/albert/notes.md"));
});

t("barrière : lire le bundle d'un autre utilisateur est refusé", () => {
  for (const scope of ["private", "shared"] as const) {
    assert.throws(() => readPageView(root, "albert", scope, "/users/marie/prive.md"));
  }
});

t("les payloads de traversée sont refusés ici aussi", () => {
  for (const p of ["/shared/../users/marie/prive.md", "/shared/../../etc/passwd", "/shared/./../users/albert/notes.md"]) {
    assert.throws(() => readPageView(root, "albert", "shared", p), undefined, `accepté : ${p}`);
  }
});

t("page inexistante : réponse propre, pas d'erreur", () => {
  const v = readPageView(root, "albert", "shared", "/shared/places/jardin.md");
  assert.equal(v.exists, false);
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [n, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${n}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} view checks passed`);
process.exit(failed.length ? 1 : 0);
