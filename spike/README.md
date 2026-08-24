# Spike — pi + Mistral against the Wetopia charter

Proves the stack's load-bearing assumption: pi's agent loop (SDK, custom
tools only) driving Mistral models against a toy OKF bundle that obeys
`seed/shared/AGENTS.md`.

## Run

```
npm install
MISTRAL_API_KEY=... node run.mjs [model-id]   # default: mistral-medium-latest
```

Resets `data/` from `seed-data/` each run, injects the charter as system
prompt, runs four sessions — shared-scope read+update, private-scope
communal fact (must stay private), private-scope task query, and the
toggle flow (user switches to shared scope and asks to copy their private
note) — then prints a 22-check scorecard: path-guard unit tests, charter
compliance, and privacy canaries.

## Results (2026-08-24, pi-coding-agent 0.84.3, final toggle-only design)

| model | checks | notes |
|---|---|---|
| mistral-medium-latest | 22/22 | consistent across all design iterations; executes, never embellishes |
| mistral-large-latest | variance on earlier variants | drafts instead of acting; hallucinated event details |
| mistral-small-latest | failed earlier variant | dropped private-scope duties; out |

**Model verdict for v0: `mistral-medium-latest`** — the cheaper model is
also the reliable one.

## Findings that shape v0

1. **`tools: []` disables custom tools too** — pass the allowlist of custom
   tool names, else the model silently gets zero tools and hallucinates
   file writes.
2. **The toggle is the only sharing mechanism.** Shared scope writes
   shared; private scope writes private (absolute tool-level guard). To
   share something, the user switches scope and says so — reads cross the
   user's own bundles, so « recopie ma note privée » just works. No agent
   judgment, no promotion machinery, no scanning of private content, ever.
   Charter rule that keeps it tight: in shared scope, private content
   enters shared pages only when the user brings it up — never on the
   agent's initiative.
3. **The capture rule must be explicit.** With shared locked in private
   scope, models dropped communal facts instead of noting them privately.
   Guard error message + runtime context now both say: capture it privately
   anyway.
4. **Deterministic aids beat model discipline.** `write_page` warns when a
   similar page already exists (prevents duplicates, steers to
   update-over-create). Every model failure in this spike was fixed by
   moving a responsibility from the model to the structure.
5. Charter discipline held everywhere else out of the box: surgical edits,
   index+log in the same turn, French human layer / English machine layer,
   session ids in `sources`, no permission-asking, privacy canary never
   leaked.
