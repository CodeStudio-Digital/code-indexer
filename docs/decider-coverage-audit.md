# Decider-coverage audit (X1 — Sprint 1)

Status: read-only audit, no code changes.

## Scope

Survey every `enable(): boolean { return true; }` hardcoded in the pipeline `stages.ts` files. For each, recommend either:

- **ALWAYS-ON**: removing the stage would break the pipeline (or its absence carries no observable cost). No flag needed.
- **FLAGGABLE**: stage has a measurable cost (embedding call, LLM call, branch with non-trivial CPU) or experimental status. Adding a Decider flag would let admins toggle it per-tier/per-session.

The audit found **40 hardcoded `return true` enable() bodies** across 5 stages files:

| File | Hardcoded count |
|---|---|
| `packages/company/src/role-pipeline/stages.ts` | 7 |
| `packages/company/src/kanban-priority/stages.ts` | 9 |
| `packages/code-agent/src/tool-selection/stages.ts` | 5 |
| `packages/code-agent/src/context-relevance/stages.ts` | 10 |
| `packages/code-agent/src/todo-priority/stages.ts` | 10 |

## Findings per file

### role-pipeline (7 stages)

| Line | Class | Verdict | Reasoning |
|---|---|---|---|
| 80 | `TemplateRosterSource` | **ALWAYS-ON** | Primary candidate source. Without it the pipeline has nothing to score. |
| 116 | `RoleEmbeddingHydrator` | **FLAGGABLE** | Calls `embed(roleDescriptionText)` per candidate — embedding network calls. Flag: `role_pipeline.embedding_hydrator`. Disabled = `TwoTowerScorer` falls back to 0 affinity. |
| 143 | `CapacityFilter` | **ALWAYS-ON** | Hard constraint — capacity overflow breaks downstream. |
| 217 | `TwoTowerScorer` | **FLAGGABLE** | Needs `taskEmbedding` AND `roleEmbedding` — both potentially absent. Already guards via `q.taskEmbedding?` check; adding a flag would let admins disable two-tower entirely. |
| 242 | `CostScorer` | **ALWAYS-ON** | Cheap (no I/O), small but useful signal. |
| 257 | `ReuseBonusScorer` | **ALWAYS-ON** | Pure math. |
| 284 | `DiverseTopKSelector` | **ALWAYS-ON** | Required terminal stage. |

**Recommended new flags**: `role_pipeline.embedding_hydrator`, `role_pipeline.two_tower`.

### kanban-priority (9 stages)

| Line | Class | Verdict | Reasoning |
|---|---|---|---|
| 64 | `KanbanCardsSource` | **ALWAYS-ON** | Primary source. |
| 74 | `ActiveColumnFilter` | **ALWAYS-ON** | Hard scope filter (only active cards). |
| 90, 105, 120, 138, 156 | Various scorers (Impact, Effort, BlocksOthers, BlockedBy, Urgency) | **ALWAYS-ON each** | Pure CPU, fast, signals fuse into final score. Disabling individually would skew prioritization — preferable to tune weights via Decider on `WeightedFusionScorer` instead. |
| 192 | `RoleAvailabilityScorer` | **FLAGGABLE** | Reads from external state (running roles). Could be expensive on large workspaces. Flag: `kanban_priority.role_availability`. |
| 217 | `PrioritySortSelector` | **ALWAYS-ON** | Required. |

**Recommended new flags**: `kanban_priority.role_availability`, `kanban_priority.weights` (object-valued — admin overrides individual scorer weights via Decider value rather than hardcoded `DEFAULT_WEIGHTS`).

### tool-selection (5 stages)

| Line | Class | Verdict | Reasoning |
|---|---|---|---|
| 59 | `TaskEmbeddingHydrator` | **FLAGGABLE** | Embeds the task text — network call. Currently always on. Flag: `tool_selection.task_embedding`. Already has a thin-path cache (A4) but the flag would let admins disable embedding-based selection entirely (fall back to frequency-only). |
| 82 | `ToolRegistrySource` | **ALWAYS-ON** | Primary source. |
| 116 | `ToolEmbeddingHydrator` | **FLAGGABLE** | Embeds each tool description — N embeddings. Cached but still I/O on miss. Flag: `tool_selection.tool_embedding`. |
| 235 | `WeightedFusionScorer` | **ALWAYS-ON** | Final fusion — disabling means no score. |
| 262 | `EssentialAwareTopKSelector` | **ALWAYS-ON** | Required terminal. |

**Recommended new flags**: `tool_selection.task_embedding`, `tool_selection.tool_embedding`, `tool_selection.scorer_weights` (object).

### context-relevance (10 stages)

This pipeline is the most flag-dense — used during compaction, every saved/dropped message has a token cost.

| Line | Class | Verdict | Reasoning |
|---|---|---|---|
| 59 | `TaskEmbeddingHydrator` | **FLAGGABLE** | Same as tool-selection. Flag: `context_relevance.task_embedding`. |
| 80 | `SessionMessagesSource` | **ALWAYS-ON** | Primary source. |
| 113 | `MessageEmbeddingHydrator` | **FLAGGABLE** | Embeds each message — significant cost in long sessions. Flag: `context_relevance.message_embedding`. |
| 123, 144 | Guard filters (SystemMessage, RecentTurns) | **ALWAYS-ON** | Hard "pin" filters — never remove these messages. |
| 188 | `AtomicBlockFilter` | **ALWAYS-ON** | Atomicity constraint. |
| 206, 223, 240 | Various scorers (TaskAffinity, Recency, InfoDensity, DecisionMarker) | **MIXED** | TaskAffinity needs embedding (flag-coupled to MessageEmbeddingHydrator). Recency + InfoDensity + DecisionMarker are pure functions — always on. **DecisionMarker is BLINDADO per plan guard-rails — never gate it.** |
| 268 | `BudgetAwareSelector` | **ALWAYS-ON** | Required terminal. |

**Recommended new flags**: `context_relevance.task_embedding`, `context_relevance.message_embedding`, `context_relevance.task_affinity_scorer`. **NEVER FLAG `DecisionMarkerScorer`** — it protects compaction quality per plan §"Guard-rails de não-regressão" #6.

### todo-priority (10 stages)

Similar shape to kanban-priority. Most scorers are pure CPU and cheap.

| Line | Class | Verdict | Reasoning |
|---|---|---|---|
| 37 | `TodoListSource` | **ALWAYS-ON** | Primary source. |
| 47 | (filter — likely Status/Done) | **ALWAYS-ON** | Hard scope filter. |
| 82, 100, 117, 136, 155, 171, 186 | Scorers (Impact, Urgency, Dependencies, etc.) | **ALWAYS-ON** | Pure functions. |
| 215 | Selector | **ALWAYS-ON** | Required terminal. |

Only candidate for flag: if any stage does semantic dependency detection via embedding (per `catalog.ts` line 86 hint), that one would be flaggable as `todo_priority.semantic_dependency`. Requires reading the actual file to confirm.

**Recommended new flags**: `todo_priority.semantic_dependency` (if present).

## Summary

| Pipeline | Total stages | Always-on | Flaggable | Currently flag-aware |
|---|---|---|---|---|
| role-pipeline | 7 | 5 | 2 | 0 |
| kanban-priority | 9 | 8 | 1 | 0 |
| tool-selection | 5 | 3 | 2 | 0 |
| context-relevance | 10 | 7 | 3 | 0 |
| todo-priority | 10 | 9-10 | 0-1 | 0 |
| **Total** | **41** | **32-33** | **8-9** | **0** |

## Recommended next steps (NOT Sprint 1 — defer to Sprint 2)

1. **Wire Decider into pipeline factories** (`createRolePipeline`, `createToolSelectionPipeline`, etc.). Each factory accepts an optional `decider?: Decider` + `deciderContext?: DeciderContext`. Hardcoded `return true` becomes `return decider?.isEnabled('<flag>', ctx) ?? true` — flag absence defaults to current behavior (bit-identical).
2. **Add the 8 flag entries above to `packages/services/src/pipelines/catalog.ts`** so the admin panel can render them.
3. **For scorer-weights flagging** (`role_pipeline.weights`, `kanban_priority.weights`, `tool_selection.scorer_weights`): replace the hardcoded `DEFAULT_WEIGHTS` objects with a Decider lookup that falls back to the constant. Lets admins tune weights per-tier without redeploy.
4. **Bench impact**: each flagged stage that gets disabled must have a baseline → comparison run. Disabling embedding hydrators is the most cost-impactful — measure tokens saved vs recall lost.

## Out-of-scope this sprint

- Actually wiring the flags (Sprint 2 — needs bench discipline X2 in place first).
- `DecisionMarkerScorer` flag — explicitly forbidden per plan guard-rails.
- Removing always-on `enable()` methods (don't simplify away — keeps the trait surface uniform for future decider plumbing).

## Cross-reference

- Plan §"Recomendações por área" item X1
- `packages/services/src/pipelines/decider.ts` — `ConfigJsonDecider` + `EnvVarDecider` + `CompositeDecider` chain
- `packages/services/src/pipelines/catalog.ts` — admin panel binding catalog
