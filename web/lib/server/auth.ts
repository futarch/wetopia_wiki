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

function database() {
  if (process.env.DATABASE_URL) {
    // Postgres (Clever Cloud add-on) — auth state only.
    const { Pool } = require("pg");
    return new Pool({ connectionString: process.env.DATABASE_URL });
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

/**
 * The wiki identity of an account: a stable, filesystem-safe slug used to name
 * the private bundle. Derived from the email local part so bundles stay
 * human-readable (`users/albert-dessaint`), and validated because this value
 * becomes a path segment.
 */
export function wikiIdFor(user: { email?: string | null; id: string }): string {
  const base = (user.email ?? "").split("@")[0] ?? "";
  const slug = base
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (/^[a-z0-9][a-z0-9-]*$/.test(slug)) return slug;
  // Fall back to the account id, sanitised, rather than inventing a name.
  return `u-${user.id.replace(/[^a-z0-9]/gi, "").slice(0, 24).toLowerCase()}`;
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
    wikiId: wikiIdFor(session.user),
    email: session.user.email ?? "",
    name: session.user.name ?? undefined,
  };
}
