// Does createAgentSession({cwd}) — called exactly as react-pi's supervisor does
// (no customTools, no resourceLoader) — discover our extension tools AND load
// AGENTS.md from cwd into the system prompt?
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.join(__dirname, "ws");
const MODEL_ID = process.argv[2] ?? "mistral-medium-latest";

const model = getModel("mistral", MODEL_ID);
if (!model) { console.error("no model"); process.exit(1); }
if (!process.env.MISTRAL_API_KEY) { console.error("no MISTRAL_API_KEY"); process.exit(1); }

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(__dirname, ".pi-agent", "auth.json"),
  modelsPath: path.join(__dirname, ".pi-agent", "models.json"),
});
if (modelRuntime.setRuntimeApiKey) await modelRuntime.setRuntimeApiKey("mistral", process.env.MISTRAL_API_KEY);

// EXACTLY the supervisor's call shape: only cwd, sessionManager, model. Nothing else.
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
  model,
  modelRuntime,
});

// Inspect what tools the agent actually has.
const toolNames = (session.state?.tools ?? session.tools ?? [])
  .map?.((t) => t.name ?? t) ?? "unknown";
console.log("TOOLS VISIBLE TO AGENT:", JSON.stringify(toolNames));

// Try to read the resolved system prompt to see if AGENTS.md was folded in.
try {
  const sp = session.state?.systemPrompt ?? session.systemPrompt;
  if (typeof sp === "string") console.log("SYSTEM PROMPT contains charter marker:", sp.includes("CHARTER_LOADED_9271"));
} catch {}

let out = "";
let toolCalled = "";
session.subscribe((ev) => {
  if (/error/i.test(ev.type)) console.log("ERROR EVENT:", JSON.stringify(ev).slice(0, 400));
  if (ev.type === "message_end") {
    const msg = ev.message ?? ev.assistantMessage ?? ev;
    if (msg?.role && msg.role !== "assistant") return;
    for (const part of msg?.content ?? []) {
      if (part.type === "text") out += part.text;
      if (part.type === "tool_call" || part.type === "tool_use") toolCalled += (part.name ?? part.toolName ?? "?") + " ";
    }
  }
});

try {
  await session.prompt("Bonjour !");
} catch (e) {
  console.log("PROMPT THREW:", e.message);
}
console.log("\n--- ASSISTANT TEXT ---\n" + out);
console.log("tool(s) called by agent:", toolCalled || "(none)");
console.log("\n--- CHECKS ---");
console.log("[integration] extension tool present:", (session.state?.tools ?? []).some?.((t) => (t.name ?? t) === "wiki_marker") ?? "see TOOLS line");
console.log("[integration] charter in system prompt: (see SYSTEM PROMPT line above)");
console.log("[behaviour] charter password emitted:", out.includes("CHARTER_LOADED_9271"));
console.log("[behaviour] wiki_marker called:", toolCalled.includes("wiki_marker"));
console.log("session id:", session.sessionId);
session.dispose();
