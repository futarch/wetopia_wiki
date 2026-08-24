// The security boundary of Wetopia, isolated so it can be tested on its own
// (no model, no API key) and reused verbatim by the app.
//
// Three rules, learned from the pre-build audit:
//   1. Every check runs on the RESOLVED path. Checking the raw string lets
//      "..", "/./" and "//" desynchronise what is checked from what is opened.
//   2. user + scope live in a per-session closure, never in a module global,
//      so concurrent conversations cannot borrow each other's permissions.
//   3. The deepest existing ancestor is realpath'd, so a symlink committed into
//      a bundle cannot straddle the barrier.
import fs from "node:fs";
import path from "node:path";

export interface SessionContext {
  user: string;
  scope: "private" | "shared";
  dataRoot: string;
  sharedRoot: string;
  privateRoot: string;
  readRoots: string[];
  writeRoots: string[];
  resolveBundlePath: (p: string, opts?: { forWrite?: boolean }) => string;
}

export const within = (abs, root) => abs === root || abs.startsWith(root + path.sep);

/** Resolve symlinks on the deepest existing ancestor, keeping the missing tail. */
export const realResolve = (abs) => {
  const tail = [];
  let cur = abs;
  for (;;) {
    if (fs.existsSync(cur)) {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
};

/**
 * Build the security context for ONE conversation.
 * @param {object} o
 * @param {string} o.dataRoot  filesystem root holding `shared/` and `users/`
 * @param {string} o.user      the conversation's user id
 * @param {"private"|"shared"} o.scope
 */
export function createSessionContext({ dataRoot, user, scope }) {
  if (scope !== "private" && scope !== "shared") throw new Error(`scope invalide : ${scope}`);
  if (!user || /[/\\]/.test(user)) throw new Error(`user invalide : ${user}`);

  const sharedRoot = path.join(dataRoot, "shared");
  const usersRoot = path.join(dataRoot, "users");
  const privateRoot = path.join(usersRoot, user);

  // Charter §3, as roots per direction of access. Shared scope simply has no
  // private root: private bundles do not exist for that conversation.
  const readRoots = scope === "shared" ? [sharedRoot] : [sharedRoot, privateRoot];
  const writeRoots = scope === "shared" ? [sharedRoot] : [privateRoot];

  const isCharter = (abs) =>
    path.dirname(abs) === sharedRoot && path.basename(abs).toLowerCase() === "agents.md";

  const resolveBundlePath = (p, { forWrite = false } = {}) => {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) {
      throw new Error(`chemin invalide « ${p} » — utilise un chemin absolu de bundle, ex. /shared/index.md`);
    }
    const abs = realResolve(path.resolve(dataRoot, "." + p));

    if (forWrite) {
      if (isCharter(abs)) {
        throw new Error("AGENTS.md est protégé — la charte ne se modifie pas par l'agent (§13)");
      }
      if (!writeRoots.some((r) => within(abs, r))) {
        if (scope === "private" && within(abs, sharedRoot)) {
          throw new Error(
            `conversation en scope privé : toute écriture va dans /users/${user} (charte §10). ` +
            `Note ce contenu dans /users/${user} ; pour écrire dans le wiki partagé, ` +
            `l'utilisateur bascule la conversation en scope partagé.`
          );
        }
        throw new Error(`accès refusé en écriture : ${p}`);
      }
      return abs;
    }

    if (!readRoots.some((r) => within(abs, r))) {
      if (scope === "shared" && within(abs, usersRoot)) {
        throw new Error(
          "conversation en scope partagé : les bundles privés sont inaccessibles (charte §3). " +
          "Seul le contenu de /shared et de cette conversation existe ici."
        );
      }
      throw new Error(`accès refusé : ${p}`);
    }
    return abs;
  };

  return { user, scope, dataRoot, sharedRoot, privateRoot, readRoots, writeRoots, resolveBundlePath };
}
