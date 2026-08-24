# Spike — pi + Mistral against the Wetopia charter

Proves the stack's load-bearing assumption: pi's agent loop (SDK, custom
tools only) driving Mistral models against a toy OKF bundle that obeys
`seed/shared/AGENTS.md`.

## Run

```
npm install
npm test                                      # guard suite: deterministic, no API key, ~50ms
MISTRAL_API_KEY=... node run.mjs [model-id]   # behaviour: live, default mistral-medium-latest
```

`guard.mjs` holds the security boundary on its own (one source of truth, meant to
be lifted verbatim into the app); `guard.test.mjs` is its regression suite —
**30 checks including every bypass payload the pre-build audit proved**. It needs
no model, so it runs on every commit.

Resets `data/` from `seed-data/` each run, injects the charter as system
prompt, runs four sessions — shared-scope read+update, private-scope
communal fact (must stay private), private-scope task query, and the
toggle flow (user re-states a fact in a shared-scope conversation) — then
prints a 27-check scorecard: path-guard unit tests, charter compliance,
and privacy canaries on both sides of the barrier.

## Results (2026-08-24, pi-coding-agent 0.84.3, final toggle-only design)

| suite | result | notes |
|---|---|---|
| `guard.test.mjs` (deterministic) | 30/30 | barrier, traversals, symlinks, charter, isolation |
| `run.mjs` behaviour, mistral-medium-latest | 20/20 | consistent across all design iterations; executes, never embellishes |
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


## Hardening after the pre-build audit (2026-08-24)

An adversarial design audit found the guard was checking the **raw** path string
while opening the **resolved** one — three payloads (`..`, `/./`, `//`) defeated
the barrier, proven with a deterministic PoC. Fixed and locked down by tests:

- **CRITIQUE 1 — resolved-path checks only.** Every decision now runs on the
  resolved path. Closed: shared-scope reads of private bundles, private-scope
  writes into `/shared`, charter overwrite (incl. case variants), cross-user
  traversal, null bytes.
- **CRITIQUE 2 — no ambient scope.** `user`/`scope` live in a per-session
  closure (`createSessionContext`), and tools are built per session
  (`createWikiTools(ctx)`). Concurrent conversations can no longer borrow each
  other's permissions — the shape the app needs for multi-user.
- **MOYEN 6 — symlinks.** The deepest existing ancestor is `realpath`'d, so a
  symlink committed into a bundle cannot straddle the barrier.
- **MOYEN 8 — `append_log`** now matches the exact basename `log.md`
  (`blog.md`/`catalog.md` refused).

Test hygiene note: the first version of the tool-level test appended to the real
fixture log, polluting the wiki before the conversations ran. Tests now write to
a throwaway path — a reminder that a test suite that mutates its fixture is
itself a bug.
