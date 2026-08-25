// Authentication (BetterAuth) and the mapping from an account to its wiki identity.
//
// Two databases on purpose: auth state lives in SQL (the only thing that truly
// does not belong in git), the wiki lives in git. Postgres in production
// (DATABASE_URL); a local SQLite file otherwise, so the app runs and is testable
// with no service to stand up.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { config } from "./config.ts";

const require = createRequire(import.meta.url);

/**
 * Clever Cloud injects POSTGRESQL_ADDON_URI when a Postgres add-on is linked.
 * Reading it directly beats copying the URI into DATABASE_URL by hand: one
 * fewer duplicated secret, and rotating the add-on's credentials keeps working.
 */
export const databaseUrl = (): string | undefined =>
  process.env.DATABASE_URL ?? process.env.POSTGRESQL_ADDON_URI;

function database() {
  const url = databaseUrl();
  if (url) {
    // Postgres (Clever Cloud add-on) — auth state only.
    const { Pool } = require("pg");
    return new Pool({ connectionString: url });
  }
  const Database = require("better-sqlite3");
  fs.mkdirSync(path.dirname(config.authDbFile), { recursive: true });
  return new Database(config.authDbFile);
}

export const authOptions = {
  database: database(),
  emailAndPassword: {
    enabled: true,
    // No email service in v0 (a deliberate cut): no magic links, no reset mail.
    requireEmailVerification: false,
    minPasswordLength: 10,
  },
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-in-production",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  user: {
    additionalFields: {
      // The account's wiki identity (see resolveWikiId). `input: false` is the
      // load-bearing part: this value becomes a path segment and the name of a
      // private bundle, so no client may ever propose one — a chosen wikiId
      // would be a chosen place in someone else's wiki.
      wikiId: { type: "string" as const, required: false, input: false },
    },
  },
  plugins: [nextCookies()],
} satisfies Parameters<typeof betterAuth>[0];

export const auth = betterAuth(authOptions);

/**
 * Create/extend the auth tables. Run at server boot so a fresh deployment (or a
 * fresh dev machine) comes up without a manual migration step.
 */
const MIGRATED = Symbol.for("wetopia.auth.migrated");
const migrationSlot = globalThis as unknown as Record<symbol, Promise<void> | undefined>;
export function migrateAuth(): Promise<void> {
  if (!migrationSlot[MIGRATED]) {
    migrationSlot[MIGRATED] = (async () => {
      const { getMigrations } = await import("better-auth/db/migration");
      const { runMigrations } = await getMigrations(authOptions);
      await runMigrations();
    })().catch((e) => {
      migrationSlot[MIGRATED] = undefined;
      throw e;
    });
  }
  return migrationSlot[MIGRATED]!;
}

/**
 * Who may create an account.
 *
 * WETOPIA_ALLOWED_EMAILS is a comma-separated allowlist. Left unset, sign-up is
 * open — convenient on a laptop, wrong on the internet, which is why
 * /api/health raises it as a warning in production.
 */
export function signUpAllowed(email: string): boolean {
  const raw = process.env.WETOPIA_ALLOWED_EMAILS?.trim();
  if (!raw) return true;
  const wanted = email.trim().toLowerCase();
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}

/** Filesystem-safe slug. This value becomes a path segment, hence the rigour. */
function slugify(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

const usableWikiId = (s: string): boolean => /^[a-z0-9][a-z0-9-]*$/.test(s);

export interface Account {
  id: string;
  name?: string | null;
  email?: string | null;
  wikiId?: unknown;
}

/**
 * Names to try for a new wiki identity, best first: the person's name, so a
 * bundle reads as `users/sarah-fasiliabas`; failing that the email's local
 * part; failing that the account id, which cannot collide and cannot be empty.
 */
export function wikiIdCandidates(user: Account): string[] {
  const out: string[] = [];
  for (const raw of [user.name ?? "", (user.email ?? "").split("@")[0] ?? ""]) {
    const s = slugify(raw);
    if (usableWikiId(s) && !out.includes(s)) out.push(s);
  }
  out.push(`u-${user.id.replace(/[^a-z0-9]/gi, "").slice(0, 24).toLowerCase()}`);
  return out;
}

/**
 * The wiki identity of an account: the slug naming its private bundle.
 *
 * Assigned once, at first sight, then stored and never recomputed. That is the
 * whole point: this is a path segment and the name of a git bundle, so it must
 * not follow someone who edits their display name — they would silently land in
 * an empty wiki while their own was left stranded.
 *
 * The uniqueness check is best-effort: two accounts whose very first request
 * arrives at the same instant with the same candidate could both take it. It
 * needs identical names and simultaneous first sign-ins; the cost is a shared
 * bundle, which the guard still keeps inside `/users/<id>`.
 */
export async function resolveWikiId(user: Account): Promise<string> {
  const stored = typeof user.wikiId === "string" ? user.wikiId : "";
  if (usableWikiId(stored)) return stored;

  const ctx = await auth.$context;
  for (const candidate of wikiIdCandidates(user)) {
    const taken = await ctx.adapter.findMany({
      model: "user",
      where: [{ field: "wikiId", value: candidate }],
      limit: 1,
    });
    if (taken.length) continue;
    await ctx.internalAdapter.updateUser(user.id, { wikiId: candidate });
    return candidate;
  }
  throw new Error("aucun identifiant de wiki disponible");
}

export interface Viewer {
  wikiId: string;
  email: string;
  name?: string;
}

/** The signed-in viewer, or null. The only source of identity in the app. */
export async function currentViewer(headers: Headers): Promise<Viewer | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return {
    wikiId: await resolveWikiId(session.user),
    email: session.user.email ?? "",
    name: session.user.name ?? undefined,
  };
}
