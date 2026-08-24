// Git operations on one wiki bundle (a repo on the ephemeral working disk).
// Git is the database; bundles are how it survives the disk.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const AUTHOR = ["-c", "user.name=Wetopia", "-c", "user.email=agent@wetopia.local"];

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...AUTHOR, ...args], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Create the repo if absent; guarantee at least one commit so it can be bundled. */
export async function ensureRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await git(dir, ["init", "-q", "-b", "main"]);
  }
  const hasCommit = await git(dir, ["rev-list", "-n", "1", "--all"]).catch(() => "");
  if (!hasCommit) {
    // An empty repo cannot be bundled: seed it.
    const keep = path.join(dir, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "init"]);
  }
}

/** Stage everything and commit. Returns the new sha, or null when nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, ["add", "-A"]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  await git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export async function headSha(dir: string): Promise<string> {
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Pack the whole repo (history included) into a single portable file. */
export async function createBundle(dir: string, outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await git(dir, ["bundle", "create", outFile, "--all"]);
}

/** Rebuild a working repo from a bundle. The target must not already exist. */
export async function restoreFromBundle(bundleFile: string, dir: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) throw new Error(`restore: ${dir} existe déjà`);
  await exec("git", [...AUTHOR, "clone", "-q", bundleFile, dir], { maxBuffer: 32 * 1024 * 1024 });
  // A clone from a bundle keeps the bundle as `origin`; drop it so nothing
  // later mistakes a stale local file for an upstream.
  await git(dir, ["remote", "remove", "origin"]).catch(() => {});
}

/** True when the working tree has uncommitted changes. */
export async function isDirty(dir: string): Promise<boolean> {
  return (await git(dir, ["status", "--porcelain"])) !== "";
}
