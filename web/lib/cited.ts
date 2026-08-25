// Which pages the agent actually touched to build an answer.
//
// Read from the conversation itself rather than reported by the server: the
// tool calls are already in the transcript, and a page the model never opened
// must never be shown as a source. `args` carries the path for read_page and
// write_page; `search` only carries the query, so its hits are parsed out of
// the result text, which the tool formats as `/bundle/path.md:12: la ligne`.
//
// Reserved files are dropped: index.md, log.md, lint.md, AGENTS.md and
// profile.md are not pages in the graph, so highlighting them would point at
// nothing.

/** The shape assistant-ui projects a pi tool call into. */
export interface ToolPart {
  toolName?: unknown;
  args?: unknown;
  result?: unknown;
}

export interface Cited {
  /** Pages the agent consulted. */
  read: string[];
  /** Pages the agent created or changed during this answer. */
  written: string[];
}

const RESERVED = new Set(["index.md", "log.md", "lint.md", "AGENTS.md", "profile.md"]);

const HIT = /^(\/[^\s:]+\.md):\d+:/;

/** A bundle-absolute path to a page that can appear in the graph. */
export function isPagePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.startsWith("/") || !value.endsWith(".md")) return false;
  if (value.includes("..") || value.includes("//")) return false;
  return !RESERVED.has(value.slice(value.lastIndexOf("/") + 1));
}

const pathArg = (args: unknown): string | null => {
  const p = (args as { path?: unknown } | null | undefined)?.path;
  return isPagePath(p) ? p : null;
};

/** Paths named by the lines of a search result. */
function searchHits(result: unknown): string[] {
  if (typeof result !== "string") return [];
  const out: string[] = [];
  for (const line of result.split("\n")) {
    const m = HIT.exec(line);
    if (m && isPagePath(m[1])) out.push(m[1]);
  }
  return out;
}

export function citedPages(parts: readonly ToolPart[]): Cited {
  const read = new Set<string>();
  const written = new Set<string>();

  for (const part of parts) {
    switch (part.toolName) {
      case "read_page": {
        const p = pathArg(part.args);
        if (p) read.add(p);
        break;
      }
      case "search": {
        for (const p of searchHits(part.result)) read.add(p);
        break;
      }
      case "write_page": {
        const p = pathArg(part.args);
        if (p) written.add(p);
        break;
      }
      // append_log only ever touches log.md, which is not a page.
    }
  }

  // A page the agent wrote is shown as written, not as merely read.
  for (const p of written) read.delete(p);
  return { read: [...read], written: [...written] };
}
