# Deterministic guardrails and live agent benchmark — 2026-07-29

## Decision

Prompt shortening alone did not make the agents reliable. The retained design
keeps agent prompts small and moves objective behavior into runtime guards and
external oracles:

- semantic retrieval must be actually indexed and observable;
- redundant same-batch retrieval is coalesced before execution;
- the configured turn budget is terminal;
- a current-run write gets one bounded chance to collect fresh validation;
- benchmark correctness is decided from files, tests and Git state, never from
  the agent's claim.

The guards do not add a permanent workflow chapter to the system prompt.

## Live setup

- Runtime: real CodeStudio coder runner through Electron/Node.
- Semantic control plane: live API at `http://127.0.0.1:7333`.
- Provider: configured Z.AI account.
- Compared models:
  - weak: `glm-4.7-flash::coding`;
  - current: `glm-5.2`.
- Every run receives a fresh Git fixture and project/index records.
- Semantic runs wait for a complete vector generation: 23/23 indexed, zero
  failures.
- Raw answers, plans, tools, requested/executed/coalesced calls, tokens,
  provider swaps, terminal reason, changed files and test output are persisted
  under `.tmp/agent-effectiveness/reports`.

The strict suite covers Explore, Plan, Build, Builder and Admin. It separates:

1. outcome correctness;
2. deterministic trajectory health;
3. tool-count efficiency.

## Main results

### Semantic retrieval

The comparable guard-on Explore/Plan matrix improved from 1/8 correct with the
explicit FTS control to 5/8 with a real semantic generation.

| Slice | FTS control | Semantic |
| --- | ---: | ---: |
| GLM 5.2 Explore | 0/2 | 2/2 |
| GLM 4.7 Flash Explore | 0/2 | 0/2 |
| GLM 5.2 Plan | 0/2 | 1/2 |
| GLM 4.7 Flash Plan | 1/2 | 2/2 |
| Total | 1/8 | 5/8 |

The weak Explore model did retrieve/read the alternate configuration in one
semantic run, but reasoned incorrectly that it was reused; another answer was
truncated. Retrieval was fixed, model reasoning was not. This is why model
routing still matters.

The original matrix used an early retrieval-guard revision that deferred one
lexically unaligned sibling search. Final review removed that rule because
lexical mismatch does not prove semantic irrelevance. A final GLM 5.2 Explore
smoke on the retained guard passed correctness, guardrails and efficiency in
6/6 executed calls with a complete 23/23 semantic generation.

After changing `get_project_pulse` from a universal “first tool” to an
index-health/project-shape tool, GLM 5.2 Plan passed 2/2 additional semantic
runs. Only one of those runs used semantic search, so this small post-change
sample supports the wording change but does not prove it is the sole cause.

Evidence:

- FTS control:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T21-34-19-074Z.json`
- semantic matrix:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T21-47-03-777Z.json`
- post-description Plan sample:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T21-51-35-391Z.json`
- final retained-guard Explore smoke:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T22-17-55-737Z.json`

### Turn-budget failure

The first weak Plan baseline revealed a runtime loop, not merely a weak model:
`MaxTurnsReached` transitioned to Reviewing, and Reviewing unconditionally
returned to Executing.

| Runtime | Requested / executed | Input tokens | Time | Terminal |
| --- | ---: | ---: | ---: | --- |
| Before fix, worst run | 85 / 77 | 900,984 | 360.6 s | externally aborted |
| After fix, repetition 1 | 17 / 17 | 99,893 | 60.9 s | `max_turns` |
| After fix, repetition 2 | 21 / 21 | 95,554 | 50.4 s | `max_turns` |

Reviewing now treats `MaxTurnsReached` as a terminal budget verdict. This is a
deterministic cost guard; it does not depend on the model following prose.

Evidence:

- before:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T21-19-54-877Z.json`
- after:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T21-26-54-355Z.json`

### Mutation and finish evidence

The weak Builder initially changed only the paused label/modifier, omitted
`aria-live`, ran no test and claimed the full task was complete. The existing
verification readiness code classified this state, but its nudge/refusal API
had been retired and clean finish remained unconditional.

The runtime now delays a text-only finish once when:

- a successful write occurred in the current run; and
- no successful test/typecheck/lint/build was recorded after the latest write.

The one message says to run the smallest relevant validation or accurately
state why it is unavailable. It is bounded to one nudge, never affects
read-only work and does not create an infinite verification loop.

Post-fix live mutation samples:

| Model | Correct | Guard-clean | Efficient | Tools | Input | Time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GLM 4.7 Flash | yes, 6/6 tests | no | no | 8 | 86,634 | 80.7 s |
| GLM 5.2 | yes, 6/6 tests | yes | yes | 5 | 42,385 | 40.8 s |

The weak run still attempted invalid `task_complete` and `update_goal` calls
after the implementation. Correct output and surgical execution are therefore
reported separately. Several Z.AI 429 overloads also affected the weak sample;
the report preserves them rather than hiding them.

Evidence:

- weak:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T22-09-44-981Z.json`
- current:
  `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T22-12-08-359Z.json`

## Retained deterministic corrections

1. Same-batch retrieval planner:
   - coalesces compatible nonliteral greps;
   - defers broad repo map/overview when targeted semantic search is present;
   - preserves sibling searches because lexical mismatch alone does not prove
     semantic irrelevance;
   - returns a non-error pointer for every coalesced `tool_use`;
   - kill switch: `CODER_RETRIEVAL_GUARD=0`.
2. Terminal maximum-turn verdict in Reviewing.
3. One-shot post-write validation gate.
4. Honest `get_project_pulse` routing description.
5. Live benchmark:
   - real semantic reindex and full-coverage wait by default;
   - transient semantic API retry;
   - automatic plan approval for implementation cases;
   - plan capture/rejection only for the Plan deliverable;
   - deterministic output and scope oracles;
   - recovered tool failures and post-write revalidation are distinguished
     from unresolved errors and same-revision duplicate calls.

## What is not claimed

- Five fixture tasks do not prove universal agent quality.
- The post-description 2/2 Plan sample is too small for a causal guarantee.
- Provider overloads and stochastic output require repeated runs for routing
  decisions.
- The weak model is not suitable as the default for architecture-sensitive
  Explore/Plan work even when semantic retrieval is healthy.

The practical routing recommendation remains: use GLM 5.2 for architecture and
planning; reserve GLM 4.7 Flash for narrow, externally verifiable mutations.
