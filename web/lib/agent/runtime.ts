// The process-wide Wetopia runtime: one WikiStore, one write queue, one truth.
//
// Pinned to globalThis rather than module scope on purpose. The pi extension
// loads this module through an absolute path and Next.js reloads modules in
// dev; either could otherwise produce a second WikiStore, and two queues would
// break the single-writer invariant the durability design depends on.
import fs from "node:fs";
import path from "node:path";
import { LocalBundleStore, type BundleStore } from "../store/bundleStore.ts";
import { WikiStore } from "../store/wikiStore.ts";
import { SHARED_REPO, repoLayout, userRepo } from "../wiki.ts";

export interface Wetopia {
  store: WikiStore;
  dataRoot: string;
  charter: string;
  /** Open (restore or create) a user's private bundle. Idempotent. */
  ensureUser: (wikiId: string) => Promise<void>;
}

const KEY = Symbol.for("wetopia.runtime");
const slot = globalThis as unknown as Record<symbol, Wetopia | undefined>;

export interface BootOptions {
  /** Ephemeral working directory holding the repo checkouts. */
  dataRoot: string;
  /** Durable bundle store. Defaults to a local directory (dev/tests). */
  store?: BundleStore;
  bundleDir?: string;
  /** Private bundles to open at boot. Others are opened on first sign-in. */
  users?: string[];
  /** Directory holding the initial content for a fresh install. */
  seedDir: string;
  keepBundles?: number;
}

/** Restore (or create) every bundle and pin the runtime. Idempotent per process. */
export async function boot(o: BootOptions): Promise<Wetopia> {
  const existing = slot[KEY];
  if (existing) return existing;

  const seedShared = path.join(o.seedDir, "shared");
  const store = new WikiStore({
    workDir: o.dataRoot,
    store: o.store ?? new LocalBundleStore(o.bundleDir ?? path.join(o.dataRoot, "..", "bundles")),
    keepBundles: o.keepBundles ?? 30,
    layout: repoLayout,
    seed: (repo, dir) => {
      if (repo === SHARED_REPO) {
        fs.cpSync(seedShared, dir, { recursive: true });
      } else {
        const user = repo.slice("users-".length);
        fs.writeFileSync(path.join(dir, "index.md"), `# Index — bundle privé de ${user}\n`);
        fs.writeFileSync(path.join(dir, "log.md"), `# Journal — bundle privé de ${user}\n`);
        fs.writeFileSync(
          path.join(dir, "profile.md"),
          `---\ntype: Person\ntitle: "${user}"\ndescription: "Profil privé de ${user}."\nstatus: draft\n---\n\n## Contexte\n\n(à compléter au fil des conversations)\n`,
        );
      }
    },
  });

  const opened = new Set<string>();
  const repos = [SHARED_REPO, ...(o.users ?? []).map(userRepo)];
  await store.open(repos);
  for (const r of repos) opened.add(r);

  // A private bundle is created the first time its owner signs in, so accounts
  // are not a fixed list baked into the deployment.
  let chain: Promise<void> = Promise.resolve();
  const ensureUser = (wikiId: string): Promise<void> => {
    const repo = userRepo(wikiId);
    if (opened.has(repo)) return Promise.resolve();
    chain = chain.then(async () => {
      if (opened.has(repo)) return;
      await store.open([repo]);
      opened.add(repo);
    });
    return chain;
  };

  const charterFile = path.join(o.dataRoot, "shared", "AGENTS.md");
  if (!fs.existsSync(charterFile)) throw new Error(`charte absente du bundle partagé : ${charterFile}`);

  const runtime: Wetopia = {
    store,
    dataRoot: o.dataRoot,
    charter: fs.readFileSync(charterFile, "utf8"),
    ensureUser,
  };
  slot[KEY] = runtime;
  return runtime;
}

/** The booted runtime. Throws if the server never booted — never boots implicitly. */
export function getWetopia(): Wetopia {
  const rt = slot[KEY];
  if (!rt) throw new Error("runtime Wetopia non démarré (appeler boot() au démarrage du serveur)");
  return rt;
}

/** Test helper: forget the pinned runtime. */
export function resetWetopia(): void {
  slot[KEY] = undefined;
}
