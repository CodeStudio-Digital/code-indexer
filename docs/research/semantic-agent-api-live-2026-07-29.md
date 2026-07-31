# Semantic search agent benchmark — live CodeStudio API

> Follow-up with paired FTS/semantic oracles and deterministic runtime guards:
> `deterministic-guardrails-agent-benchmark-2026-07-29.md`.

Date: 2026-07-29  
Runtime: `pnpm electron:dev`, HTTP API on `127.0.0.1:7333`  
Fixture: project 135, 11 files / 12 symbols  
Semantic namespace: `code:p135`, generation 4, 23/23 items, 0 failures

## Method

Sessions were created through `POST /api/coder/sessions` and executed through
`POST /api/coder/sessions/:id/messages`. Results, tool calls, token usage and
search telemetry were read from the persisted session and diagnostic APIs. No
UI automation was used and agents were instructed not to modify the fixture.

The main Explore question was:

> Onde a expiração de sessão é definida, como ela chega ao token e qual é a
> regra exata de expiração?

The fixture deliberately contains two equal TTL values:

- the effective `SESSION_TTL_MS` in `src/auth/session-policy.js`;
- the unused `SECURITY_DEFAULTS.sessionTtlMs` in `src/config/security.js`.

This makes the second file a useful semantic-retrieval check: its identifier is
different, but its meaning is related.

## Confirmed failures

1. `mode=auto` routed ordinary keyword bags such as
   `session expiration token timeout` to FTS. The code-shaped-token regex
   matched normal words, so vectors were bypassed.
2. FTS-only results were rendered as `score: 0.000`, even though their useful
   evidence was `fts_rank`. This made a working lexical result look broken.
3. A successful vector-only file hit exposed only path/language/line count.
   GLM 5.2 placed `src/config/security.js` first, ignored the empty header, and
   incorrectly concluded that no alternate configuration existed.
4. Fresh-session preflight pinned up to 12 tools, often including overlapping
   `repo_map`, `skeleton`, `symbol_body` and `read_file` routes. Weak models
   treated the suggestions as a checklist.
5. Prompt/description wording alone did not fix the behavior. In repeated live
   runs the same model continued to emit keyword bags and redundant reads.

## Corrections

- The auto planner now distinguishes actual code-shaped tokens from ordinary
  conceptual keywords. Three or more ordinary terms route to hybrid search.
- Search results now report honest provenance: `FTS #n`, `vector 0.xxx`, or
  combined hybrid evidence.
- Pure-vector hits for small files include a bounded 12-line/900-character
  preview, capped at three results. This turns a semantic hit into usable
  evidence without dumping large files.
- Preflight defaults changed from 12 to 4 pins and coalesce overlapping read
  routes. A targeted search suppresses concurrent broad repo-map pins; memory
  tools are removed when no actual memory was selected.
- The visible-tool ceiling is 28. A 24-tool experiment was rejected because
  regression tests showed it could hide `edit_file`/`write_file`.
- `get_file_skeleton` moved from bootstrap to on-demand navigation. Search
  already reports line counts and `mcp__read_file` auto-returns files up to 800
  lines.
- Plan/Explore routing now prefers search before exact grep or broad mapping.

## Live results

| Session | Model | Result | Calls | Input / output | Cache read |
|---|---|---|---:|---:|---:|
| `7533dbd6…` | GLM 5.2 | Correct main flow, but auto search fell back to FTS and missed the duplicate config risk | 6 | 31,323 / 854 | 21,376 |
| `5128402a…` | GLM 5.2 | Same keyword query routed hybrid; found the duplicate TTL risk | 6 | 31,050 / 920 | 21,184 |
| `86a3acb8…` | GLM 4.7 Flash | Correct, but used repo map + 3 skeletons + 3 reads | 9 | 35,669 / 647 | 25,738 |
| `af35f172…` | GLM 4.7 Flash | No skeleton/repo map; correct main flow in 7 calls | 7 | 36,974 / 793 | 27,921 |
| `d9e3e017…` | GLM 5.2 | With semantic preview, correctly identified the orphan `sessionTtlMs` and both sources of truth | 8 | 33,222 / 1,088 | 28,352 |

The final GLM 5.2 run used one semantic search, read the three relevant files,
and spent the remaining calls verifying that the alternative config is
unreferenced. It took 47.1 seconds end to end; MCP tool execution accounted for
5.8 seconds.

The weak model improved from 9 to 7 calls and stopped the
`skeleton -> symbol/read` duplication. It remains less disciplined than GLM 5.2
and should not be described as "perfect": it can still issue a second adjacent
search and may omit a maintenance implication even when the evidence is
available.

## Causal conclusion

The useful part of semantic search is not merely a higher similarity score. In
this fixture it surfaced `src/config/security.js`, a conceptually related file
that exact identifier search did not establish as part of the effective token
flow. The agent became reliable only when three layers agreed:

1. deterministic auto-routing actually invoked hybrid search;
2. the result exposed its lexical/vector provenance;
3. semantic-only small-file hits contained enough bounded evidence to inspect.

Adding more prompt text was not the effective lever. Planner behavior,
result-shaping and a smaller non-overlapping tool surface produced the
measurable improvement.
