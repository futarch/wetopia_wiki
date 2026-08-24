// A pi workspace is the only configuration channel react-pi's supervisor gives
// us (it forwards `cwd` and nothing else). One workspace per (user, scope):
//
//   AGENTS.md              the charter + this conversation's runtime context
//   .pi/settings.json      built-in tools OFF, thinking OFF  (see below)
//   .pi/extensions/*.ts    registers our four tools, bound to (user, scope)
//
// Two settings are load-bearing, both proven in spike-frontend:
//  - defaultTools: without it the agent keeps pi's built-in bash/edit/write,
//    which would sidestep the path guard entirely. Security-critical.
//  - defaultThinkingLevel "off": Mistral rejects the supervisor's default with
//    400 "Reasoning prompt mode is not enabled for this model".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WIKI_TOOL_NAMES } from "./tools.ts";
import { getWetopia } from "./runtime.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_MODULE = path.join(HERE, "extension.ts");

export interface WorkspaceSpec {
  user: string;
  scope: "private" | "shared";
  /** Directory under which workspaces are materialised. */
  root: string;
  today?: string;
  modelId?: string;
}

export function workspacePath({ root, user, scope }: WorkspaceSpec): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(user)) throw new Error(`identifiant utilisateur invalide : ${user}`);
  if (scope !== "private" && scope !== "shared") throw new Error(`scope invalide : ${scope}`);
  return path.join(root, user, scope);
}

/** Create (or refresh) the workspace directory and return its path. */
export function ensureWorkspace(spec: WorkspaceSpec): string {
  const { user, scope } = spec;
  const dir = workspacePath(spec);
  fs.mkdirSync(path.join(dir, ".pi", "extensions"), { recursive: true });

  fs.writeFileSync(path.join(dir, "AGENTS.md"), buildCharter(spec));

  fs.writeFileSync(
    path.join(dir, ".pi", "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "off", defaultTools: WIKI_TOOL_NAMES }, null, 2) + "\n",
  );

  fs.writeFileSync(
    path.join(dir, ".pi", "extensions", "wetopia.ts"),
    `// Généré par Wetopia — ne pas éditer.
import { Type } from "typebox";
import { registerWetopia } from ${JSON.stringify(EXTENSION_MODULE)};

export default function (pi: any) {
  registerWetopia(pi, Type, ${JSON.stringify(user)}, ${JSON.stringify(scope)});
}
`,
  );

  return dir;
}

/** The charter, plus the runtime facts the agent needs for this conversation. */
export function buildCharter(spec: WorkspaceSpec): string {
  const { user, scope } = spec;
  const { charter } = getWetopia();
  const today = spec.today ?? new Date().toISOString().slice(0, 10);
  const model = spec.modelId ?? "mistral-medium-latest";

  const scopeNote =
    scope === "private"
      ? `- Tu vois : /shared (lecture) et /users/${user} (lecture + écriture).
- Toute écriture va dans /users/${user}. Un fait durable est capturé même s'il
  semble communal ; pour écrire dans le wiki partagé, l'utilisateur bascule la
  conversation en scope partagé.`
      : `- Tu vois : /shared uniquement, en lecture et en écriture.
- Les bundles privés n'existent pas dans cette conversation. Tout ce que tu
  écris ici ne peut venir que de /shared et de cette conversation.`;

  return `${charter}

---

## Contexte d'exécution (fourni par l'application Wetopia)

- date : ${today}
- utilisateur : human:${user}
- scope de la conversation : ${scope}
${scopeNote}
- outils : ${WIKI_TOOL_NAMES.join(", ")} — chemins absolus de bundle uniquement.
- identifiant de modèle pour « generated.by » : wetopia-agent/${model}
`;
}
