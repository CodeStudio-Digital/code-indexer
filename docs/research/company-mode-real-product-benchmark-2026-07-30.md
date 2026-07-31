# Company Mode real-product benchmark — DeployGuard Release Control

Date: 2026-07-30  
Company session: `b18d4596-cb09-41bb-ab39-17770e68543b`  
Runtime: CodeStudio started through `pnpm`, exercised through its HTTP/SSE API  
Provider: Z.AI  
Final outcome: **accepted and finalized**

## Executive result

The benchmark produced a real three-project product, not a synthetic tool-call
exercise:

- Backend Node/TypeScript API with a release state machine, dual approvals,
  optimistic concurrency, idempotency and immutable audit history.
- Public React/Vite/TypeScript frontend with typed reads, filters, responsive
  views, loading/empty/error states and an audit timeline.
- React/Vite/TypeScript admin console with create, submit, role approvals,
  revision-protected promotion, visible 409 handling and audit inspection.
- 75 non-generated project files outside `node_modules`/`dist`.
- **131/131 tests passing** and all three production builds passing.
- A real HTTP smoke exercised the backend end to end.
- Five defects were found, assigned back to owners, fixed and independently
  revalidated.
- **9/9 Kanban cards reached Done**, all subordinate runs were shut down, and
  the SSE stream ended with `reason=finalized`.

The run succeeded, but not without operator intervention. The Master attempted
to accept the product before two integration/cleanliness issues were closed,
and QA initially published inaccurate final evidence. This is the main product
learning: model strength helps, but Company Mode needs small objective gates
that make premature acceptance impossible.

## Scenario and team

The product governs promotion of software releases through environments. Its
shared contract required:

- `draft -> ready -> approved -> deployed`;
- distinct `engineering` and `operations` approvals;
- the same actor cannot occupy both approval roles;
- promotion with `expectedRevision` and `409 REVISION_CONFLICT`;
- idempotent create and promote operations;
- an immutable audit trail;
- a standard `{ error: { code, message, details? } }` envelope.

The team deliberately mixed model strengths:

| Role | Z.AI model | Project scope |
|---|---|---|
| Master | `glm-5.2` | Backend + Frontend + Admin |
| Architect | `glm-5.1` | Backend + Frontend + Admin |
| Backend | `glm-5` | Backend |
| Frontend | `glm-4.5` | Frontend |
| Admin | `glm-5.1` | Admin |
| QA | `glm-5.2` | Backend + Frontend + Admin |

`glm-4.5` was intentionally the weak control. `glm-4.7` remained in the
allowed-model catalog but was not assigned to a role in this scenario, so this
report makes no comparative claim about it.

## Work graph and real interaction

The Master created a nine-card DAG:

1. Architect publishes the authoritative API/integration contract.
2. Backend implements against the contract.
3. Frontend implements against the contract.
4. Admin implements against the contract.
5. Architect cross-reviews all three implementations.
6. QA independently validates the three products.
7. Owners fix the defects returned by QA.
8. QA revalidates the fixes.
9. Master verifies evidence, moves every card to Done and finalizes.

The three implementation cards ran in parallel after the contract gate. The
Architect used Shared Drive for the contract and review report; implementation
agents and the Master used Board posts for handoffs and evidence; QA used the
same Drive path for corrected final reports. This proved that the useful
coordination unit is:

`Kanban state + Drive contract + short Board evidence`

It does not require copying a large company manual into every prompt.

## Acceptance evidence

| Project | Tests | Build | Additional evidence |
|---|---:|---|---|
| Backend | 54/54 | `tsc` exit 0 | Live HTTP domain smoke passed |
| Frontend | 47/47 | `tsc + vite` exit 0 | API-port regression test |
| Admin | 30/30 | `tsc -b + vite` exit 0 | No React `act(...)` warnings |
| **Total** | **131/131** | **3/3 green** | **0 open defects** |

All three clients now integrate out of the box at
`http://localhost:3000/api/v1`.

The final independent report is stored in Company Drive as
`reports/qa-final.md`. Other durable artefacts include:

- `contracts/deployguard-api.md`;
- `reports/backend-impl-notes.md`;
- `reports/architect-review.md`;
- `reports/qa-report.md`;
- `reports/qa-report-addendum.md`.

## Defects found during the run

| ID | Owner | Finding | Final state |
|---|---|---|---|
| FE-001 | Frontend | Default test command stayed in watch mode | Closed with `vitest --run` |
| BE-001 | Backend/QA | QA left a scratch `smoke.ps1` in the project | Removed; expected npm shims retained |
| AD-001 | Admin | Tests passed but emitted React `act(...)` warnings | Closed and revalidated |
| FE-002 | Frontend | Frontend defaulted to port 3001 while backend used 3000 | Closed with source, README and regression test |
| AD-002 | Admin | A stray `vite-dev.log` remained locked in the root | Exact Vite PID stopped; file removed |

The important negative result is that the first QA verdict said there were no
defects even though FE-001 existed, and the first final report omitted the
frontend defect history and made an over-broad claim about PowerShell files.
The operator rejected those conclusions and forced fresh evidence. The final
report is accurate.

## Measured agent/model telemetry

The table was derived from the completed SSE event log. Input/cache counts are
provider-reported tokens. Provider time is the sum of provider-call elapsed
time per role, not wall-clock time. Admin aggregates the original and
replacement Admin runs.

| Role/model | Provider calls | Tool calls | Tool errors | Input tokens | Output tokens | Cache hit | Compactions | Provider min |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Architect / `glm-5.1` | 24 | 47 | 1 | 689,568 | 13,243 | 81.7% | 0 | 4.72 |
| Backend / `glm-5` | 42 | 59 | 5 | 1,335,249 | 26,708 | 93.4% | 0 | 7.92 |
| Frontend / `glm-4.5` | 80 | 130 | 22 | 5,070,006 | 44,239 | 85.9% | 4 | 38.47 |
| Admin / `glm-5.1` | 119 | 143 | 12 | 6,492,154 | 39,588 | 94.8% | 2 | 15.96 |
| QA / `glm-5.2` | 34 | 64 | 1 | 1,771,685 | 16,602 | 93.4% | 0 | 6.05 |
| Master / `glm-5.2` | 54 | 97 | 4 | 2,106,032 | 16,190 | 94.1% | 0 | 8.24 |
| **Total** | **353** | **540** | **45** | **17,464,694** | **156,570** | **91.3%** | **6** | **81.36** |

No Z.AI 429/rate-limit response appeared in the final scenario.

### Model conclusions

`glm-5` was the best implementation-efficiency point in this run. Backend
delivered the strongest domain component, 54 tests and live HTTP evidence with
far fewer calls/tokens than either UI role.

`glm-4.5` was capable of eventually finishing the React frontend, but it was
not production-efficient: 80 provider calls, 22 tool errors, four compactions,
the longest provider time, an early false completion, and two owner defects.
It is useful as a deliberately weak benchmark baseline, not as the default
cross-project frontend agent.

`glm-5.1` was strong for architecture and UI implementation, but the Admin path
showed severe status/polling waste. A replacement run was required for the
cleanup defect. The quality was good; the stopping behavior was not.

`glm-5.2` coordinated the DAG and performed the best final QA, but strength did
not eliminate acceptance bias. The Master tried to finalize prematurely and QA
needed two report corrections. Objective gates must remain authoritative over
the model's prose verdict.

The 91.3% cache ratio is healthy, but it does not make a 17.5M-input-token run
efficient. Repeated full-history turns and status polling, especially in
Frontend/Admin, dominate the cost.

## Company utility assessment

### Kanban

Useful and operational. Dependency gates correctly refused implementation
cards before the contract card was Done. The DAG made parallel work and final
coverage visible.

One design flaw surfaced: a single “Owners fix QA defects” card represented
simultaneous work by multiple owners. Assignment/reconciliation semantics are
agent-centric, so the shared card was reset/re-moved during retries. Default
templates should create one defect-fix card per owner and let the QA
revalidation card depend on all of them.

### Shared Drive

The strongest Company primitive in this scenario. It prevented contract
duplication in prompts, gave every project the same authority, and let QA
correct one canonical final report by overwriting the same path.

The recommended rule is simple: contracts, cross-project decisions and formal
verification live in Drive; transient progress does not.

### Board and communication

Board posts produced an auditable chain of decisions, handoffs and defects.
However, agents treated status metadata as if it controlled runner lifecycle
and sometimes kept polling after a deliverable. Deliverable, status and
interactive-question semantics must be encoded in tool behavior/schema, not
repeated in a long prompt.

Inbox was not materially exercised by this scenario; no maturity claim should
be made from this run alone.

### Memory / semantic retrieval

Memory was deliberately non-blocking. The runtime reported no active semantic
generation for projects 187, 188 and 189, plus failed vector upserts. The team
still completed because Drive held the authoritative cross-project state.

This is the correct failure posture, but not evidence that Company memory is
effective. A separate benchmark must prebuild the semantic generations and
measure whether recall reduces exploration/tool calls across successive
sessions. Company should never turn missing vectors into a delivery blocker.

## Platform corrections produced by the benchmark

The following changes were made in the real runtime path and covered by focused
regressions:

1. Ignore completion callbacks from a stale pre-resume runner so they cannot
   overwrite the active replacement run.
2. Restore multi-project scope, Docs research wiring and supervisor wiring when
   a subordinate is resumed.
3. Make `wait=true` use the Company wait loop and prevent the generic five
   minute tool timeout from cutting off healthy agents.
4. Assign auto-created Kanban cards only after the runner exists, eliminating
   false “dead worker” resets.
5. Arm interactive waiters before emitting the prompt, preventing synchronous
   approvals from being lost.
6. Make blocker posts classifications rather than hidden whole-session aborts.
7. Force deliverable/handoff/blocker posts to be fire-and-forget, preventing
   weak models from deadlocking their final report.
8. Clarify that `set_agent_status` is metadata only and require agents to stop
   after the final deliverable instead of polling.
9. Treat an older failed run as superseded when a newer run of the same role
   finishes successfully; keep a latest failure visible.
10. Give QA/reviewer roles one short verification policy: finite checks, no
    product edits or scratch artefacts unless explicitly assigned a fix, exact
    evidence in Drive.
11. Await terminal Company persistence during finalization.
12. Read fresh `session.json`/`state.json` projections in the HTTP process so a
    worker-finalized Company is not displayed indefinitely as `running`.

The lifecycle/API fix in item 12 was discovered at finalization: SSE correctly
ended with `reason=finalized`, but the already-running HTTP process returned its
cached `running` projection. The new regression writes `completed` through an
independent repository instance and confirms both get/list APIs see it.

## Recommended default advanced template

For a three-project Backend/Frontend/Admin company:

| Role | Default model | Rule |
|---|---|---|
| Master | `glm-5.2` | Orchestrate only; final evidence gate is mandatory |
| Architect | `glm-5.1` | Publish one Drive contract; cross-review integration |
| Backend | `glm-5` | Implement and test one bounded backend card |
| Frontend | `glm-5` | Prefer over 4.5 for cross-project integration |
| Admin | `glm-5.1` | Complex mutation UI and conflict handling |
| QA | `glm-5.2` | Read-only verification by default; owners fix defects |

`glm-4.5` should be an explicit economy/baseline option with a visible warning
that additional verification is expected. It should not be the novice default
for a role that owns integration correctness.

The prompt for each role should contain only:

1. specialty and project scope;
2. the assigned card with exact acceptance commands;
3. where the authoritative Drive contract lives;
4. the final deliverable/stop rule.

Everything else belongs in tool schemas, Kanban state or Drive. This is both
shorter and more effective than a generic “company bible”.

## Acceptance gates to enforce in product

Before the Master may finalize an advanced Company:

- every Kanban card is Done and all dependencies are closed;
- every required Drive artefact exists;
- each project has an explicit finite test/build command and recorded exit
  status;
- declared test counts match fresh output;
- cross-project endpoints/configuration match the Drive contract;
- QA reports zero open defects or links every open defect to a non-Done owner
  card;
- scratch artefact checks ignore generated dependency directories but inspect
  project roots;
- older failed retries do not poison the final state after a newer successful
  replacement;
- the persisted Company session reaches `completed` before the SSE bus emits
  final `done`.

These gates should be executable data checks. The Master may summarize them,
but must not be able to override them with prose.

## Reproducible artefacts

Product roots:

- `D:\MCP\.tmp\company-mode-release-control-20260730\backend`
- `D:\MCP\.tmp\company-mode-release-control-20260730\frontend`
- `D:\MCP\.tmp\company-mode-release-control-20260730\admin`

Evidence:

- SSE log:
  `D:\MCP\.tmp\company-mode-release-control-20260730\s4-resume-sse-v2.log`
- Runtime log:
  `D:\MCP\.tmp\company-benchmark-runtime\stdout-v6.log`
- Final Company Drive report: `reports/qa-final.md` in session
  `b18d4596-cb09-41bb-ab39-17770e68543b`

Platform verification after the fixes:

```text
9 focused test files passed
36 focused tests passed
```

The broad Company TypeScript invocation is not a useful gate in the current
monorepo because it is dominated by known project-reference/rootDir and
`tsbuildinfo` baseline failures. Focused Vitest coverage is green; the
monorepo-wide TypeScript baseline remains a separate cleanup item.

