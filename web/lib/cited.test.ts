// Reading the sources of an answer out of a transcript.
//
// The property that matters: nothing is claimed as a source that the agent did
// not actually open. A wrong highlight is worse than none — it would tell
// someone the answer came from a page it never read.
import assert from "node:assert/strict";
import { citedPages, isPagePath } from "./cited.ts";

const tests: [string, () => void][] = [];
const check = (name: string, fn: () => void) => tests.push([name, fn]);

check("read_page cite la page lue", () => {
  const c = citedPages([{ toolName: "read_page", args: { path: "/shared/people/rene-dupont.md" } }]);
  assert.deepEqual(c.read, ["/shared/people/rene-dupont.md"]);
  assert.deepEqual(c.written, []);
});

check("write_page cite la page écrite, pas comme une lecture", () => {
  const c = citedPages([
    { toolName: "read_page", args: { path: "/shared/projects/compost.md" } },
    { toolName: "write_page", args: { path: "/shared/projects/compost.md", content: "…" } },
  ]);
  assert.deepEqual(c.read, []);
  assert.deepEqual(c.written, ["/shared/projects/compost.md"]);
});

check("les résultats de recherche nomment les pages parcourues", () => {
  const result = [
    "/shared/people/rene-dupont.md:3: René anime l'atelier compost",
    "/shared/projects/compost.md:11: le compost du quartier",
    "/shared/people/rene-dupont.md:9: une autre ligne de la même page",
  ].join("\n");
  const c = citedPages([{ toolName: "search", args: { query: "compost" }, result }]);
  assert.deepEqual(c.read.sort(), ["/shared/people/rene-dupont.md", "/shared/projects/compost.md"]);
});

check("une recherche sans résultat ne cite rien", () => {
  const c = citedPages([{ toolName: "search", args: { query: "x" }, result: "(aucun résultat)" }]);
  assert.deepEqual(c.read, []);
});

check("un appel encore en cours ne cite rien", () => {
  // Arguments arrive by fragments while the model streams them.
  const c = citedPages([{ toolName: "read_page", args: {} }, { toolName: "search", args: { query: "co" } }]);
  assert.deepEqual(c.read, []);
});

check("les fichiers réservés ne sont pas des pages du graphe", () => {
  const parts = ["index.md", "log.md", "lint.md", "AGENTS.md", "profile.md"].map((f) => ({
    toolName: "read_page",
    args: { path: `/shared/${f}` },
  }));
  parts.push({ toolName: "append_log", args: { path: "/shared/log.md", line: "…" } } as never);
  const c = citedPages(parts);
  assert.deepEqual(c.read, []);
  assert.deepEqual(c.written, []);
});

check("un chemin qui n'est pas une page est refusé", () => {
  for (const path of [
    "/shared/../users/albert/secret.md",
    "//shared/x.md",
    "shared/x.md",
    "/shared/x.txt",
    "",
    42,
    null,
  ]) {
    assert.equal(isPagePath(path), false, `accepté à tort : ${JSON.stringify(path)}`);
    assert.deepEqual(citedPages([{ toolName: "read_page", args: { path } }]).read, []);
  }
});

check("une ligne de résultat mal formée ne devient pas une source", () => {
  const result = ["pas un chemin: du texte", "/shared/x.md sans numéro de ligne", "  /shared/y.md:3: décalé"].join("\n");
  assert.deepEqual(citedPages([{ toolName: "search", result }]).read, []);
});

check("un outil inconnu est ignoré", () => {
  assert.deepEqual(citedPages([{ toolName: "rm_rf", args: { path: "/shared/x.md" } }]).read, []);
});

check("les doublons sont réduits, l'ordre reste stable", () => {
  const c = citedPages([
    { toolName: "read_page", args: { path: "/shared/a.md" } },
    { toolName: "read_page", args: { path: "/shared/b.md" } },
    { toolName: "read_page", args: { path: "/shared/a.md" } },
  ]);
  assert.deepEqual(c.read, ["/shared/a.md", "/shared/b.md"]);
});

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  console.log(` ✓ ${name}`);
  passed++;
}
console.log(`\n${passed}/${tests.length} citation checks passed`);
