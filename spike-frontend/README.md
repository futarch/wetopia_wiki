# Spike frontend — @assistant-ui/react-pi (0.0.19)

De-risks the frontend integration: can react-pi drive an agent that uses
**our** wiki tools + charter + Mistral, not pi's default coding agent?

## Run

```
npm install
MISTRAL_API_KEY=... node probe-cwd-injection.mjs   # tools + charter injected via cwd
MISTRAL_API_KEY=... node probe-toolcall.mjs        # custom tool called end to end
MISTRAL_API_KEY=... node probe-settings.mjs        # settings.json disables built-ins + thinking off
```

## Architecture (from reading the package)

- **Browser**: `usePiRuntime` + `createPiHttpClient` + `openPiEventStream`
  (SSE). The browser talks to the server over HTTP + Server-Sent Events.
- **Server**: `PiThreadSupervisor` / `createPiNodeClient` runs pi in-process,
  one `AgentSession` per thread, keyed by `workspacePath` (per-thread `cwd`).
- react-pi ships **both ends but not the HTTP route glue** — the app mounts
  the supervisor behind its own Next.js routes (standard assistant-ui glue).

## The load-bearing finding

`PiThreadSupervisor.openSession` calls
`createAgentSession({ cwd, sessionManager, agentDir?, model? })` — **no
`customTools`, no `tools`, no `resourceLoader`, no `thinkingLevel`**
(`node/ThreadSupervisor.js:244`). Out of the box react-pi therefore runs
pi's **default coding agent** (read/bash/edit/write + default prompt), which
is wrong and unsafe for Wetopia.

**But everything we need is driven through the workspace `cwd`, which the
supervisor already forwards — so react-pi is usable UNMODIFIED:**

| need | mechanism | proof |
|---|---|---|
| custom wiki tools | pi extension at `<cwd>/.pi/extensions/*.ts` (`pi.registerTool`) | `wiki_marker` present in agent tools; called end to end (user→assistant→toolResult→assistant) |
| charter as system prompt | `AGENTS.md` at `<cwd>` root | resolved system prompt contains the charter marker |
| **disable built-in bash/write** (security) | `defaultTools: [...]` in `<cwd>/.pi/settings.json` | tools reduced to `["wiki_marker"]`, built-ins gone |
| Mistral compatibility | `defaultThinkingLevel: "off"` in settings.json | fixes `Mistral API 400: "Reasoning prompt mode is not enabled"` |

## Findings that shape the core loop

1. **Built-in tools MUST be disabled** via `defaultTools`. An agent with pi's
   default `bash`/`write` in the app's working dir would bypass our entire
   bundle-path guard. Non-negotiable.
2. **`defaultThinkingLevel: "off"` is required for Mistral.** Without it, the
   supervisor's default triggers a 400 on every tool-calling turn against
   `mistral-medium-latest`. (Confirms the backend spike, where we set
   `thinkingLevel: "off"` explicitly.)
3. **Per-thread `workspacePath` is the natural scope boundary.** The
   supervisor accepts a `workspacePath` per thread → a shared-scope
   conversation gets a cwd/workspace exposing only `/shared`; a private-scope
   one gets shared+private. This maps directly onto the audit's CRITIQUE 2
   (scope must be per-session, not a global) and onto our information
   barrier — enforced by which workspace the conversation runs in, plus the
   tool path guard within it.
4. **Not run here**: the browser↔SSE↔server round trip (standard assistant-ui
   glue, app-provided routes, low risk, not Wetopia-specific). To wire during
   the core loop, not a risk to the stack.

## Verdict

**GO.** react-pi integrates our custom-tool + charter + Mistral agent with
**zero patch** — all config flows through the per-conversation workspace
`cwd` (extension + `AGENTS.md` + `settings.json`). The frontend stack is
validated; what remains is ordinary web plumbing.
