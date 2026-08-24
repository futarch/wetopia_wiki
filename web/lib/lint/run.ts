// The nightly lint (charter §12).
//
// Runs inside the app process and through the store's single write queue, so
// there is no second writer to race with — the cron only triggers it.
//
// It reports; it does not decide. It never deletes a page, never resolves a
// contested claim, never moves anything between bundles. The one thing it
// repairs is the index, and only by adding or removing entries.
//
// Findings about a private bundle are written only inside that bundle.
import fs from "node:fs";
import path from "node:path";
import { getWetopia } from "../agent/runtime.ts";
import { SHARED_REPO, repoLayout, userRepo } from "../wiki.ts";
import { analyze, listPages, repairIndex, type Finding, type Page } from "./analyze.ts";

export interface LintReport {
  repo: string;
  bundle: string;
  findings: Finding[];
  indexAdded: string[];
  indexRemoved: string[];
  modelError?: string;
}

const KIND_TITLES: Record<string, string> = {
  contradiction: "Contradictions",
  stale: "Pages périmées",
  "task-overdue": "Tâches en retard",
  orphan: "Pages orphelines",
  duplicate: "Doublons probables",
  "duplicate-of-shared": "Recouvrements avec le wiki partagé",
  "type-drift": "Types hors charte",
  "tag-drift": "Tags à harmoniser",
  frontmatter: "Frontmatter incomplet",
  gap: "Lacunes (pages attendues)",
};
// Report order: what needs a human first.
const KIND_ORDER = Object.keys(KIND_TITLES);

export function renderReport(findings: Finding[], when: Date, bundle: string): string {
  const stamp = when.toISOString().slice(0, 10);
  const lines = [
    `# Rapport du lint — ${stamp}`,
    "",
    `Bundle : \`${bundle}\`. ${findings.length} signalement(s).`,
    "",
    "> Ce rapport est **informatif**. Le lint ne supprime rien, ne tranche aucune",
    "> contradiction et ne déplace rien entre les espaces : c'est à vous de décider.",
    "> Seul l'index est corrigé automatiquement.",
    "",
  ];
  if (!findings.length) {
    lines.push("Rien à signaler. 🌱", "");
    return lines.join("\n");
  }
  for (const kind of KIND_ORDER) {
    const group = findings.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${KIND_TITLES[kind]}`, "");
    for (const f of group) {
      const link = f.path.endsWith(".md") ? `[${f.path}](${f.path})` : f.path;
      lines.push(`- ${link} — ${f.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Contradictions are the one finding a machine cannot compute — it takes
 * reading two pages and noticing they disagree. The model is given only this
 * bundle's own pages, and only ever returns text: every write in this file is
 * made by the code above.
 */
async function findContradictions(pages: Page[], budget = 60_000): Promise<Finding[]> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY manquant");
  const usable = pages.filter((p) => !p.path.endsWith("log.md") && !p.path.endsWith("lint.md"));
  if (usable.length < 2) return [];

  let corpus = "";
  for (const p of usable) {
    const chunk = `\n\n=== ${p.path} ===\n${p.body.trim().slice(0, 2500)}`;
    if (corpus.length + chunk.length > budget) break;
    corpus += chunk;
  }

  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.WETOPIA_MODEL ?? "mistral-medium-latest",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Tu relis un wiki et tu cherches UNIQUEMENT les contradictions factuelles entre pages " +
            "(deux pages qui affirment des choses incompatibles : dates, lieux, rôles, états). " +
            "Réponds en JSON strict : {\"contradictions\":[{\"pages\":[\"/chemin/a.md\",\"/chemin/b.md\"],\"detail\":\"une phrase en français\"}]}. " +
            "Aucune contradiction ⇒ liste vide. N'invente rien ; une simple différence de niveau de détail n'est pas une contradiction.",
        },
        { role: "user", content: corpus },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Mistral ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.contradictions) ? parsed.contradictions : [];
  return items.slice(0, 20).map((c: any) => ({
    kind: "contradiction" as const,
    path: String(c.pages?.[0] ?? "/"),
    detail: `${String(c.detail ?? "").trim()}${c.pages?.[1] ? ` (cf. ${c.pages[1]})` : ""}`,
  }));
}

export interface LintOptions {
  /** Users whose private bundles should be linted. */
  users?: string[];
  /** Ask the model for contradictions (the only non-deterministic part). */
  withModel?: boolean;
  now?: Date;
}

/** Lint the shared bundle and each given user's bundle. */
export async function runLint(o: LintOptions = {}): Promise<LintReport[]> {
  const { store, dataRoot } = getWetopia();
  const now = o.now ?? new Date();
  const reports: LintReport[] = [];

  const sharedDir = path.join(dataRoot, repoLayout(SHARED_REPO));
  const sharedPages = listPages(dataRoot, sharedDir);

  const targets: { repo: string; dir: string; isShared: boolean }[] = [
    { repo: SHARED_REPO, dir: sharedDir, isShared: true },
    ...(o.users ?? []).map((u) => ({
      repo: userRepo(u),
      dir: path.join(dataRoot, repoLayout(userRepo(u))),
      isShared: false,
    })),
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.dir)) continue;
    const pages = target.isShared ? sharedPages : listPages(dataRoot, target.dir);
    const bundle = target.isShared ? "/shared" : `/users/${target.repo.slice("users-".length)}`;

    const findings = analyze({
      pages,
      sharedPages: target.isShared ? [] : sharedPages,
      now,
    });

    let modelError: string | undefined;
    if (o.withModel) {
      try {
        findings.unshift(...(await findContradictions(pages)));
      } catch (e) {
        // A model failure must never cost us the deterministic report.
        modelError = (e as Error).message;
      }
    }

    const report: LintReport = {
      repo: target.repo,
      bundle,
      findings,
      indexAdded: [],
      indexRemoved: [],
      modelError,
    };

    await store.mutate(target.repo, () => {
      const indexFile = path.join(target.dir, "index.md");
      if (fs.existsSync(indexFile)) {
        const repair = repairIndex(fs.readFileSync(indexFile, "utf8"), pages);
        if (repair.added.length || repair.removed.length) fs.writeFileSync(indexFile, repair.content);
        report.indexAdded = repair.added;
        report.indexRemoved = repair.removed;
      }

      fs.writeFileSync(path.join(target.dir, "lint.md"), renderReport(findings, now, bundle));

      const stamp = now.toISOString().slice(0, 16).replace("T", "T") + "Z";
      const bits = [`${findings.length} signalement(s)`];
      if (report.indexAdded.length) bits.push(`index +${report.indexAdded.length}`);
      if (report.indexRemoved.length) bits.push(`index −${report.indexRemoved.length}`);
      if (modelError) bits.push("contradictions non vérifiées");
      fs.appendFileSync(
        path.join(target.dir, "log.md"),
        `- ${stamp} [process:lint] MAJ ${bundle}/lint.md — ${bits.join(", ")}\n`,
      );
    });

    reports.push(report);
  }

  await store.flushDirty("lint nocturne");
  return reports;
}
