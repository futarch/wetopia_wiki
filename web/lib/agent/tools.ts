// The agent's four wiki tools.
//
// Every path decision is delegated to the session's guard context (lib/guard.ts)
// and every mutation goes through the store's single-writer queue. The tools are
// built per conversation, so the information barrier is a property of the
// closure — not of any ambient state.
import fs from "node:fs";
import path from "node:path";
import type { SessionContext } from "../guard.ts";
import type { WikiStore } from "../store/wikiStore.ts";
import { repoForBundlePath } from "../wiki.ts";

export interface ToolDeps {
  ctx: SessionContext;
  store: WikiStore;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: `ERREUR: ${(e as Error).message}` }],
  details: {},
});
const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const toBundlePath = (dataRoot: string, abs: string) =>
  "/" + path.relative(dataRoot, abs).split(path.sep).join("/");

/** Walk the .md files of every root the conversation may read. */
function eachReadableFile(ctx: SessionContext, visit: (abs: string) => void): void {
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) visit(abs);
    }
  };
  for (const root of ctx.readRoots) if (fs.existsSync(root)) walk(root);
}

/**
 * Tool definitions in pi's `registerTool` shape. `Type` is passed in so this
 * module stays free of a typebox import (the extension already has one).
 */
export function createWikiTools({ ctx, store }: ToolDeps, Type: any) {
  const { resolveBundlePath, dataRoot } = ctx;

  const readPage = {
    name: "read_page",
    label: "Lire une page",
    description:
      "Lire une page du wiki. Chemin absolu de bundle, ex. /shared/index.md ou /users/<toi>/profile.md.",
    parameters: Type.Object({ path: Type.String({ description: "Chemin absolu de bundle" }) }),
    execute: async (_id: string, { path: p }: { path: string }) => {
      try {
        const abs = resolveBundlePath(p);
        if (!fs.existsSync(abs)) return ok(`(page inexistante : ${p})`);
        return ok(fs.readFileSync(abs, "utf8"));
      } catch (e) {
        return fail(e);
      }
    },
  };

  const search = {
    name: "search",
    label: "Rechercher",
    description:
      "Recherche plein-texte (insensible aux accents et à la casse) dans les bundles accessibles à cette conversation.",
    parameters: Type.Object({ query: Type.String({ description: "Le texte à chercher" }) }),
    execute: async (_id: string, { query }: { query: string }) => {
      const q = stripAccents(query);
      const hits: string[] = [];
      eachReadableFile(ctx, (abs) => {
        const rel = toBundlePath(dataRoot, abs);
        fs.readFileSync(abs, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (stripAccents(line).includes(q)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      });
      return ok(hits.length ? hits.slice(0, 30).join("\n") : "(aucun résultat)");
    },
  };

  const writePage = {
    name: "write_page",
    label: "Écrire une page",
    description:
      "Créer ou remplacer une page (contenu markdown complet, frontmatter inclus). Le scope de la conversation décide de la destination autorisée.",
    parameters: Type.Object({
      path: Type.String({ description: "Chemin absolu de bundle" }),
      content: Type.String({ description: "Contenu markdown complet de la page" }),
    }),
    execute: async (_id: string, { path: p, content }: { path: string; content: string }) => {
      try {
        const abs = resolveBundlePath(p, { forWrite: true });
        const repo = repoForBundlePath(p);
        return await store.mutate(repo, () => {
          const isCreate = !fs.existsSync(abs);
          let warning = "";
          if (isCreate) {
            const slug = (s: string) => stripAccents(s.replace(/\.md$/, "")).replace(/[^a-z]/g, "");
            const target = slug(path.basename(p));
            const similar: string[] = [];
            eachReadableFile(ctx, (other) => {
              const s = slug(path.basename(other));
              if (s && (s === target || s.startsWith(target) || target.startsWith(s))) {
                similar.push(toBundlePath(dataRoot, other));
              }
            });
            if (similar.length) {
              warning =
                `\nATTENTION : page(s) similaire(s) déjà existante(s) : ${similar.join(", ")}` +
                ` — si c'est le même sujet, mets-la à jour au lieu de créer un doublon (charte §8).`;
            }
          }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content.endsWith("\n") ? content : content + "\n");
          return ok(`écrit : ${p}${warning}`);
        });
      } catch (e) {
        return fail(e);
      }
    },
  };

  const appendLog = {
    name: "append_log",
    label: "Journaliser",
    description: "Ajouter une ligne à un journal (log.md) — jamais de réécriture.",
    parameters: Type.Object({
      path: Type.String({ description: "ex. /shared/log.md ou /users/<toi>/log.md" }),
      line: Type.String({ description: "La ligne de journal, format de la charte §9" }),
    }),
    execute: async (_id: string, { path: p, line }: { path: string; line: string }) => {
      try {
        const abs = resolveBundlePath(p, { forWrite: true });
        if (path.basename(abs) !== "log.md") {
          throw new Error("append_log ne s'applique qu'aux fichiers nommés log.md");
        }
        const repo = repoForBundlePath(p);
        return await store.mutate(repo, () => {
          fs.appendFileSync(abs, (line.startsWith("- ") ? line : `- ${line}`) + "\n");
          return ok(`journal mis à jour : ${p}`);
        });
      } catch (e) {
        return fail(e);
      }
    },
  };

  return [readPage, search, writePage, appendLog];
}

export const WIKI_TOOL_NAMES = ["read_page", "search", "write_page", "append_log"];
