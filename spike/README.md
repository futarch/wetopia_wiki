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
communal fact, private-scope task query, and a night-cycle (lint) pass —
then prints a 21-check scorecard: path-guard unit tests, charter
compliance (index/log discipline, scope isolation, capture rule, profile
update, propositions), and privacy canaries.

## Results (2026-08-24, pi-coding-agent 0.84.3, final design)

| model | checks | tool calls | notes |
|---|---|---|---|
| mistral-medium-latest | 21/21 | 29 | thorough; perfect §9 log lines |
| mistral-large-latest | 21/21 | 15 | half the tool calls for the same result |
| mistral-small-latest | failed earlier variant | — | dropped private-scope duties; out for agent duty |

## Findings that shape v0

1. **`tools: []` disables custom tools too** — pass the allowlist of custom
   tool names (or `noTools: "builtin"`), else the model silently gets zero
   tools and hallucinates file writes.
2. **Sharing is decided by the scope toggle, never by the agent.** Both
   flagship models, unaided, wrote a communal-sounding fact straight to
   `/shared` from a private conversation — evidence that agent judgment is
   the wrong mechanism. Final design: in private scope the tools reject
   `/shared` writes absolutely; the toggle is the only door.
3. **The capture rule must be explicit.** Once shared was locked, models
   *dropped* communal facts instead of noting them privately. The guard's
   error message and the runtime context now both say: capture it in the
   private bundle; the night cycle will handle sharing. After that, no loss.
4. **The night cycle needs a deterministic page listing.** Left to explore,
   the lint trusted `index.md` and missed an unindexed page. Production
   rule: the cron enumerates files and hands the list to the model — the
   model judges content, never coverage.
5. Charter discipline held everywhere else out of the box: surgical edits,
   index+log updated in the same turn, French human layer / English machine
   layer, session ids cited in `sources`, no permission-asking, privacy
   canary never leaked, propositions.md compiled with « À trier / Refusées »
   sections.
