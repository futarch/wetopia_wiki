// Deterministic lint suite: no model, no API key.
//   node --experimental-strip-types lib/lint/lint.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, listPages, repairIndex, RESERVED } from "./analyze.ts";
import { renderReport } from "./run.ts";

const results: [string, boolean, string?][] = [];
const t = (name: string, fn: () => void) => {
  try {
    fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, (e as Error).message]);
  }
};

// ---- fixture: one bundle carrying every anomaly the charter asks about ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wetopia-lint-"));
const shared = path.join(root, "shared");
const priv = path.join(root, "users", "albert");
for (const d of [path.join(shared, "people"), path.join(shared, "tasks"), path.join(shared, "events"), priv]) {
  fs.mkdirSync(d, { recursive: true });
}
const page = (file: string, fm: string, body = "") =>
  fs.writeFileSync(file, `---\n${fm}\n---\n\n${body}\n`);

page(
  path.join(shared, "people", "rene-dupont.md"),
  `type: Person\ntitle: "René Dupont"\ndescription: "Maraîcher à Lyon."\ntags: [permaculture, Lyon]`,
  "Il anime l'atelier et suit le [compost](/shared/projects/compost.md).",
);
page(
  path.join(shared, "tasks", "broyeur.md"),
  `type: Task\ntitle: "Trouver un broyeur"\ndescription: "Avant les tailles."\ntask: { state: open, owner: "human:albert", due: 2026-01-05 }`,
);
page(
  path.join(shared, "events", "fete.md"),
  `type: Fête\ntitle: "Fête des récoltes"\ndescription: "Le 20 septembre."\nstale_after: 2026-02-01\ntags: [lyon]`,
);
page(path.join(shared, "orpheline.md"), `type: Concept\ntitle: "Idée isolée"\ndescription: "Personne n'y mène."`);
fs.writeFileSync(path.join(shared, "index.md"), `# Index — wiki partagé\n\n- [/shared/people/rene-dupont.md](/shared/people/rene-dupont.md) — Maraîcher à Lyon.\n- [/shared/disparue.md](/shared/disparue.md) — Page supprimée depuis.\n`);
fs.writeFileSync(path.join(shared, "log.md"), "# Journal\n");

// private bundle: a page that duplicates a shared one
page(path.join(priv, "rene.md"), `type: Person\ntitle: "René Dupont"\ndescription: "Copie privée."`);
fs.writeFileSync(path.join(priv, "index.md"), "# Index privé\n");
fs.writeFileSync(path.join(priv, "log.md"), "# Journal privé\n");

const now = new Date("2026-08-24T03:00:00Z");
const sharedPages = listPages(root, shared);
const privPages = listPages(root, priv);
const findings = analyze({ pages: sharedPages, now });
const privFindings = analyze({ pages: privPages, sharedPages, now });
const kinds = (fs2: typeof findings, k: string) => fs2.filter((f) => f.kind === k);

t("énumère toutes les pages du bundle", () => {
  assert.equal(sharedPages.length, 6, sharedPages.map((p) => p.path).join(", "));
});

t("type hors charte signalé", () => {
  const d = kinds(findings, "type-drift");
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /Fête/);
});

t("page périmée (stale_after) signalée", () => {
  assert.equal(kinds(findings, "stale").length, 1);
  assert.match(kinds(findings, "stale")[0].path, /fete\.md/);
});

t("tâche en retard signalée", () => {
  const d = kinds(findings, "task-overdue");
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /2026-01-05/);
});

t("tâche terminée non signalée", () => {
  page(
    path.join(shared, "tasks", "faite.md"),
    `type: Task\ntitle: "Déjà faite"\ndescription: "."\ntask: { state: done, due: 2026-01-01 }`,
  );
  const again = analyze({ pages: listPages(root, shared), now });
  assert.equal(kinds(again, "task-overdue").length, 1, "seule la tâche ouverte doit être signalée");
  fs.rmSync(path.join(shared, "tasks", "faite.md"));
});

t("page orpheline signalée", () => {
  const paths = kinds(findings, "orphan").map((f) => f.path);
  assert.ok(paths.some((p) => p.endsWith("/orpheline.md")), paths.join(", "));
});

t("lacune signalée (lien vers une page inexistante)", () => {
  const gaps = kinds(findings, "gap");
  assert.ok(gaps.some((g) => g.path === "/shared/projects/compost.md"), JSON.stringify(gaps));
});

t("tags équivalents signalés (Lyon / lyon)", () => {
  const d = kinds(findings, "tag-drift");
  assert.equal(d.length, 1, JSON.stringify(d));
  assert.match(d[0].detail, /Lyon/);
});

t("page privée recouvrant une page partagée signalée — et seulement côté privé", () => {
  assert.equal(kinds(privFindings, "duplicate-of-shared").length, 1);
  assert.equal(kinds(findings, "duplicate-of-shared").length, 0);
});

t("frontmatter illisible signalé", () => {
  const bad = path.join(shared, "cassee.md");
  fs.writeFileSync(bad, "---\ntype: [oups\n---\n\ncorps\n");
  const again = analyze({ pages: listPages(root, shared), now });
  assert.ok(kinds(again, "frontmatter").length >= 1);
  fs.rmSync(bad);
});

t("les fichiers réservés ne sont jamais traités comme des pages", () => {
  assert.ok(RESERVED.has("index.md") && RESERVED.has("log.md") && RESERVED.has("lint.md"));
  const noisy = findings.filter((f) => /\/(index|log|lint)\.md$/.test(f.path));
  assert.deepEqual(noisy, []);
});

// ---- index repair ----
t("index : ajoute les pages manquantes, retire les entrées mortes, préserve le reste", () => {
  const before = fs.readFileSync(path.join(shared, "index.md"), "utf8");
  const repair = repairIndex(before, sharedPages);
  assert.deepEqual(repair.removed, ["/shared/disparue.md"]);
  assert.ok(repair.added.includes("/shared/orpheline.md"));
  assert.ok(repair.content.includes("# Index — wiki partagé"), "l'en-tête doit survivre");
  assert.ok(
    repair.content.includes("- [/shared/people/rene-dupont.md](/shared/people/rene-dupont.md) — Maraîcher à Lyon."),
    "une ligne existante ne doit pas être réécrite",
  );
  assert.ok(!repair.content.includes("/shared/disparue.md"));
});

t("index : idempotent (deux passes ne changent rien de plus)", () => {
  const once = repairIndex(fs.readFileSync(path.join(shared, "index.md"), "utf8"), sharedPages);
  const twice = repairIndex(once.content, sharedPages);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.removed, []);
  assert.equal(twice.content, once.content);
});

// ---- report rendering ----
t("le rapport groupe par nature et rappelle qu'il ne décide rien", () => {
  const md = renderReport(findings, now, "/shared");
  assert.match(md, /# Rapport du lint — 2026-08-24/);
  assert.match(md, /informatif/);
  assert.match(md, /## Pages périmées/);
  assert.match(md, /## Tâches en retard/);
});

t("rapport vide lisible", () => {
  const md = renderReport([], now, "/shared");
  assert.match(md, /Rien à signaler/);
});

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, err] of results) console.log(` ${ok ? "✓" : "✗"} ${name}${err ? `\n     ${err}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} lint checks passed`);
process.exit(failed.length ? 1 : 0);
