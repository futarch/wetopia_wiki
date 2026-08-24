// Deployment configuration, in one place so nothing else reads process.env.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const RUNTIME = process.env.WETOPIA_RUNTIME ?? path.join(REPO_ROOT, "web", "runtime");

/**
 * pi resolves its own storage from PI_CODING_AGENT_DIR, falling back to
 * ~/.pi/agent. The thread supervisor builds its SessionManager internally, so
 * the per-session `agentDir` option does NOT move transcripts: without this,
 * every conversation is written to the root user's home directory, outside the
 * runtime we manage and back up. Set before any pi module resolves a path.
 */
const AGENT_DIR = process.env.WETOPIA_AGENT_DIR ?? path.join(RUNTIME, "agent");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

export const config = {
  /** Ephemeral working disk: repo checkouts. Rebuilt from bundles on boot. */
  dataRoot: process.env.WETOPIA_DATA_DIR ?? path.join(RUNTIME, "data"),
  /** Durable bundle store (a Cellar bucket in production). */
  bundleDir: process.env.WETOPIA_BUNDLE_DIR ?? path.join(RUNTIME, "bundles"),
  /** Generated pi workspaces, one per (user, scope). */
  workspaceRoot: process.env.WETOPIA_WORKSPACES ?? path.join(RUNTIME, "workspaces"),
  /** pi's own config/session directory. */
  agentDir: AGENT_DIR,
  /** Where pi writes conversation transcripts (JSONL), under agentDir. */
  sessionsDir: path.join(AGENT_DIR, "sessions"),
  /** Auth state (SQLite) when no DATABASE_URL is configured. */
  authDbFile: process.env.WETOPIA_AUTH_DB ?? path.join(RUNTIME, "auth.sqlite"),
  /** Initial content for a fresh install. */
  seedDir: path.join(REPO_ROOT, "seed"),
  modelId: process.env.WETOPIA_MODEL ?? "mistral-medium-latest",
  transcriptionModel: process.env.WETOPIA_TRANSCRIPTION_MODEL ?? "voxtral-mini-latest",
  keepBundles: Number(process.env.WETOPIA_KEEP_BUNDLES ?? 30),
  /** Transcripts are deleted after this many days. 0 = keep for ever. */
  sessionRetentionDays: Number(process.env.WETOPIA_SESSION_RETENTION_DAYS ?? 90),
};
