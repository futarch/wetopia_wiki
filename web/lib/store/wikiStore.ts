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
  /** Map a repo name to its checkout path, relative to workDir. */
  layout?: (repo: string) => string;
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
  private readonly layout?: WikiStoreOptions["layout"];
  private readonly now: () => number;
  /** The single-writer queue: every mutation chains onto this promise. */
  private tail: Promise<unknown> = Promise.resolve();
  /** Repos mutated since the last flush. */
  private readonly dirty = new Set<string>();

  constructor(o: WikiStoreOptions) {
    this.workDir = o.workDir;
    this.store = o.store;
    this.keepBundles = o.keepBundles ?? 30;
    this.seed = o.seed;
    this.layout = o.layout;
    this.now = o.now ?? Date.now;
  }

  /**
   * Where a repo is checked out. Repos are flat names (`shared`,
   * `users-albert`) but the working tree mirrors the wiki's own layout
   * (`shared/`, `users/albert/`) so the path guard sees the bundle paths the
   * charter describes.
   */
  dirFor(repo: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(repo)) throw new Error(`nom de repo invalide : ${repo}`);
    const rel = this.layout ? this.layout(repo) : repo;
    const abs = path.resolve(this.workDir, rel);
    if (abs !== this.workDir && !abs.startsWith(this.workDir + path.sep)) {
      throw new Error(`layout invalide pour ${repo}`);
    }
    return abs;
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

  /**
   * Mutate a repo inside the queue WITHOUT bundling. Used by the agent's tools:
   * a single turn touches the page, the index and the log, and bundling each
   * one separately would upload three full snapshots. Durability is taken at
   * the end of the turn instead — see `flushDirty`, which runs before the user
   * is told the turn is done, so the upload-before-ACK guarantee still holds at
   * the level the user actually perceives.
   */
  async mutate<T>(repo: string, fn: () => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const result = await fn();
      this.dirty.add(repo);
      return result;
    });
  }

  /** Commit + bundle + store every repo touched since the last flush. */
  async flushDirty(message: string): Promise<string[]> {
    return this.enqueue(async () => {
      const flushed: string[] = [];
      for (const repo of [...this.dirty]) {
        const sha = await this.flushNow(repo, message);
        this.dirty.delete(repo);
        if (sha) flushed.push(repo);
      }
      return flushed;
    });
  }

  hasPendingWrites(): boolean {
    return this.dirty.size > 0;
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
