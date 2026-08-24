// Server-side singletons: the Wetopia runtime and pi's thread supervisor.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPiThreadSupervisor } from "@assistant-ui/react-pi/node";
import { getModel } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { boot, getWetopia } from "../agent/runtime.ts";
import { ensureWorkspace, workspacePath } from "../agent/workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

export const config = {
  dataRoot: process.env.WETOPIA_DATA_DIR ?? path.join(REPO_ROOT, "web", "runtime", "data"),
  bundleDir: process.env.WETOPIA_BUNDLE_DIR ?? path.join(REPO_ROOT, "web", "runtime", "bundles"),
  workspaceRoot: process.env.WETOPIA_WORKSPACES ?? path.join(REPO_ROOT, "web", "runtime", "workspaces"),
  agentDir: process.env.WETOPIA_AGENT_DIR ?? path.join(REPO_ROOT, "web", "runtime", "agent"),
  seedDir: path.join(REPO_ROOT, "seed"),
  users: (process.env.WETOPIA_USERS ?? "albert").split(",").map((u) => u.trim()).filter(Boolean),
  modelId: process.env.WETOPIA_MODEL ?? "mistral-medium-latest",
  keepBundles: Number(process.env.WETOPIA_KEEP_BUNDLES ?? 30),
};

const KEY = Symbol.for("wetopia.server");
const slot = globalThis as unknown as Record<symbol, Promise<void> | undefined>;

/** Boot the wiki (restore bundles) and pin the supervisor. Idempotent. */
export function ready(): Promise<void> {
  if (!slot[KEY]) {
    slot[KEY] = (async () => {
      await boot({
        dataRoot: config.dataRoot,
        bundleDir: config.bundleDir,
        users: config.users,
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

      // Pre-create every workspace so the supervisor only ever sees paths we built.
      for (const user of config.users) {
        for (const scope of ["private", "shared"] as const) {
          ensureWorkspace({ user, scope, root: config.workspaceRoot, modelId: config.modelId });
        }
      }

      // Fixing the supervisor's options on first use; workspacePath is chosen
      // per thread, always server-side (see resolveWorkspace).
      getPiThreadSupervisor({
        workspacePath: workspacePath({ user: config.users[0], scope: "private", root: config.workspaceRoot }),
        agentDir: config.agentDir,
        model,
      });
    })().catch((e) => {
      slot[KEY] = undefined; // let the next request retry instead of failing forever
      throw e;
    });
  }
  return slot[KEY]!;
}

export async function supervisor() {
  await ready();
  return getPiThreadSupervisor();
}

export { getWetopia };

/**
 * The workspace a conversation runs in — derived from the authenticated user
 * and a validated scope, NEVER from a client-supplied path. Handing the browser
 * control of this would let it pick another user's workspace and walk straight
 * through the information barrier.
 */
export function resolveWorkspace(user: string, scope: unknown): string {
  if (scope !== "private" && scope !== "shared") throw new Error("scope invalide");
  if (!config.users.includes(user)) throw new Error("utilisateur inconnu");
  return ensureWorkspace({ user, scope, root: config.workspaceRoot, modelId: config.modelId });
}

/** Which (user, scope) a workspace path belongs to — for labelling threads. */
export function describeWorkspace(p: string): { user: string; scope: string } | null {
  const rel = path.relative(config.workspaceRoot, p).split(path.sep);
  return rel.length === 2 && !rel[0].startsWith("..") ? { user: rel[0], scope: rel[1] } : null;
}
