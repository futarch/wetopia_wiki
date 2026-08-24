// Durable storage for conversation transcripts.
//
// Two decisions this implements:
//  - transcripts are kept (raw material for later), but
//  - they are NOT committed into the wiki bundles. A transcript embeds the full
//    body of every page the agent read plus whatever the user typed, so putting
//    it in git would bloat every snapshot and — because git history is
//    append-only and bundles are immutable — would make erasure impossible.
//
// So they live beside the bundles in the same object store, under their own
// prefix, where a retention policy can simply delete them.
import fs from "node:fs";
import path from "node:path";
import type { BundleStore } from "./bundleStore.ts";

export const SESSIONS_PREFIX = "sessions";

export interface ArchiveReport {
  uploaded: string[];
  skipped: number;
  deleted: string[];
}

/** Every .jsonl under `dir`, as paths relative to it. */
function listTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(path.relative(dir, abs).split(path.sep).join("/"));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/**
 * Upload transcripts that are new or have grown since the last sweep, and drop
 * archived ones older than `retentionDays`.
 *
 * Size is the freshness test on purpose: a session file is append-only while
 * its conversation lives, so a differing size means there is more to keep, and
 * an identical size means re-uploading would be pure cost.
 */
export async function archiveSessions(
  store: BundleStore,
  sessionsDir: string,
  o: { retentionDays?: number; now?: () => number } = {},
): Promise<ArchiveReport> {
  const now = o.now ?? Date.now;
  const stored = new Map<string, number>();
  for (const b of await store.listObjects(SESSIONS_PREFIX)) stored.set(b.key, b.size);

  const report: ArchiveReport = { uploaded: [], skipped: 0, deleted: [] };

  for (const rel of listTranscripts(sessionsDir)) {
    const abs = path.join(sessionsDir, rel);
    const key = `${SESSIONS_PREFIX}/${rel}`;
    const size = fs.statSync(abs).size;
    if (stored.get(key) === size) {
      report.skipped++;
      continue;
    }
    await store.put(key, abs);
    report.uploaded.push(key);
  }

  // Retention: transcripts are the one thing here with an expiry date, so that
  // "we keep everything forever" never becomes the default by accident.
  const days = o.retentionDays ?? 0;
  if (days > 0) {
    const cutoff = now() - days * 86_400_000;
    for (const b of await store.listObjects(SESSIONS_PREFIX)) {
      // Keys carry pi's own timestamp: sessions/<workspace>/<ISO>_<id>.jsonl
      const stamp = /\/(\d{4}-\d{2}-\d{2}T[\d-]+Z)_/.exec(b.key)?.[1];
      if (!stamp) continue;
      const at = Date.parse(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z"));
      if (Number.isFinite(at) && at < cutoff) {
        report.deleted.push(b.key);
      }
    }
    if (report.deleted.length) await store.removeObjects(report.deleted);
  }

  return report;
}
