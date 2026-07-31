# Live agent effectiveness benchmark — 2026-07-29

> Historical first pass. The stricter semantic-indexed matrix, deterministic
> guardrails and corrected mutation-plan harness are documented in
> `deterministic-guardrails-agent-benchmark-2026-07-29.md`.

## Outcome

The repository now has a reproducible live benchmark that runs the real coder
runner against fresh, indexed Git projects and scores deterministic outcomes,
scope, tool use, tokens and elapsed time. The initial matrix compared the
configured Z.AI weak/current pair:

- weak: `glm-4.7-flash::coding`
- current: `glm-5.2`

The core matrix was functionally correct in all 10 runs. `glm-5.2` was
materially more efficient: 37 tool calls, 245,004 prompt tokens and 292.1 s,
versus 69 tool calls, 614,659 prompt tokens and 720.9 s for the weak model.
The weak plan result is not a clean cost comparison because the first harness
rejected the submitted plan and caused repeated submissions; correctness is
valid, but its plan cost is not.

Raw evidence:

- `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T19-25-20-591Z.json`
- `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T19-25-20-591Z.md`

## Initial matrix

| Model | Agent | Correct | Tools | Prompt tokens | Time |
| --- | --- | ---: | ---: | ---: | ---: |
| GLM 4.7 Flash | explore | yes | 9 | 41,443 | 49.4 s |
| GLM 5.2 | explore | yes | 6 | 24,076 | 38.5 s |
| GLM 4.7 Flash | plan | yes* | 39 | 364,284 | 465.0 s |
| GLM 5.2 | plan | yes | 15 | 92,953 | 82.0 s |
| GLM 4.7 Flash | build | yes | 11 | 96,718 | 73.3 s |
| GLM 5.2 | build | yes | 7 | 46,527 | 67.3 s |
| GLM 4.7 Flash | builder | yes | 6 | 66,129 | 74.6 s |
| GLM 5.2 | builder | yes | 5 | 36,135 | 38.0 s |
| GLM 4.7 Flash | admin | yes | 4 | 46,085 | 58.6 s |
| GLM 5.2 | admin | yes | 4 | 45,313 | 66.3 s |

`*` Correct plan content, invalid efficiency sample due to harness rejections.

## Causal plan experiments

Planning was the only reproduced runaway:

1. The weak model repeatedly researched/submitted and hit provider 429s. A
   shorter prompt did not fix it.
2. An aggressively shortened plan prompt reduced calls but missed the existing
   `src/config/security.js` seam. It was reverted; fewer characters were not
   worth a wrong architecture.
3. Adding one intent rule — semantic search for central/reusable patterns,
   grep for exact identifiers — made GLM 5.2 discover the correct security
   configuration seam. That run was correct but still used 17 tools.
4. Reducing the plan profile from `navigate` to `bootstrap` cut the catalog
   from 97 to 43 tools and roughly halved prompt use in one sample, but a
   three-run check found the correct seam only 1/3 times. The profile reduction
   was reverted.

Evidence for the successful semantic-discovery run:

- `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T19-39-10-269Z.json`

Evidence for the rejected bootstrap experiment (1/3 correct):

- `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-07-29T19-45-30-404Z.json`

## Changes retained

- Plan prompt remains compact, but explicitly routes conceptual architecture
  discovery to `mcp__search` and exact identifiers to grep.
- Plan defaults to 12 turns.
- Plan mode receives no automatic continuation batches. Missing the planning
  budget stops the run instead of multiplying it up to four times.
- The benchmark evaluates the first submitted plan only, separates correctness
  from efficiency, checkpoints every run, records provider swaps, and preserves
  failed-run evidence.
- `plan` remains on the `navigate` profile because the smaller catalog was not
  consistent enough.

## Model routing conclusion

- Use `glm-5.2` for plan and architecture-sensitive work.
- `glm-4.7-flash::coding` is acceptable for the small deterministic builder and
  admin cases tested here, but must not be the default planning model.
- Do not call any configuration “perfect” from one repetition. The current
  evidence supports functional correctness for the five core cases and a
  bounded planning failure mode, not universal model parity.

## Coverage boundary

This first suite covers `explore`, `plan`, `build`, `builder` and `admin`.
`research`, `app_orchestrator`, `app_db`, `spec`, `api` and `diagram` need
surface-specific fixtures (web sources, App Studio workflow, a live database,
spec gate, live API server and Draw.io runtime). Scoring them in the small code
fixture would measure missing environment rather than agent effectiveness.

The fixture receives the structural index used by the real MCP bridge. It does
not build a dedicated semantic-vector generation for every temporary project;
semantic retrieval quality itself needs a separate fixed-generation benchmark.
