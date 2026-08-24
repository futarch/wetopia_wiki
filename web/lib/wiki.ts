// Naming conventions tying the wiki's bundle paths to the git repos behind them.
//
//   bundle path            repo            checkout dir
//   /shared/...            shared          <work>/shared
//   /users/albert/...      users-albert    <work>/users/albert
import path from "node:path";

export const SHARED_REPO = "shared";

export const userRepo = (user: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(user)) throw new Error(`identifiant utilisateur invalide : ${user}`);
  return `users-${user}`;
};

/** Checkout path of a repo, relative to the working directory. */
export const repoLayout = (repo: string): string =>
  repo === SHARED_REPO ? SHARED_REPO : path.join("users", repo.slice("users-".length));

/** Which repo a bundle-absolute path belongs to. */
export function repoForBundlePath(p: string): string {
  if (p.startsWith("/shared/") || p === "/shared") return SHARED_REPO;
  const m = /^\/users\/([^/]+)(\/|$)/.exec(p);
  if (m) return userRepo(m[1]);
  throw new Error(`chemin hors bundles connus : ${p}`);
}

/** The repos one conversation may touch, given its scope. */
export function reposForScope(user: string, scope: "private" | "shared"): string[] {
  return scope === "shared" ? [SHARED_REPO] : [SHARED_REPO, userRepo(user)];
}
