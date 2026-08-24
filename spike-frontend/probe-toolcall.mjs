// Ground-truth: prove the cwd-injected custom tool is actually invoked end to end
// (the exact call shape react-pi's supervisor uses: only cwd/sessionManager/model).
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(__dirname, "ws");
const MODEL_ID = process.argv[2] ?? "mistral-medium-latest";
const model = getModel("mistral", MODEL_ID);
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(__dirname, ".pi-agent", "auth.json"),
  modelsPath: path.join(__dirname, ".pi-agent", "models.json"),
});
if (modelRuntime.setRuntimeApiKey) await modelRuntime.setRuntimeApiKey("mistral", process.env.MISTRAL_API_KEY);

const { session } = await createAgentSession({
  cwd, sessionManager: SessionManager.inMemory(cwd), model, modelRuntime, thinkingLevel: "off",
});

await session.prompt('Appelle l\'outil wiki_marker avec note="frontend", puis dis-moi ce qu\'il a renvoyé.');

const msgs = session.state.messages ?? [];
const blob = JSON.stringify(msgs);
const sawToolCall = /"wiki_marker"/.test(blob);
const sawToolResult = /WIKI_TOOL_OK:frontend/.test(blob);
const assistantText = session.getLastAssistantText?.() ?? "";

console.log("messages in transcript:", msgs.length);
console.log("roles:", msgs.map((m) => m.role ?? m.type).join(" → "));
console.log("\n--- CHECKS ---");
console.log("custom tool wiki_marker CALLED:", sawToolCall);
console.log("custom tool RESULT flowed back (WIKI_TOOL_OK:frontend):", sawToolResult);
console.log("assistant final text:", JSON.stringify(assistantText.slice(0, 200)));
console.log("assistant references result:", /WIKI_TOOL_OK|frontend/i.test(assistantText));
session.dispose();
