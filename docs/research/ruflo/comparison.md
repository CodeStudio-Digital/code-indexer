# ruflo vs D:\MCP — Comparative Analysis

**Date:** 2026-05-21
**Source under analysis:** [ruvnet/ruflo](https://github.com/ruvnet/ruflo) (shallow clone in `D:\scratch\ruflo`, commit at clone time)
**Reference project:** D:\MCP (MCP Code Indexer v3.15, branch `build-v2`)

---

## Executive Summary

**ruflo is not a competitor — it's a different category.** D:\MCP is a **codebase indexer + coder agent platform** (FTS5 + LSH + symbol hierarchy + LSP + worker pool + dashboard). ruflo (formerly `claude-flow`, package name still `claude-flow@3.7.0-alpha.77`) is an **orchestration ledger** that sits *outside* the executor (Claude Code / Codex CLI) and provides:

- agent persona definitions (MD + YAML)
- a Claude Code plugin marketplace (33 plugins)
- MCP coordination tools (`swarm_init`, `memory_store`, `hooks_worker-dispatch`, etc.)
- cron-based background workers
- a signed witness manifest for supply-chain integrity
- a Rust federation peer (QUIC + safety gates)

ruflo's `AGENTS.md:30-36` puts the architecture in one box:

> CLAUDE-FLOW = ORCHESTRATOR (tracks state, coordinates)
> CODEX/CLAUDE CODE = WORKER (writes code, runs commands, implements)

**The big idea worth borrowing**: ruflo extends Claude Code by **adding plugins, MCP tools, hooks, and scheduled workers** — without owning the executor. D:\MCP could play a similar role (its own dashboard + coder is the executor; the ruflo-style layer would sit on top, or be exposed *to* Claude Code via MCP).

**Net assessment of the 8 claimed differentiators:**

| # | Claim | Reality | Status in D:\MCP | Worth porting? |
|---|---|---|---|---|
| 1 | Swarm coordination (hierarchical/mesh/adaptive) | Real but lightweight — Map+load-balancer; "consensus" is mostly persona-level | Subagent spawn only | ✦ Selective (persona files + topology configs as planning docs) |
| 2 | SONA + trajectory learning | External npm packages (`@ruvector/sona`, `agentdb`); the 4-step pipeline (RETRIEVE→JUDGE→DISTILL→CONSOLIDATE) is a useful operational pattern | Snapshots stored passively, no retrieval | ✦ Selective (pre-task pattern-search + post-task pattern-store loop) |
| 3 | HNSW AgentDB (150-12,500× faster) | In-repo `AgentDBBackend.ts` is a STUB (`Map` + cosineSimilarity); real HNSW in external `agentdb` npm pkg | LSH index (95% recall, mid-tier) | ✕ Not urgent — LSH is fine; revisit if perf tells otherwise |
| 4 | Federation (cross-machine, zero-trust) | Real Rust crate with QUIC + AIMDS 3-gate safety; trust scoring formula referenced (impl external) | Absent | ✦ The 3-gate pattern is portable; QUIC transport is overkill |
| 5 | 12 auto-triggered background workers | Real — dispatched via MCP `hooks_worker-dispatch --trigger X`, plus cron + 270s cache-aware heartbeat | Single 24h provider-refresh (low) | ✓ High — adopt the pattern + 8-10 workers |
| 6 | GOAP A* goal planner | Agent persona + skill prompts only — no actual planning engine in repo; `v3/goal_ui` is a Supabase web UI | Flat task list via `submit_tasks` | ✕ Marginal — ruflo's "GOAP" is also just prompt-driven |
| 7 | 33-plugin marketplace | Real, standard Claude Code plugin format (`.claude-plugin/marketplace.json`) | Absent (only `.claude/skills` locally) | ✓ High — adopt the format, publish D:\MCP as a Claude Code plugin |
| 8 | Cryptographic verification (`ruflo verify`) | Real, well-engineered — Ed25519-signed manifests per OS + SHA-256 + marker substring + JSONL temporal history | HS256 JWT for auth only | ✓ High — clean, reusable, single-dep pattern |

Plus 4 non-claimed but valuable patterns: 3-gate AIDefence, 270s cache-aware ScheduleWakeup, AgentDB namespace convention, plugin pinning + smoke.sh as contract.

---

## 1. Swarm coordination

**Where it lives in ruflo:**
- [`v3/src/coordination/application/SwarmCoordinator.ts`](file:///D:/scratch/ruflo/v3/src/coordination/application/SwarmCoordinator.ts) — runtime
- [`v3/swarm.config.ts`](file:///D:/scratch/ruflo/v3/swarm.config.ts) — 15-agent role mapping (Queen + domain pods)
- [`v3/agents/*.yaml`](file:///D:/scratch/ruflo/v3/agents/) — persona files (architect, coder, reviewer, security-architect, tester)

**What it actually does:**
The `SwarmCoordinator` is a `Map<id, Agent>` with a `distributeTasks` load balancer (`SwarmCoordinator.ts:145-188` — find suitable agents by `canExecute(task.type)`, pick lowest load). Topologies (`hierarchical-mesh`, `mesh`, `hierarchical`, `centralized`) are **static connection graphs** in `swarm.config.ts:396-443`. Each agent is a domain object (`v3/src/agent-lifecycle/domain/Agent.ts:42-89`) that calls `task.onExecute()` — the real LLM work is done elsewhere.

The Queen + domains pattern from `swarm.config.ts:189-340` is essentially **org-chart-as-code**: a Gantt-style planning doc with phases (`phase-1-foundation` ... `phase-4-release`), per-domain priority, and GitHub label routing. Ruflo built v3 of itself using this config.

**What D:\MCP has:**
- Subagent spawning via `runSubagent()` in [packages/code-agent/src/tools/subagent.ts](packages/code-agent/src/tools/subagent.ts) — strictly hierarchical (parent spawns child).
- Kanban orchestrator in `packages/company/` — has role-based pipeline, event bus, board events.
- No topology config, no consensus, no persona library.

**Gap:** Ruflo's "swarm" is closer to *role mapping + planning convention* than a runtime distributed system. The portable piece is the **persona library** (YAML/MD agent definitions) and **phased Gantt-as-code**, not the runtime coordinator (D:\MCP's subagent spawning + Company kanban already covers the runtime side).

---

## 2. SONA / trajectory learning

**Where it lives in ruflo:**
- Plugin: [`plugins/ruflo-intelligence/`](file:///D:/scratch/ruflo/plugins/ruflo-intelligence) — documentation + skills + 29 MCP tools across 5 families
- Implementation: external npm packages `@ruvector/sona`, `@ruvector/attention`, `@claude-flow/neural`, `agentdb`
- The actual SONA algorithm is **not in this repo** — only the orchestration of MCP tool calls.

**The operational pattern (worth keeping):**
The [`ruflo-intelligence/README.md`](file:///D:/scratch/ruflo/plugins/ruflo-intelligence/README.md) describes a **4-step intelligence pipeline**:

| Step | What happens | Tools |
|---|---|---|
| **RETRIEVE** | Pull patterns + past trajectories from HNSW index | `hooks_intelligence_pattern-search`, `agentdb_pattern-search`, `agentdb_semantic-route` |
| **JUDGE** | Score candidates with success/failure/partial verdicts | `hooks_intelligence_attention`, `neural_predict`, `hooks_explain` |
| **DISTILL** | Extract learnings via LoRA / SONA adaptation | `ruvllm_sona_adapt`, `ruvllm_microlora_adapt`, `neural_train`, `hooks_intelligence_learn` |
| **CONSOLIDATE** | Prevent catastrophic forgetting via EWC++ | `agentdb_consolidate`, `ruvllm_microlora_adapt --consolidate`, `neural_compress` |

The hook integration is concrete: `pre-task` hook does RETRIEVE; `post-task --train-neural` does DISTILL (writes to `pattern` namespace via ReasoningBank fallback).

**Cross-project pattern transfer:** `hooks_transfer` publishes learned patterns to IPFS (Pinata) — a learned pattern from project A can be re-applied in project B.

**What D:\MCP has:**
- [`packages/services/src/services/snapshots.ts`](packages/services/src/services/snapshots.ts) — ContextSnapshot objects (title, content, embedding hash) in SQLite.
- [`packages/code-agent/src/sessions/store.ts`](packages/code-agent/src/sessions/store.ts) — coder_sessions table.
- **No retrieval/replay** — snapshots are passive, used for dedup and diff viewing.

**Gap:** D:\MCP captures the data already; it lacks the **retrieval-on-task-start** and **store-on-task-success** loop. Adding a `pre_task_pattern_search` + `post_task_pattern_store` pair in the coder agent's life cycle would unlock most of the practical value without needing SONA/EWC++. See spec [`002-trajectory-replay.md`](specs/002-trajectory-replay.md).

---

## 3. HNSW AgentDB

**Where it lives in ruflo:**
- TS wrapper: [`v3/src/memory/infrastructure/AgentDBBackend.ts`](file:///D:/scratch/ruflo/v3/src/memory/infrastructure/AgentDBBackend.ts)
- Real impl: external `agentdb` npm package (optional dep in `package.json:74`)

**Reality check:**
The in-repo `AgentDBBackend.ts:36-42` says:

```ts
async initialize(): Promise<void> {
  if (this.initialized) return;
  // In a real implementation, this would initialize HNSW index
  // For now, using in-memory storage for test compatibility
  this.initialized = true;
}
```

And `vectorSearch` (`:133-149`) does a `Map`-iteration with `cosineSimilarity` (`:165-182`) — O(n) brute force. The "150-12,500× faster" claim refers to the **external `agentdb`** package; the in-repo file is a stub for testing.

**What D:\MCP has:**
- [`packages/indexer/src/search/lsh-index.ts`](packages/indexer/src/search/lsh-index.ts) — LSH (Locality-Sensitive Hashing) with 2 hashes × 32 hyperplanes on 768-dim embeddings, >95% recall.
- [`packages/store/src/lsh-index-store.ts`](packages/store/src/lsh-index-store.ts) — persistent LSH store.
- VectorStore reranks LSH candidates with full-precision cosine.

**Gap:** D:\MCP's LSH is **closer to production** than ruflo's in-repo HNSW (which is stubbed). If query latency ever becomes an issue, swap `lsh-index.ts` for `hnswlib-node`. Otherwise: not urgent. Note that hnswlib insertion is O(log N) but bulk-rebuild becomes expensive at scale — LSH may be preferable for very large code corpora.

---

## 4. Federation (cross-machine)

**Where it lives in ruflo:**
- Rust crate: [`v3/crates/ruflo-federation-peer/src/lib.rs`](file:///D:/scratch/ruflo/v3/crates/ruflo-federation-peer/src/lib.rs)
- Plugin: [`plugins/ruflo-federation/`](file:///D:/scratch/ruflo/plugins/ruflo-federation/)

**What it actually does:**
The Rust crate is **real engineering**. From `lib.rs:1-31`:

> Composes the QUIC transport (`midstreamer-quic`) and the AIMDS 3-gate safety pipeline (`aimds-detection` / `aimds-analysis` / `aimds-response`) into one Rust process per peer (ADR-120 Step 3).

The design is clean (trait-based, pluggable):
- `TransportProvider` — QUIC send/recv (`lib.rs:93-105`)
- `SafetyGate` — 3-gate inspection returning `SafetyVerdict::{Pass, Block, Redact}` (`lib.rs:108-115`)
- `Dispatcher` — stdio NDJSON to local MCP server (`lib.rs:117-125`)
- `Peer<T, G, D>` — binds them and runs the inbound loop (`lib.rs:132-203`)

Trust scoring formula (from README, not seen in crate source — likely in `aimds-*` upstream): `0.4×success + 0.2×uptime + 0.2×threat + 0.2×integrity`.

**What D:\MCP has:**
- [`apps/http-api/sse/CoderWorkerPool.ts`](apps/http-api/sse/CoderWorkerPool.ts) — local Node worker_threads, isolated by worker file + SQLite path.
- No cross-host RPC.

**Gap:** Cross-machine federation is genuinely absent in D:\MCP. **However**: the bulk of the value is in the **3-gate safety pattern**, not QUIC. That pattern can be implemented as a TS middleware in `apps/http-api`, gating any agent message before it's forwarded to a worker or external endpoint. See spec [`003-safety-gates.md`](specs/003-safety-gates.md).

---

## 5. 12 background workers

**Where it lives in ruflo:**
- Plugin: [`plugins/ruflo-loop-workers/`](file:///D:/scratch/ruflo/plugins/ruflo-loop-workers)
- MCP tools: `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts` (in external pkg)
- Skill: [`plugins/ruflo-loop-workers/skills/cron-schedule/SKILL.md`](file:///D:/scratch/ruflo/plugins/ruflo-loop-workers/skills/cron-schedule/SKILL.md)

**The 12 workers (from [README](file:///D:/scratch/ruflo/plugins/ruflo-loop-workers/README.md)):**

| Trigger | Purpose | Recommended cron |
|---|---|---|
| `ultralearn` | Bootstrap learning corpus from deep codebase scan | (one-shot) |
| `optimize` | Performance + cost recommendations | `*/30 * * * *` |
| `consolidate` | EWC++ memory consolidation | `0 * * * *` |
| `predict` | Predictive routing for upcoming tasks | (event) |
| `audit` | Security + compliance pass | `*/15 * * * *` |
| `map` | Build/refresh knowledge graph | `*/30 * * * *` |
| `preload` | Warm caches before high-frequency ops | (event) |
| `deepdive` | Multi-source investigation | (on-demand) |
| `document` | API docs + drift detection | `0 */2 * * *` |
| `refactor` | Diff-aware refactor recommendations | (event) |
| `benchmark` | Perf benchmarks | (event) |
| `testgaps` | Coverage gap detection + test generation | `*/15 * * * *` |

**MCP surface:** `hooks_worker-list`, `hooks_worker-dispatch`, `hooks_worker-status`, `hooks_worker-detect`, `hooks_worker-cancel`.

**The 270s heartbeat rule:** `/loop` workers should use `ScheduleWakeup` with delay <270s so the prompt cache (5-min TTL) stays warm. Going past 300s pays a cache-miss. This pairs with [`ruflo-autopilot ADR-0001`](file:///D:/scratch/ruflo/plugins/ruflo-autopilot/docs/adrs/0001-autopilot-contract.md) which owns the cache-aware contract.

**What D:\MCP has:**
- [`packages/indexer/src/indexer/providers/scheduled-refresh.ts`](packages/indexer/src/indexer/providers/scheduled-refresh.ts) — single 24h provider-model refresh.
- No generic worker registry, no cron scheduler, no audit/testgaps/docs-drift jobs.

**Gap:** Large and high-ROI. The pattern transplants cleanly to D:\MCP since the executor (coder agent) is already in-house. See spec [`001-background-workers.md`](specs/001-background-workers.md).

---

## 6. GOAP A* planner

**Where it lives in ruflo:**
- Plugin: [`plugins/ruflo-goals/`](file:///D:/scratch/ruflo/plugins/ruflo-goals)
- Web UI: [`v3/goal_ui/`](file:///D:/scratch/ruflo/v3/goal_ui) — Vite + Tailwind + Supabase app

**Reality check:**
The plugin's `README.md:13-19` lists `goal-plan` skill and `goal-planner` agent ("GOAP specialist with A* planning"). But these are **prompt-driven definitions** — there's no GOAP solver in the repo. The actual planning happens inside the LLM (Claude Code), guided by the agent's persona prompt. The `goal_ui` Vite app is a Supabase-backed tracker/dashboard, not a planner.

**What D:\MCP has:**
- [`packages/code-agent/src/tools/tasks.ts`](packages/code-agent/src/tools/tasks.ts) — `submit_tasks` (flat list, user approves), `execute_task` (sequential run).
- Coder presets `explore` / `plan` / `build` / `admin` already encode a planning step.

**Gap:** Marginal. Ruflo's "GOAP" is what D:\MCP's `plan` preset already does (prompt-driven decomposition). A real GOAP A* engine would be a research project, not a port. Skip.

---

## 7. Plugin marketplace (33 plugins)

**Where it lives in ruflo:**
- Top-level manifest: [`.claude-plugin/marketplace.json`](file:///D:/scratch/ruflo/.claude-plugin/marketplace.json) — lists all 33 plugins.
- Top-level plugin: [`.claude-plugin/plugin.json`](file:///D:/scratch/ruflo/.claude-plugin/plugin.json) — the parent claude-flow plugin (v2.5.0).
- Per-plugin: [`plugins/ruflo-X/.claude-plugin/plugin.json`](file:///D:/scratch/ruflo/plugins/ruflo-loop-workers/.claude-plugin/plugin.json) — metadata
- Per-plugin contents: uniform `agents/`, `commands/`, `skills/`, `hooks/`, `docs/`, `scripts/smoke.sh` shape.

**Install model:**
```
/plugin marketplace add ruvnet/ruflo
/plugin install ruflo-loop-workers@ruflo
```

This drops the plugin's `agents/*.md`, `commands/*.md`, `skills/*/SKILL.md` files into `.claude/` so Claude Code picks them up as slash commands, skill definitions, and agent personas.

**Plugin pinning + smoke as contract:** every plugin pins to `@claude-flow/cli` major+minor and ships `scripts/smoke.sh` as its conformance contract. The smoke script must pass for the plugin to be considered compatible.

**What D:\MCP has:**
- [`.claude/skills/`](.claude/skills/) — local skill definitions (already in Claude Code format).
- IDE extensions in `extensions/vscode/` and `extensions/jetbrains/`.
- **No `.claude-plugin/` directory, no marketplace.json, not installable as a Claude Code plugin.**

**Gap:** Adopting the format is **strictly additive** — D:\MCP keeps its current product surface (dashboard, http-api, coder) and additionally becomes installable as a Claude Code plugin. The skills already exist; mainly need a top-level manifest. See spec [`004-claude-plugin-format.md`](specs/004-claude-plugin-format.md).

---

## 8. Cryptographic verification (`ruflo verify`)

**Where it lives in ruflo:**
- README: [`verification/README.md`](file:///D:/scratch/ruflo/verification/README.md)
- Scripts: [`plugins/ruflo-core/scripts/witness/`](file:///D:/scratch/ruflo/plugins/ruflo-core/scripts/witness/) — init.mjs, regen.mjs, verify.mjs, history.mjs, perf.mjs, lib.mjs
- Manifests: `verification/{linux,macos,windows}/manifest.md.json` + `history.jsonl`
- Single dep: `@noble/ed25519`

**The pattern (genuinely novel):**
1. Each documented fix has an entry in `verification/witness-fixes.json` with `{ id, desc, file, marker }`.
2. CI runner per OS computes `sha256(file)` + checks `file.includes(marker)`, signs the bundle with an Ed25519 key derived from `${ORG_SECRET}:${git_commit}`.
3. Verifier re-derives the key and checks the signature + per-fix marker presence.
4. Three statuses: `pass` (sha + marker), `drift` (marker present, sha changed), `regressed` (marker missing).

The **insight** is that unit tests verify code paths, but regressions often happen at the integration seam — subprocess flag parsers, npm install resolution, plugin/CLI drift. The witness layer attests "the load-bearing line of fix #1859 is still in `hooks.js`" — even when that fix has no dedicated smoke test.

The temporal history JSONL lets you bisect to find *which commit* regressed.

Exit code 2 distinguishes "needs install+build" from "real regression" (`verify.mjs:39-50`) — clever for CI to avoid false-positive bug reports.

**What D:\MCP has:**
- HS256 JWT signing for auth ([`packages/services/src/auth/crypto/hmac-jwt-signer.ts`](packages/services/src/auth/crypto/hmac-jwt-signer.ts)).
- SHA-256 token hashing.
- **No artifact attestation, no signed release, no fix-marker witnessing.**

**Gap:** Adopt the witness toolkit. Single dep, well-engineered. See spec [`005-witness-verification.md`](specs/005-witness-verification.md).

---

## Other patterns worth borrowing

### 3-gate AIDefence
From [`plugins/ruflo-aidefence/README.md`](file:///D:/scratch/ruflo/plugins/ruflo-aidefence/README.md):

| # | Gate | When |
|---|---|---|
| 1 | Pre-storage PII | Before any AgentDB / `memory_store` write |
| 2 | Sanitization | For cookies, tokens, high-entropy blobs |
| 3 | Prompt-injection | Before any extracted text re-enters an LLM prompt |

Categories detected (per ADR-118): "ignore all previous instructions", "you are now X", "DAN mode", etc. Categorized findings emitted via `transfer_detect-pii`.

D:\MCP has minimal equivalent — `prompt-injector.ts` does variable interpolation but no detection. Easy to add as middleware.

### Namespace convention (AgentDB)
Kebab-case namespaces, reserved names: `pattern`, `patterns`, `claude-memories`, `default`. Each plugin owns its namespace (e.g., `worker-history`, `security-patterns`). Documented in [`ruflo-agentdb ADR-0001`](file:///D:/scratch/ruflo/plugins/ruflo-agentdb/docs/adrs/0001-agentdb-optimization.md). Cheap convention to adopt for D:\MCP's snapshot/embedding tables if multiple agents start sharing storage.

### 270s ScheduleWakeup heartbeat
Prompt cache TTL is 5 min. Going to 300s pays a cache miss. Going to 270s stays cached. Going to 1200s+ is "buy a long wait with one miss". This is the same dynamic-pacing math D:\MCP could expose in its own `/loop` skill.

### Two install paths
ruflo offers (a) Claude Code plugin install (lite — slash commands, no MCP server) and (b) `npx ruflo init` (full — daemon, hooks, helpers, .claude-flow/). Same idea could apply to D:\MCP: a slim Claude Code plugin path + the existing CLI/dashboard path.

---

## Architecture conclusion

ruflo and D:\MCP are **layered differently**:

```
ruflo (orchestration ledger)            D:\MCP (executor + indexer)
───────────────────────────             ──────────────────────────
Claude Code / Codex (executor)          dashboard (UI)
   ↓ MCP                                http-api (REST/SSE)
ruflo MCP server (~210 tools)           coder agent (worker pool)
   ↓                                       ↓ 60+ MCP tools
33 plugins (agents/commands/skills)     code-agent + indexer + store
   ↓                                       ↓
agentdb (external) — HNSW memory        SQLite + FTS5 + LSH + LSP
sona/ruvector (external) — learning     snapshots + embeddings
federation peer (Rust) — cross-host     local worker_threads
```

D:\MCP **owns the executor + the substrate**; ruflo **owns the coordination layer above the executor**. They could coexist:
- D:\MCP can adopt ruflo's plugin format and become installable as a Claude Code plugin alongside ruflo.
- D:\MCP can borrow the 270s heartbeat, 12-worker registry, 3-gate safety, and witness verification patterns without changing its core indexer architecture.
- D:\MCP's superior code-indexing layer (FTS5 + LSH + tree-sitter + LSP) could be exposed as MCP tools that ruflo plugins (or any Claude Code session) consume.

**The highest-leverage move:** publish D:\MCP as a Claude Code plugin (`mcp-code-indexer` in a marketplace), exposing its 60+ MCP tools. That puts D:\MCP in the path of every Claude Code user, including ruflo's installed base.

---

## See also

- [`portable-items.md`](portable-items.md) — prioritized table with effort/ROI
- [`specs/001-background-workers.md`](specs/001-background-workers.md) — 12-worker registry
- [`specs/002-trajectory-replay.md`](specs/002-trajectory-replay.md) — pre/post-task pattern memory
- [`specs/003-safety-gates.md`](specs/003-safety-gates.md) — 3-gate AIDefence middleware
- [`specs/004-claude-plugin-format.md`](specs/004-claude-plugin-format.md) — make D:\MCP installable
- [`specs/005-witness-verification.md`](specs/005-witness-verification.md) — Ed25519 fix-marker witness
