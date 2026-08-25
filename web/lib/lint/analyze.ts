// The deterministic half of the nightly lint.
//
// Enumeration and arithmetic live here, in code: which pages exist, which links
// dangle, what the index is missing, what is past its date. The audit's lesson
// applies — the model may judge content, never coverage — so nothing in this
// file asks an LLM anything.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** The eight types of charter §5. Anything else is drift. */
export const ALLOWED_TYPES = [
  "Person",
  "Organization",
  "Place",
  "Project",
  "Concept",
  "Event",
  "Task",
  "Decision",
];

export const RESERVED = new Set(["index.md", "log.md", "lint.md", "AGENTS.md", "profile.md"]);

export type FindingKind =
  | "orphan"
  | "stale"
  | "task-overdue"
  | "type-drift"
  | "tag-drift"
  | "duplicate"
  | "duplicate-of-shared"
  | "gap"
  | "frontmatter"
  | "contradiction";

export interface Finding {
  kind: FindingKind;
  path: string;
  detail: string;
}

export interface Page {
  /** Bundle-absolute path, e.g. /shared/people/rene-dupont.md */
  path: string;
  file: string;
  body: string;
  frontmatter: Record<string, any> | null;
  frontmatterError?: string;
  links: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function readPage(dataRoot: string, file: string): Page {
  const raw = fs.readFileSync(file, "utf8");
  const bundlePath = "/" + path.relative(dataRoot, file).split(path.sep).join("/");
  const m = FRONTMATTER.exec(raw);
  let frontmatter: Record<string, any> | null = null;
  let frontmatterError: string | undefined;
  if (m) {
    try {
      const parsed = parseYaml(m[1]);
      frontmatter = parsed && typeof parsed === "object" ? parsed : null;
      if (!frontmatter) frontmatterError = "frontmatter illisible";
    } catch (e) {
      frontmatterError = (e as Error).message.split("\n")[0];
    }
  }
  const body = m ? raw.slice(m[0].length) : raw;
  const links = [...raw.matchAll(/\]\((\/[^)\s]+\.md)\)/g)].map((x) => x[1]);
  return { path: bundlePath, file, body, frontmatter, frontmatterError, links };
}

/** Every .md file of a bundle, reserved files included. */
export function listPages(dataRoot: string, bundleDir: string): Page[] {
  const out: Page[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(readPage(dataRoot, abs));
    }
  };
  if (fs.existsSync(bundleDir)) walk(bundleDir);
  return out;
}

const isReserved = (p: Page) => RESERVED.has(path.basename(p.file));

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(s|x)$/, ""); // fold trivial plurals

const asDate = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export interface AnalyzeInput {
  pages: Page[];
  /** Shared pages, when linting a private bundle (duplicate detection). */
  sharedPages?: Page[];
  now: Date;
}

export function analyze({ pages, sharedPages = [], now }: AnalyzeInput): Finding[] {
  const findings: Finding[] = [];
  const content = pages.filter((p) => !isReserved(p));
  const known = new Set(pages.map((p) => p.path));

  // --- frontmatter, types, tags (charter §5, §6) ---
  const tagSeen = new Map<string, string[]>();
  for (const p of content) {
    if (p.frontmatterError || !p.frontmatter) {
      findings.push({ kind: "frontmatter", path: p.path, detail: p.frontmatterError ?? "frontmatter absent" });
      continue;
    }
    const type = p.frontmatter.type;
    if (!type) findings.push({ kind: "frontmatter", path: p.path, detail: "champ « type » manquant (§6)" });
    else if (!ALLOWED_TYPES.includes(String(type))) {
      findings.push({
        kind: "type-drift",
        path: p.path,
        detail: `type « ${type} » hors des huit types de la charte (§5)`,
      });
    }
    if (!p.frontmatter.title) findings.push({ kind: "frontmatter", path: p.path, detail: "champ « title » manquant" });
    if (!p.frontmatter.description) {
      findings.push({ kind: "frontmatter", path: p.path, detail: "champ « description » manquant" });
    }
    for (const tag of Array.isArray(p.frontmatter.tags) ? p.frontmatter.tags : []) {
      const key = slug(String(tag));
      const list = tagSeen.get(key) ?? [];
      if (!list.includes(String(tag))) list.push(String(tag));
      tagSeen.set(key, list);
    }
  }
  for (const [, variants] of tagSeen) {
    if (variants.length > 1) {
      findings.push({
        kind: "tag-drift",
        path: "/",
        detail: `tags équivalents à harmoniser : ${variants.map((v) => `« ${v} »`).join(", ")}`,
      });
    }
  }

  // --- lifecycle: staleness and overdue tasks (charter §6, §12) ---
  for (const p of content) {
    const fm = p.frontmatter ?? {};
    const stale = asDate(fm.stale_after);
    if (stale && now >= stale) {
      findings.push({
        kind: "stale",
        path: p.path,
        detail: `périmée depuis le ${stale.toISOString().slice(0, 10)} (stale_after)`,
      });
    }
    const task = fm.task;
    if (task && typeof task === "object") {
      const due = asDate(task.due);
      const state = String(task.state ?? "open");
      if (due && now > due && state !== "done") {
        findings.push({
          kind: "task-overdue",
          path: p.path,
          detail: `tâche « ${state} » dont l'échéance était le ${due.toISOString().slice(0, 10)}`,
        });
      }
    }
  }

  // --- links: orphans and gaps (charter §7) ---
  const inbound = new Map<string, number>();
  for (const p of content) for (const l of p.links) inbound.set(l, (inbound.get(l) ?? 0) + 1);
  for (const p of content) {
    if (!inbound.get(p.path)) {
      findings.push({ kind: "orphan", path: p.path, detail: "aucune page ne pointe vers elle" });
    }
  }
  const gaps = new Map<string, string[]>();
  for (const p of content) {
    for (const l of p.links) {
      // A link to a page in another bundle is not a gap: this lint only sees one.
      if (known.has(l) || !l.startsWith(bundlePrefix(pages))) continue;
      const from = gaps.get(l) ?? [];
      from.push(p.path);
      gaps.set(l, from);
    }
  }
  for (const [target, from] of gaps) {
    findings.push({
      kind: "gap",
      path: target,
      detail: `lacune : page attendue par ${from.length} page(s) (${from[0]}${from.length > 1 ? "…" : ""})`,
    });
  }

  // --- duplicates (charter §8, §12) ---
  const bySlug = new Map<string, Page[]>();
  for (const p of content) {
    const key = slug(String(p.frontmatter?.title ?? path.basename(p.file)));
    bySlug.set(key, [...(bySlug.get(key) ?? []), p]);
  }
  for (const [, group] of bySlug) {
    if (group.length > 1) {
      findings.push({
        kind: "duplicate",
        path: group[0].path,
        detail: `doublon probable : ${group.map((g) => g.path).join(", ")}`,
      });
    }
  }

  // --- a private page duplicating a shared one (charter §8 « lier, ne pas copier ») ---
  const sharedBySlug = new Map<string, Page>();
  for (const p of sharedPages.filter((x) => !isReserved(x))) {
    sharedBySlug.set(slug(String(p.frontmatter?.title ?? path.basename(p.file))), p);
  }
  for (const p of content) {
    const twin = sharedBySlug.get(slug(String(p.frontmatter?.title ?? path.basename(p.file))));
    if (!twin) continue;
    // A private page about a shared subject is what §8 asks for — link to the
    // shared page, write only what is personal. Matching titles alone said
    // nothing about which of the two was happening, so the rule reproached
    // « préférer un lien » to pages made of a link and personal notes: the
    // exact shape the charter prescribes. The link is what settles it.
    if (p.links.includes(twin.path)) continue;
    findings.push({
      kind: "duplicate-of-shared",
      path: p.path,
      detail: `recouvre une page partagée (${twin.path}) sans y renvoyer — préférer un lien (§8)`,
    });
  }

  return findings;
}

/** `/shared/` or `/users/<id>/` — the prefix every page of this bundle shares. */
function bundlePrefix(pages: Page[]): string {
  const first = pages[0]?.path ?? "/";
  const parts = first.split("/").filter(Boolean);
  return first.startsWith("/users/") ? `/users/${parts[1]}/` : "/shared/";
}

// ---------------------------------------------------------------- index repair

export interface IndexRepair {
  content: string;
  added: string[];
  removed: string[];
}

/**
 * Surgical index maintenance (the one thing §12 lets the lint fix): add a line
 * for every page missing from the index, drop lines pointing at pages that no
 * longer exist, and leave every other line exactly as written — a human's
 * wording is not the lint's to rewrite.
 */
export function repairIndex(indexContent: string, pages: Page[]): IndexRepair {
  const content = pages.filter((p) => !isReserved(p));
  const lines = indexContent.split("\n");
  const linkOf = (line: string) => /\]\((\/[^)\s]+\.md)\)/.exec(line)?.[1];
  const listed = new Set<string>();

  const kept: string[] = [];
  const removed: string[] = [];
  const alive = new Set(pages.map((p) => p.path));
  for (const line of lines) {
    const link = linkOf(line);
    if (link && line.trim().startsWith("-")) {
      if (!alive.has(link)) {
        removed.push(link);
        continue;
      }
      listed.add(link);
    }
    kept.push(line);
  }

  const added: string[] = [];
  const entries = content
    .filter((p) => !listed.has(p.path))
    .map((p) => {
      added.push(p.path);
      const desc = String(p.frontmatter?.description ?? p.frontmatter?.title ?? "").trim();
      return `- [${p.path}](${p.path})${desc ? ` — ${desc}` : ""}`;
    });

  let out = kept.join("\n").replace(/\n+$/, "");
  if (entries.length) out += (out ? "\n" : "") + entries.join("\n");
  return { content: out + "\n", added, removed };
}
