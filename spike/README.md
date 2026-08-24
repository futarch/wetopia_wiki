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
communal fact (must stay private), private-scope task query, and an
explicit-instruction share (« note-la pour tout le monde ») — then prints
a 22-check scorecard: path-guard unit tests, charter compliance, and
privacy canaries.

## Results (2026-08-24, pi-coding-agent 0.84.3, final design)

| model | checks | notes |
|---|---|---|
| mistral-medium-latest | 22/22 | consistent across all design iterations; executes, never embellishes |
| mistral-large-latest | 18–20/22, variance | drafts instead of acting; hallucinated event details (invented a programme the user never said) |
| mistral-small-latest | failed earlier variant | dropped private-scope duties; out |

**Model verdict for v0: `mistral-medium-latest`** — the cheaper model is
also the reliable one.

## Findings that shape v0

1. **`tools: []` disables custom tools too** — pass the allowlist of custom
   tool names, else the model silently gets zero tools and hallucinates
   file writes.
2. **Users alone decide private vs shared.** The toggle sets the
   destination; in private scope the tools reject `/shared` writes
   absolutely. The only other door is the user's explicit instruction,
   executed via `share_page`, which can only publish an existing private
   page verbatim — it cannot smuggle new content. No process (agent or
   lint) scans private content to suggest sharing.
3. **The capture rule must be explicit.** Once shared was locked, models
   dropped communal facts instead of noting them privately. Guard error
   message + runtime context now both say: capture it privately anyway.
4. **Deterministic bookkeeping beats model discipline.** `share_page`
   updates logs and indexes on both sides itself; `write_page` warns when
   a similar page exists (prevents duplicates, steers to update-over-create).
   Every model failure in this spike was fixed by moving a responsibility
   from the model to the structure.
5. Charter discipline held everywhere else out of the box: surgical edits,
   index+log in the same turn, French human layer / English machine layer,
   session ids in `sources`, no permission-asking, privacy canary never
   leaked.
