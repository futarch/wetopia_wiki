// Reading the wiki for the interface: the link graph, and one page's text.
//
// Both go through the same per-session guard as the agent's tools. The browser
// never names a bundle path we have not checked, and a shared-scope viewer
// cannot see a private page here any more than the agent can.
import fs from "node:fs";
import path from "node:path";
import { createSessionContext } from "./guard.ts";
import { listPages, RESERVED, type Page } from "./lint/analyze.ts";

export type Scope = "private" | "shared";

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  /** Linked to but not written yet — a gap, which charter §7 treats as welcome. */
  missing: boolean;
  private: boolean;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

const isReserved = (p: Page) => RESERVED.has(path.basename(p.file));

function visiblePages(dataRoot: string, user: string, scope: Scope): Page[] {
  const ctx = createSessionContext({ dataRoot, user, scope });
  const pages: Page[] = [];
  for (const root of ctx.readRoots) {
    if (fs.existsSync(root)) pages.push(...listPages(dataRoot, root));
  }
  return pages;
}

export function buildGraph(dataRoot: string, user: string, scope: Scope) {
  const pages = visiblePages(dataRoot, user, scope).filter((p) => !isReserved(p));
  const byPath = new Map(pages.map((p) => [p.path, p]));

  const nodes = new Map<string, GraphNode>();
  const add = (p: string, page?: Page) => {
    if (nodes.has(p)) return;
    nodes.set(p, {
      id: p,
      label: String(page?.frontmatter?.title ?? path.basename(p, ".md")),
      type: String(page?.frontmatter?.type ?? "Inconnu"),
      missing: !page,
      private: p.startsWith("/users/"),
      degree: 0,
    });
  };
  for (const p of pages) add(p.path, p);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const target of p.links) {
      if (!byPath.has(target)) {
        // A link into a bundle this viewer cannot see is dropped rather than
        // drawn as a gap: showing it would reveal that something is there.
        const reachable = target.startsWith("/shared/") || target.startsWith(`/users/${user}/`);
        if (!reachable) continue;
        add(target);
      }
      const key = `${p.path}→${target}`;
      if (seen.has(key) || target === p.path) continue;
      seen.add(key);
      edges.push({ source: p.path, target });
      nodes.get(p.path)!.degree++;
      nodes.get(target)!.degree++;
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export interface PageView {
  path: string;
  title: string;
  type: string;
  markdown: string;
  exists: boolean;
  /** In a private bundle: visible to its owner alone. */
  private: boolean;
}

export function readPageView(dataRoot: string, user: string, scope: Scope, p: string): PageView {
  const ctx = createSessionContext({ dataRoot, user, scope });
  const abs = ctx.resolveBundlePath(p); // throws when out of scope
  if (!fs.existsSync(abs)) {
    return {
      path: p,
      title: path.basename(p, ".md"),
      type: "",
      markdown: "",
      exists: false,
      private: p.startsWith("/users/"),
    };
  }
  const raw = fs.readFileSync(abs, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const body = m ? raw.slice(m[0].length) : raw;
  const front = m?.[1] ?? "";
  const field = (k: string) =>
    new RegExp(`^${k}:\\s*"?([^"\\n]+?)"?\\s*$`, "m").exec(front)?.[1]?.trim() ?? "";
  return {
    path: p,
    title: field("title") || path.basename(p, ".md"),
    type: field("type"),
    markdown: body.trim(),
    exists: true,
    private: p.startsWith("/users/"),
  };
}
