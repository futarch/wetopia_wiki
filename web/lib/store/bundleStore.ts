// Where bundles live durably. The working disk is ephemeral (Clever Cloud
// reclaims it on every redeploy), so a write is only safe once its bundle is
// in the store — see WikiStore.flush (upload-before-ACK).
import fs from "node:fs";
import path from "node:path";

export interface StoredBundle {
  /** Sortable key, newest last: `<repo>/<epochMillis padded>-<sha7>.bundle` */
  key: string;
  size: number;
}

export interface BundleStore {
  /** Durably store `filePath` under `key`. Must not resolve before it is safe. */
  put(key: string, filePath: string): Promise<void>;
  /** Newest first. */
  list(repo: string): Promise<StoredBundle[]>;
  /** Copy a stored bundle to a local path so git can read it. */
  fetch(key: string, destFile: string): Promise<void>;
  /** Keep the newest `keep` bundles for `repo`, delete the rest. */
  prune(repo: string, keep: number): Promise<void>;
}

export function bundleKey(repo: string, sha: string, at: number): string {
  return `${repo}/${String(at).padStart(15, "0")}-${sha.slice(0, 7)}.bundle`;
}

/**
 * Filesystem-backed store: used by tests and local dev, and a faithful stand-in
 * for object storage (same key space, same ordering, same fetch/prune shape).
 */
export class LocalBundleStore implements BundleStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private abs(key: string) {
    const p = path.resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) throw new Error(`clé invalide : ${key}`);
    return p;
  }

  async put(key: string, filePath: string): Promise<void> {
    const dest = this.abs(key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Write to a temp name then rename: a reader never sees a half-written bundle.
    const tmp = `${dest}.tmp`;
    fs.copyFileSync(filePath, tmp);
    fs.renameSync(tmp, dest);
  }

  async list(repo: string): Promise<StoredBundle[]> {
    const dir = this.abs(repo);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".bundle"))
      .sort()
      .reverse()
      .map((f) => ({ key: `${repo}/${f}`, size: fs.statSync(path.join(dir, f)).size }));
  }

  async fetch(key: string, destFile: string): Promise<void> {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(this.abs(key), destFile);
  }

  async prune(repo: string, keep: number): Promise<void> {
    const all = await this.list(repo);
    for (const b of all.slice(keep)) fs.rmSync(this.abs(b.key), { force: true });
  }
}
