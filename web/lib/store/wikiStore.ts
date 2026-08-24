// The wiki's durability layer.
//
// Decisions this encodes (from the pre-build audit):
//  - upload-before-ACK: a write is not acknowledged until its bundle is stored,
//    because the working disk is ephemeral and a redeploy would silently lose it.
//  - one writer: every mutation goes through a single serial queue. The nightly
//    lint runs in this same process/queue, so there is no app-vs-cron split-brain.
//  - restore-on-boot: the working tree is a cache, rebuilt from the newest bundle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BundleStore, bundleKey } from "./bundleStore.ts";
import { commitAll, createBundle, ensureRepo, headSha, restoreFromBundle } from "./git.ts";

export interface WikiStoreOptions {
  /** Ephemeral working directory holding one checkout per repo. */
  workDir: string;
  store: BundleStore;
  /** How many bundles to keep per repo. */
  keepBundles?: number;
  /** Seed a repo the very first time it is created (no bundle exists yet). */
  seed?: (repo: string, dir: string) => void | Promise<void>;
  now?: () => number;
}

export interface OpenReport {
  repo: string;
  source: "restored" | "created";
  key?: string;
  sha: string;
}

export class WikiStore {
  private readonly workDir: string;
  private readonly store: BundleStore;
  private readonly keepBundles: number;
  private readonly seed?: WikiStoreOptions["seed"];
  private readonly now: () => number;
  /** The single-writer queue: every mutation chains onto this promise. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(o: WikiStoreOptions) {
    this.workDir = o.workDir;
    this.store = o.store;
    this.keepBundles = o.keepBundles ?? 30;
    this.seed = o.seed;
    this.now = o.now ?? Date.now;
  }

  dirFor(repo: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) throw new Error(`nom de repo invalide : ${repo}`);
    return path.join(this.workDir, repo);
  }

  /** Rebuild each repo from its newest bundle, or create it fresh. */
  async open(repos: string[]): Promise<OpenReport[]> {
    const reports: OpenReport[] = [];
    for (const repo of repos) {
      const dir = this.dirFor(repo);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      const [newest] = await this.store.list(repo);
      if (newest) {
        const tmp = path.join(os.tmpdir(), `wetopia-${path.basename(newest.key)}`);
        await this.store.fetch(newest.key, tmp);
        await restoreFromBundle(tmp, dir);
        fs.rmSync(tmp, { force: true });
        reports.push({ repo, source: "restored", key: newest.key, sha: await headSha(dir) });
      } else {
        await ensureRepo(dir);
        if (this.seed) await this.seed(repo, dir);
        // flushNow does the commit itself — committing here first would leave it
        // nothing to do, and no initial bundle would ever be written.
        await this.flushNow(repo, "seed initial");
        reports.push({ repo, source: "created", sha: await headSha(dir) });
      }
    }
    return reports;
  }

  /**
   * Run a mutation on `repo` inside the single-writer queue, then durably store
   * the result before resolving. The caller may only acknowledge to the user
   * once this promise settles.
   */
  async write<T>(repo: string, message: string, fn: () => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await fn();
      await this.flushNow(repo, message);
      return result;
    });
  }

  /** Serialize arbitrary work on the writer queue (used by the lint pass). */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** commit → bundle → store → prune. Not queued: callers already hold the queue. */
  private async flushNow(repo: string, message: string): Promise<string | null> {
    const dir = this.dirFor(repo);
    let sha = await commitAll(dir, message);
    if (!sha) {
      // Nothing changed. Still bundle when the repo has no durable copy at all,
      // otherwise a seeded-but-unchanged repo would never reach the store.
      if ((await this.store.list(repo)).length > 0) return null;
      sha = await headSha(dir);
    }
    const tmp = path.join(os.tmpdir(), `wetopia-flush-${repo}-${sha.slice(0, 7)}.bundle`);
    try {
      await createBundle(dir, tmp);
      await this.store.put(bundleKey(repo, sha, this.now()), tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    await this.store.prune(repo, this.keepBundles);
    return sha;
  }
}
