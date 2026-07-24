# PR split & cleanup plan (working-tree triage)

Operational companion to the convergence roadmap. This documents how to split the
**current uncommitted working tree** into coherent PRs. It is descriptive triage,
not a new architecture decision. Attribution below was verified file-by-file via
`git diff`, not inferred from filenames.

## TL;DR

The working tree mixes **six independent scopes**. Groups A and F are the
convergence roadmap (Phase 1/1-alignment and Phase 2/2.5, see
[15-roadmap-phases-gates.md](./15-roadmap-phases-gates.md)). The rest are
unrelated and should ship as their own PRs so each stays reviewable and
revertible.

## Group A — Control Plane Foundation (roadmap Phase 1)

Durable contracts + command ledger + runtime journal, all **default-off / shadow**
(`CODER_CONTROL_PLANE_SHADOW`, `CODER_RUNTIME_JOURNAL_SHADOW`). No behavior change
unless the flags are set.

New:

- `packages/agent-runtime-contracts/` (whole package: `commands.ts`, `events.ts`, `runs.ts`, `policy.ts`, `environment.ts`, `ultra.ts`, `capabilities.ts`, `artifacts.ts`, `ids.ts`, `version.ts`, `index.ts`, `package.json`, `tsconfig.json`)
- `packages/store/src/control-plane/` (`control-plane-store.ts`, `command-ledger-store.ts`, `runtime-journal-store.ts`, `agent-run-store.ts`, `projection-cursor-store.ts`, `runtime-projection-replay.ts`, `codec.ts`, `types.ts`, `index.ts`, `__tests__/runtime-events.test.ts`)
- `packages/store/src/migrations/251_control_plane_foundation.ts`
- `apps/http-api/control-plane-shadow.ts`

Modified (wiring only):

- `packages/store/src/index.ts` — export `./control-plane/index.js`
- `packages/store/src/migrations/index.ts` — register migration 251
- `packages/store/package.json` — add `@mcp/agent-runtime-contracts` workspace dep
- `tsconfig.base.json` — path alias for `@mcp/agent-runtime-contracts`
- `vitest.config.ts` — test alias for `@mcp/agent-runtime-contracts`
- `pnpm-lock.yaml` — workspace link for the new package
- `apps/http-api/server/deps.ts` — add `controlPlaneStore` to `CoderDeps`
- `apps/http-api/server.ts` — construct store, `recoverInterruptedRuns()` under shadow flag
- `apps/http-api/server/runtime-shutdown.ts` — `setCoderWorkerControlPlaneStore(null)`
- `apps/http-api/server/routes/admin/workers.ts` — expose `controlPlaneShadow` diagnostics
- `apps/http-api/server/routes/coder/stream.ts` — shadow command accept/terminalize
- `apps/http-api/sse/CoderWorkerPool.ts` — control-plane run context
- `apps/http-api/sse/coderWorkerPoolSingleton.ts` — `setCoderWorkerControlPlaneStore`
- `apps/http-api/sse/__tests__/CoderWorkerPool.test.ts` — shadow tests

Reviewer focus: migration 251 is additive; shadow paths must be inert when flags
are off; no secret/prompt lands in the journal.

### A2 — Phase 1 alignment wave (same PR or immediate follow-up)

Contract alignment + divergence audit, delivered after the foundation slice:

- `packages/agent-runtime-contracts/src/events.ts` — `agent_run.created` reclassified to class A + 13 extended A–C event types
- `packages/agent-runtime-contracts/src/runs.ts` — `AgentRunResolution`/`ResolvedAgentRun`/`isResolvedAgentRun`
- `packages/agent-runtime-contracts/src/{capabilities,policy,environment}.ts` — realigned to doc 14 target shapes (no `authorized`, discriminated `ResourceConstraint`, `container|auto`)
- `packages/store/src/migrations/252_control_plane_alignment.ts` (+ test) — event reclassification, `control_plane_divergences`, `wait_mode` immutability trigger (D-013)
- `packages/store/src/control-plane/{run-state-comparator,divergence-store}.ts` (+ tests) — Fase 1D terminal-state comparator
- `apps/http-api/control-plane-shadow.ts` — kill switch per call, generic lifecycle mirror, append-latency percentiles, `mirroredByClass`
- `apps/http-api/sse/CoderWorkerPool.ts` (+ tests) — 12 extended lifecycle mirrors, comparator on `bus.end` and worker-crash paths
- `apps/http-api/server/{deps,routes/admin/workers}.ts`, `apps/http-api/sse/coderWorkerPoolSingleton.ts` — divergence-store wiring + storage endpoint
- `packages/store/src/control-plane/__tests__/journal-privacy.test.ts`, `packages/agent-runtime-contracts/src/__tests__/contracts.test.ts`
- `docs/research/claudeopen-convergence/DECISIONS.md` — D-013/D-014

## Group B — Claude Code provider parity

Provider spec, OAuth, wire-helper and model discovery/display for the
`claude-code` provider. Independent of the control plane.

- `extensions/provider-claude-code/plugin.json`
- `extensions/provider-claude-code/src/spec.ts`
- `packages/provider-engine/src/specs/claude-code.ts`
- `packages/provider-runtime/src/wire-helpers/claude-code.ts`
- `packages/services/src/services/oauth/claude-code.ts`
- `packages/provider-engine/src/__tests__/discovery-claude-code-models.test.ts`
- `src/__tests__/claude-code-oauth.test.ts`
- `src/__tests__/claude-code-wire-helper-parity.test.ts`
- `docs/claude-code-parity.md`
- `apps/dashboard/features/admin/ProviderCard.tsx` — verified: adds `CLAUDE_CODE_MODEL_ORDER` and model-name display for `kind === 'claude-code'` only.

## Group C — LSP / global workspace

- `packages/code-agent/src/lsp/ts-service.ts`
- `packages/code-agent/src/tools/lsp.ts`
- `packages/code-agent/src/lsp/__tests__/ts-service-global-workspace.test.ts` (new)

## Group D — Dashboard global-session workbench (React 19 fix)

Independent bug fix: `usePortalHost` avoids a React 19 max-update-depth loop when
a callback ref is used as a state dispatcher during suspense replay.

- `apps/dashboard/features/chat/global/GlobalSessionWorkbench.tsx`
- `apps/dashboard/e2e/global-session-workbench.spec.ts` (new)

## Group F — Policy Engine shadow (roadmap Phase 2 + 2.5)

Capability Catalog, Policy Engine shadow, resource grants, hook bus and the
composition adapter. All **default-off**; `CODER_POLICY_ENGINE_ENFORCE` is
implemented but dormant (human gate). Depends on Group A (contracts + stores).

New:

- `packages/code-agent/src/core/{capability-catalog,policy-engine,resource-binding,hook-bus,policy-shadow-adapter}.ts` (+ tests, incl. `policy-shadow-burnin.test.ts`)
- `packages/store/src/control-plane/{policy-decision-store,policy-grant-store,capability-store}.ts` (+ tests)
- `packages/store/src/migrations/255_policy_engine.ts`, `256_policy_comparison_latency.ts` (+ tests) — numbered 255/256 because 253/254 were taken (D-017)
- `scripts/check-capability-descriptors.ts` — release descriptor/tier audit CLI
- `packages/code-agent/src/core/runner/nodes/__tests__/executing-dispatch-policy.test.ts`
- `packages/store/src/control-plane/__tests__/policy-privacy.test.ts`

Modified (wiring only):

- `packages/code-agent/src/core/runner/nodes/executing-dispatch.ts` — optional `policyShadow` port BEFORE the permission gate (byte-identical when absent)
- `packages/code-agent/src/core/runner/{types.ts,nodes/executing.ts}`, `packages/code-agent/src/index.ts` — port plumbing + composition (D-016)
- `packages/store/src/migrations/index.ts`, `packages/store/src/control-plane/index.ts` — registrations/exports
- `apps/http-api/server/routes/admin/workers.ts` — `policy-divergences` endpoint + `evaluationOverhead` percentiles
- `docs/research/claudeopen-convergence/DECISIONS.md` — D-015/D-016/D-017

Reviewer focus: with every flag off the dispatch path is byte-identical
(legacy permission/stream-idempotency suites unchanged); grant `once` is CAS;
no raw input/secret lands in policy tables.

## Group E — Do NOT commit / handle separately

- `packages/code-agent/tsconfig.tsbuildinfo` — tracked build artifact, 1-line churn. Prefer `git checkout -- packages/code-agent/tsconfig.tsbuildinfo` (revert). It is regenerated by the build.
- `extensions/unity-scene-analyzer` — submodule pointer shows `-dirty` (uncommitted changes inside the submodule). Unrelated to all groups; do not stage. Investigate/commit inside the submodule on its own.

## Cleanup applied this pass

- `.gitignore` — added `.codex-tmp/`, `debug.log`. **Correction (Fase 2.5):** `scripts/js-debug-adapter-artifact.d.mts` was briefly ignored/removed as an artifact — that was wrong. It is a hand-written declaration REQUIRED by `pnpm typecheck` (imported by `packages/plugin-sdk/src/__tests__/js-debug-adapter-artifact.test.ts`); it is now un-ignored and must be committed as source.
- Removed untracked artifacts: `debug.log`.
- `.codex-tmp/` — now git-ignored; a few residual `mcp-wrangler-debug-smoke-*` dirs could not be deleted this pass because wrangler/miniflare sqlite handles were still locked. They are out of `git status` (ignored); delete them manually after the wrangler/dev process exits, or leave them — they will not be committed.

## Suggested merge order

1. Group A (foundation + alignment wave, flag-gated, self-contained).
2. Group F (Phase 2/2.5 — depends on Group A).
3. Groups B / C / D in any order (independent).
4. Group E is not a PR — revert `tsbuildinfo`, handle the submodule separately.
