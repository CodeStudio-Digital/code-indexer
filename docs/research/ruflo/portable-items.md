# Portable Items — ruflo → D:\MCP

**Date:** 2026-05-21
**Companion to:** [`comparison.md`](comparison.md)

Ranked by **ROI / Effort**. Effort: S = ≤1d, M = 1-5d, L = >5d, XL = >2wk. ROI: how much capability this unlocks for D:\MCP users, given current product surface.

| # | Item | Effort | ROI | Pre-reqs | Recommendation | Spec |
|---|---|---|---|---|---|---|
| 1 | **Claude Code plugin format** — `.claude-plugin/marketplace.json` + per-plugin manifests so D:\MCP is installable via `/plugin install` | S | **High** — every Claude Code user becomes a potential D:\MCP user; near-zero ongoing maintenance | `.claude/skills/` already exists | **Adopt** | [`specs/004-claude-plugin-format.md`](specs/004-claude-plugin-format.md) |
| 2 | **12 background workers + cron scheduler** — `WorkerRegistry`, MCP `worker_*` tools, ScheduleWakeup heartbeat at 270s, audit/testgaps/document workers | M | **High** — turns D:\MCP from "reactive coder" into "always-on quality engine"; biggest UX shift | CoderWorkerPool already in place; just need registry + dispatch layer | **Adopt** | [`specs/001-background-workers.md`](specs/001-background-workers.md) |
| 3 | **Witness verification (Ed25519 fix markers)** — register every regression fix in `witness-fixes.json`, CI signs per-OS manifests, `verify.mjs` blocks publish on regression | S | **High** — blocks the same class of "passes tests, breaks for users" bugs that drove ruflo to build this; single dep | `@noble/ed25519` + CI ed25519 secret | **Adopt** | [`specs/005-witness-verification.md`](specs/005-witness-verification.md) |
| 4 | **Trajectory replay (pre-task pattern-search / post-task pattern-store)** — RETRIEVE phase before a task, STORE phase after success; snapshots already exist, just need the loop | M | **Medium-High** — improves repeat-task latency and correctness; uses existing snapshot infra | LSH index already in `packages/indexer/`; snapshots in `packages/services/` | **Adopt (phased)** | [`specs/002-trajectory-replay.md`](specs/002-trajectory-replay.md) |
| 5 | **3-gate safety pipeline (PII / sanitization / prompt-injection)** — middleware between any agent input/output and storage or re-prompt | M | **Medium-High** — required if D:\MCP ever ingests user-supplied content (browser tool, web search, federation) | Pattern dictionary for PII + injection markers | **Adopt** | [`specs/003-safety-gates.md`](specs/003-safety-gates.md) |
| 6 | **270s cache-aware ScheduleWakeup heartbeat** — `/loop` skill or dashboard auto-runs that wake before 5-min prompt cache TTL | S | **Medium** — small but real cost saving + UX improvement for long-running sessions | Just a documented convention + skill update | **Adopt** | (Bundle into spec #2) |
| 7 | **Agent persona library** — `agents/{architect,coder,reviewer,tester,security-architect}.yaml` + MD personas mirroring ruflo's domain mapping | S | **Medium** — gives D:\MCP a discoverable persona menu; can hook into existing coder preset infrastructure | None | **Adopt selective** (5-8 personas, not 100+) | (No standalone spec — add to plugin format spec) |
| 8 | **AgentDB namespace convention** — kebab-case, reserved names (`pattern`, `claude-memories`, `default`), one namespace per logical owner | S | **Medium** — cheap insurance for future when multiple agents share storage | None | **Adopt** | (1-page doc, no spec needed) |
| 9 | **4-step intelligence pipeline as documented operational pattern** (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE) | S | **Medium** — gives a vocabulary + mental model even without SONA | Trajectory replay (#4) for RETRIEVE/CONSOLIDATE phases | **Adopt as doc + skill** | (Bundle into spec #4) |
| 10 | **Plugin pinning + smoke.sh as contract** — each plugin pins to a major+minor of the host CLI and ships a smoke script; CI gates on smoke pass | S | **Medium** — formalizes the "extension stays in sync with core" guarantee | Plugin format (#1) | **Adopt** (after #1) | (Bundle into spec #1) |
| 11 | **Federation 3-gate inspection pattern (TS port)** — `SafetyVerdict::{Pass, Block, Redact}` middleware on any cross-process / cross-host message | M | **Medium-Low** — only matters if D:\MCP introduces federation; lower priority until then | Safety gates (#5) as substrate | **Hold until federation use-case** | (No spec yet) |
| 12 | **Phased swarm config as Gantt-as-code** — `swarm.config.ts`-style file listing phases, prerequisites, active domains | S | **Low-Medium** — useful for D:\MCP's own development planning; less so as product | None | **Adopt for internal dev planning only** | (No spec) |
| 13 | **YAML agent persona files** — mirror ruflo's `v3/agents/*.yaml` for consistent agent capability declaration | S | **Low** — overlaps with #7; only worth it if multiple personas need machine-readable capability filtering | Persona library (#7) | **Optional** | (No spec) |
| 14 | **IPFS cross-project pattern transfer (Pinata)** — `hooks_transfer` equivalent for sharing learned patterns across projects | L | **Low** — interesting but adds large dep and an extra opaque storage layer; only valuable at scale | Trajectory replay (#4); Pinata account | **Defer** | (No spec) |
| 15 | **HNSW vector index swap** — replace LSH with `hnswlib-node` for higher recall at scale | M | **Low** — LSH already hits 95% recall; no current perf pain | None | **Defer** until perf data justifies | (No spec) |
| 16 | **GOAP A* goal planner** — formal action-graph planner with preconditions/effects/costs | XL | **Low** — ruflo's "GOAP" is also prompt-driven, no real engine; D:\MCP's `plan` preset already covers this | Real GOAP solver | **Skip** | (No spec) |
| 17 | **Cross-machine federation (QUIC + AIMDS)** — multi-host agent collaboration | XL | **Low** — no current cross-host use case; safety gates (#5) cover the portable insight | Rust toolchain; QUIC infra | **Skip** | (No spec) |
| 18 | **SONA / LoRA online adaptation** — actual neural weight adaptation per project (external lib `@ruvector/sona`) | XL | **Low** — ruflo treats this as a black box too; not differentiating | External pkg + GPU | **Skip** | (No spec) |

---

## Recommended adoption order

**Sprint 1 (1 week, 1 dev):**
1. Plugin format (#1) — S, opens distribution channel
2. Witness verification (#3) — S, immediate CI quality win
3. Namespace convention (#8) — S, free
4. 270s heartbeat doc (#6) — S, free

**Sprint 2 (1 week, 1 dev):**
5. Background workers (#2) — M, biggest user-facing shift
6. Persona library (#7) — S, dovetails with #2

**Sprint 3 (1-2 weeks, 1 dev):**
7. Trajectory replay (#4) — M, leverages existing snapshots
8. 3-gate safety (#5) — M, required before any browser/web ingest

**On hold:**
- Federation TS port (#11) — until cross-host use case
- HNSW swap (#15) — until perf data justifies
- GOAP / Federation / SONA (#16, #17, #18) — skip

---

## Anti-recommendations (things NOT to copy)

- **The marketing surface area** — "100+ agents", "150-12,500× faster", "Self-Learning System". Many are external-pkg-backed claims or persona counts inflated by listing every YAML agent file. Pick portable patterns, not slogans.
- **The orchestrator/executor split** — D:\MCP IS the executor + substrate; you don't need to split into a separate "ledger" process.
- **The plugin proliferation** — 33 plugins is too many for D:\MCP's product surface. Start with 3-5 (`code-indexer-core`, `code-indexer-workers`, `code-indexer-safety`).
- **Cron-as-default for everything** — most workers should be event-driven (file change, snapshot, post-task). Reserve cron for true periodic concerns (audit, drift).
- **GitHub-issue-based agent coordination** — ruflo's `swarm.config.ts` routes agent work via GitHub issue labels. Cute for self-hosting but not a product feature.

---

## Anti-patterns observed in ruflo (avoid)

- **Stub code presented as feature** — the in-repo `AgentDBBackend.ts` is a `Map`+brute-force stub, but it lives alongside the marketing about HNSW. Be careful what the codebase presents as implemented vs. what's behind an `optionalDependency`.
- **Two namespace conventions side-by-side** — `pattern` vs `patterns` are different stores ([`ruflo-intelligence README`](file:///D:/scratch/ruflo/plugins/ruflo-intelligence/README.md) explicitly warns about this). Pick one when you adopt namespaces.
- **Heavy reliance on external optional deps** — most "killer features" are `optionalDependencies` (`@ruvector/sona`, `agentdb`, `agentic-flow`). The core repo is mostly orchestration glue. D:\MCP should keep features in-tree where reasonable so the contract is enforceable.
- **README claims that drift from code** — "100+ agents" appears in v3.7.0 README; package.json description says "60+"; `swarm.config.ts` defines 15. Pick honest numbers.
