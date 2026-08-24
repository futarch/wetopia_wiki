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
toggle flow (user re-states a fact in a shared-scope conversation) — then
prints a 27-check scorecard: path-guard unit tests, charter compliance,
and privacy canaries on both sides of the barrier.

## Results (2026-08-24, pi-coding-agent 0.84.3, final toggle-only design)

| model | checks | notes |
|---|---|---|
| mistral-medium-latest | 27/27 | consistent across all design iterations; executes, never embellishes |
| mistral-large-latest | variance on earlier variants | drafts instead of acting; hallucinated event details |
| mistral-small-latest | failed earlier variant | dropped private-scope duties; out |

**Model verdict for v0: `mistral-medium-latest`** — the cheaper model is
also the reliable one.

## Findings that shape v0

1. **`tools: []` disables custom tools too** — pass the allowlist of custom
   tool names, else the model silently gets zero tools and hallucinates
   file writes.
2. **Scope is an information barrier, not a write destination.** Private
   scope: read shared + own private, write private only. Shared scope:
   read AND write shared only — private bundles do not exist for the
   agent (reads, search, and even similarity warnings are scope-filtered).
   "Questions become pages" is therefore leak-free by construction: a
   shared page can only contain what shared pages and the conversation
   provide, and the human is the only declassifier — sharing = saying it
   in a shared-scope conversation. A conversation never flips private →
   shared (its context would carry private reads across). Personalization
   in shared scope uses the user's shared Person page, not their private
   profile. Verified live: a canary secret in the private profile never
   reached shared conversations or shared files.
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
