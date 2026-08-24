import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import path from "node:path"; import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(__dirname, "ws");
const model = getModel("mistral", "mistral-medium-latest");
const modelRuntime = await ModelRuntime.create({ authPath: path.join(__dirname,".pi-agent","auth.json"), modelsPath: path.join(__dirname,".pi-agent","models.json") });
if (modelRuntime.setRuntimeApiKey) await modelRuntime.setRuntimeApiKey("mistral", process.env.MISTRAL_API_KEY);
// EXACTLY the supervisor's call shape — only cwd/sessionManager/model. No thinkingLevel, no tools.
const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), model, modelRuntime });
console.log("TOOLS:", JSON.stringify((session.state.tools ?? []).map(t => t.name ?? t)));
await session.prompt('Appelle wiki_marker avec note="viasettings".');
const blob = JSON.stringify(session.state.messages);
console.log("built-ins disabled (only wiki_marker):", JSON.stringify((session.state.tools ?? []).map(t=>t.name??t)) === '["wiki_marker"]');
console.log("thinking off (no 400, tool ran):", /WIKI_TOOL_OK:viasettings/.test(blob));
console.log("errorMessage:", session.state.errorMessage ?? "(none)");
session.dispose();
