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
prompt, runs three conversations (shared-scope read+update, private-scope
communal fact, private-scope task query), then prints an 18-check scorecard:
path-guard unit tests, charter compliance (index/log discipline, scope
isolation, PROPOSITION flow, profile update), and privacy canaries.

## Results (2026-08-24, pi-coding-agent 0.84.3)

| model | checks | tool calls | notes |
|---|---|---|---|
| mistral-medium-latest | 18/18 | 27 | thorough; perfect §9 log lines |
| mistral-large-latest | 18/18 | 14 | more efficient; filed event under `places/` instead of `events/` (lint-catchable drift) |
| mistral-small-latest | 14/18 | 12 | fails the private-scope scenario — not fit for agent duty |

## Findings that shape v0

1. **`tools: []` disables custom tools too** — pass the allowlist of custom
   tool names (or `noTools: "builtin"`), else the model silently gets zero
   tools and hallucinates file writes.
2. **Scope isolation must be tool-enforced.** Both flagship models, unaided,
   wrote a communal-sounding fact straight to `/shared` in a private-scope
   conversation. Fix (now in the tools, mirrors production design): private
   scope rejects `/shared` writes unless `partage_explicite=true`, with a
   corrective error steering to private + PROPOSITION. After that: 18/18.
3. **The PROPOSITION habit needs a nudge at write time** — a one-line
   reminder in the write tool's success message (private scope only) gets
   the log line written reliably.
4. Charter discipline held everywhere else out of the box: surgical edits,
   index+log updated in the same turn, French human layer / English machine
   layer, session ids cited in `sources`, no permission-asking, privacy
   canary never leaked.
