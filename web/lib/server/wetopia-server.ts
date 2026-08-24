// Server-side singletons: the Wetopia runtime and pi's thread supervisor.
import { getPiThreadSupervisor } from "@assistant-ui/react-pi/node";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { boot, getWetopia } from "../agent/runtime.ts";
import { ensureWorkspace, workspacePath } from "../agent/workspace.ts";
import { config } from "./config.ts";
import { migrateAuth } from "./auth.ts";

const KEY = Symbol.for("wetopia.server");
const slot = globalThis as unknown as Record<symbol, Promise<void> | undefined>;

/** Boot the wiki (restore bundles) and pin the supervisor. Idempotent. */
export function ready(): Promise<void> {
  if (!slot[KEY]) {
    slot[KEY] = (async () => {
      // Auth tables first: the app must come up on a fresh machine unattended.
      await migrateAuth();
      await boot({
        dataRoot: config.dataRoot,
        bundleDir: config.bundleDir,
        seedDir: config.seedDir,
        keepBundles: config.keepBundles,
      });

      const apiKey = process.env.MISTRAL_API_KEY;
      if (!apiKey) throw new Error("MISTRAL_API_KEY manquant");
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(config.agentDir, "auth.json"),
        modelsPath: path.join(config.agentDir, "models.json"),
      });
      await (modelRuntime as any).setRuntimeApiKey?.("mistral", apiKey);

      const model = getModel("mistral", config.modelId);
      if (!model) throw new Error(`modèle inconnu : ${config.modelId}`);

      // The supervisor's options are fixed by this first call; the workspace of
      // each conversation is chosen per thread, always server-side.
      getPiThreadSupervisor({ agentDir: config.agentDir, model });
    })().catch((e) => {
      slot[KEY] = undefined; // let the next request retry rather than fail forever
      throw e;
    });
  }
  return slot[KEY]!;
}

export async function supervisor() {
  await ready();
  return getPiThreadSupervisor();
}

export { config, getWetopia };

/**
 * The workspace a conversation runs in — derived from the authenticated wiki id
 * and a validated scope, NEVER from a client-supplied path. Handing the browser
 * control of this would let it name another user's workspace and walk straight
 * through the information barrier.
 */
export async function resolveWorkspace(wikiId: string, scope: unknown): Promise<string> {
  if (scope !== "private" && scope !== "shared") throw new Error("scope invalide");
  await ready();
  // Make sure the private bundle exists before a conversation can touch it.
  await getWetopia().ensureUser(wikiId);
  return ensureWorkspace({ user: wikiId, scope, root: config.workspaceRoot, modelId: config.modelId });
}

/**
 * Users whose private bundle exists on disk — the set the lint must cover.
 * Read from the working tree rather than a list, so a user created after boot
 * is linted the same night.
 */
export function listUsersWithBundles(): string[] {
  const dir = path.join(config.dataRoot, "users");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** Which (user, scope) a workspace path belongs to — for authorising threads. */
export function describeWorkspace(p: string): { user: string; scope: string } | null {
  const rel = path.relative(config.workspaceRoot, p).split(path.sep);
  return rel.length === 2 && !rel[0].startsWith("..") ? { user: rel[0], scope: rel[1] } : null;
}

export { workspacePath };
