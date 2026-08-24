// What monitoring needs to know, computed on demand.
//
// The project named its own worst operational risk: "a dead cron discovered a
// month later". So the lint's last run is NOT read from an in-process counter —
// a restart would reset that and report healthy. It is read from the durable
// wiki itself (the [process:lint] line in the shared log), which survives
// redeploys, crashes and restores.
import fs from "node:fs";
import path from "node:path";
import { getWetopia } from "../agent/runtime.ts";
import { SHARED_REPO, repoLayout, userRepo } from "../wiki.ts";

export type Level = "ok" | "warn" | "down";

export interface Check {
  name: string;
  level: Level;
  detail: string;
  [k: string]: unknown;
}

export interface Health {
  status: Level;
  checkedAt: string;
  uptimeSeconds: number;
  checks: Check[];
}

/** The lint must have run within this many hours, or something is wrong. */
const LINT_MAX_AGE_H = Number(process.env.WETOPIA_LINT_MAX_AGE_H ?? 36);

const worst = (levels: Level[]): Level =>
  levels.includes("down") ? "down" : levels.includes("warn") ? "warn" : "ok";

const hoursSince = (t: number) => (Date.now() - t) / 3_600_000;

/** Last `[process:lint]` entry in a bundle's log — the durable heartbeat. */
export function lastLintRun(logFile: string): { at: Date; line: string } | null {
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("[process:lint]"));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^-\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z?)/.exec(last.trim());
  if (!m) return null;
  const at = new Date(m[1].endsWith("Z") ? m[1] : `${m[1]}Z`);
  return Number.isNaN(at.getTime()) ? null : { at, line: last.trim() };
}

/** "12 signalement(s)" from the last report, for a one-glance summary. */
function lastFindingCount(lintFile: string): number | null {
  if (!fs.existsSync(lintFile)) return null;
  const m = /(\d+)\s+signalement/.exec(fs.readFileSync(lintFile, "utf8"));
  return m ? Number(m[1]) : null;
}

export async function computeHealth(): Promise<Health> {
  const checks: Check[] = [];
  let rt: ReturnType<typeof getWetopia> | null = null;
  try {
    rt = getWetopia();
  } catch {
    return {
      status: "down",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: [{ name: "boot", level: "down", detail: "le wiki n'a pas démarré (aucun bundle ouvert)" }],
    };
  }

  // --- boot: how each bundle came up ---
  const restored = rt.openReports.filter((r) => r.source === "restored").length;
  const created = rt.openReports.filter((r) => r.source === "created").length;
  checks.push({
    name: "boot",
    level: "ok",
    detail: `${rt.openReports.length} bundle(s) ouverts : ${restored} restauré(s), ${created} créé(s)`,
    bundles: rt.openReports.map((r) => ({ repo: r.repo, source: r.source, sha: r.sha.slice(0, 7) })),
  });

  // --- durability: are writes actually landing in the store? ---
  const stats = rt.store.getStats();
  const durabilityLevel: Level = stats.lastError ? "down" : stats.pendingWrites > 0 ? "warn" : "ok";
  checks.push({
    name: "durabilite",
    level: durabilityLevel,
    detail: stats.lastError
      ? `échec de sauvegarde : ${stats.lastError}`
      : stats.pendingWrites > 0
        ? `${stats.pendingWrites} écriture(s) non encore sauvegardée(s)`
        : `${stats.flushOk} sauvegarde(s) réussie(s) depuis le démarrage`,
    ...stats,
  });

  // --- bundles: what the durable store actually holds ---
  const users = fs.existsSync(path.join(rt.dataRoot, "users"))
    ? fs.readdirSync(path.join(rt.dataRoot, "users"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const repos = [SHARED_REPO, ...users.map(userRepo)];
  const bundles: Record<string, { count: number; newestAgeHours: number | null }> = {};
  let missing = 0;
  for (const repo of repos) {
    const list = await rt.store.listBundles(repo);
    const newestKey = list[0]?.key ?? "";
    const stamp = Number(/\/(\d{15})-/.exec(newestKey)?.[1] ?? NaN);
    bundles[repo] = {
      count: list.length,
      newestAgeHours: Number.isFinite(stamp) ? Math.round(hoursSince(stamp) * 10) / 10 : null,
    };
    if (!list.length) missing++;
  }
  checks.push({
    name: "bundles",
    // A repo with no bundle at all has no durable copy: that is data at risk.
    level: missing ? "down" : "ok",
    detail: missing
      ? `${missing} bundle(s) sans copie durable`
      : `${repos.length} repo(s) sauvegardés dans le magasin`,
    repos: bundles,
  });

  // --- lint heartbeat, read from the wiki itself ---
  const sharedDir = path.join(rt.dataRoot, repoLayout(SHARED_REPO));
  const last = lastLintRun(path.join(sharedDir, "log.md"));
  const findings = lastFindingCount(path.join(sharedDir, "lint.md"));
  if (!last) {
    checks.push({
      name: "lint",
      level: "warn",
      detail: "le lint nocturne n'a jamais tourné (cron non configuré ?)",
      lastRunAt: null,
    });
  } else {
    const age = hoursSince(last.at.getTime());
    checks.push({
      name: "lint",
      level: age > LINT_MAX_AGE_H ? "warn" : "ok",
      detail:
        age > LINT_MAX_AGE_H
          ? `dernier passage il y a ${Math.round(age)} h (seuil ${LINT_MAX_AGE_H} h) — le cron ne tourne plus ?`
          : `dernier passage il y a ${Math.round(age)} h`,
      lastRunAt: last.at.toISOString(),
      findings,
    });
  }

  // --- configuration mistakes worth catching before they bite ---
  const problems: string[] = [];
  if (!process.env.MISTRAL_API_KEY) problems.push("MISTRAL_API_KEY manquant (aucune conversation possible)");
  if (!process.env.WETOPIA_CRON_SECRET) problems.push("WETOPIA_CRON_SECRET absent : le lint ne peut pas être déclenché");
  const prod = process.env.NODE_ENV === "production";
  if (prod && !process.env.BETTER_AUTH_SECRET) problems.push("BETTER_AUTH_SECRET absent en production");
  if (prod && !(process.env.DATABASE_URL ?? process.env.POSTGRESQL_ADDON_URI)) {
    problems.push("aucune base Postgres : l'auth est sur un SQLite éphémère");
  }
  if (prod && !process.env.WETOPIA_ALLOWED_EMAILS) {
    problems.push("WETOPIA_ALLOWED_EMAILS absent : n'importe qui peut créer un compte");
  }
  checks.push({
    name: "configuration",
    level: problems.length ? (problems[0].includes("MISTRAL") ? "down" : "warn") : "ok",
    detail: problems.length ? problems.join(" · ") : "complète",
  });

  return {
    status: worst(checks.map((c) => c.level)),
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  };
}
