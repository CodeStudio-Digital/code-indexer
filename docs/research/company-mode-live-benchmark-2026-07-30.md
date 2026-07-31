# Company Mode live benchmark — 2026-07-30

## Objective

Measure and improve Company Mode through sequential, real multi-project runs.
The benchmark covers delegation, role/project routing, Company Kanban, shared
Drive, peer/master communication, continuation, validation, and novice-friendly
defaults. The provider remains Z.AI so model quality is the controlled variable.

## Model matrix

| Model | Intended use |
| --- | --- |
| `glm-4.5` | stress test for weak specialists and prompt robustness |
| `glm-4.7` | weak baseline specialist |
| `glm-5` | middle baseline |
| `glm-5.1` | stronger specialist/reviewer |
| `glm-5.2` | strongest Master or critical role |

Flash variants are excluded because the provider path has shown instability.

## Fixture

`D:\MCP\.tmp\company-mode-benchmark-20260730` contains three separately
registered projects:

1. `LaunchBoard Benchmark Backend` — in-memory cards API.
2. `LaunchBoard Benchmark Frontend` — public React board.
3. `LaunchBoard Benchmark Admin` — React operations console.

All three start with passing tests/builds and share the same small card contract.

## Metrics

- Completion and wall-clock duration.
- Provider calls, turns, tokens, tool calls, retries, and terminal reason.
- Correct subordinate count and project binding.
- Delegation specificity and unnecessary work.
- Kanban cards created, ownership, dependencies, and terminal columns.
- Shared Drive reads/writes and contract consistency.
- Inbox/board/master communication.
- Files changed per project and cross-project contract agreement.
- Tests/builds executed and their results.
- Approval stalls, tool denials, and idle/wait loops.
- Resume quality in a follow-up turn.

## Scenario log

### S0 — Fixture baseline

Status: passed.

- Backend: 3 tests passed; build passed.
- Public frontend: 2 tests passed; Vite production build passed.
- Admin: 2 tests passed; Vite production build passed.
- Structural index: backend 5 files/8 symbols, frontend 8/23, admin 8/22.

### Live defect 1 — Company worker could not start

The first S1 start returned HTTP 500 before the provider was called:
`[orchestrator-pool] filesystem Company session resolver is not configured`.
The filesystem migration had wired the equivalent resolver for regular coder
workers but omitted Company workers. `createDeps()` now installs a
filesystem-authoritative Company resolver and removes it at shutdown. Focused
coverage verifies global multi-project bundle resolution and fail-closed
behavior when the primary project is unavailable.

### S1 — Minimal company

Planned team: Master `glm-5.2`, Backend `glm-4.7`, Frontend `glm-4.7`.
The Admin project remains connected and is deliberately handled through the
smallest team that can plausibly complete the request. This measures whether
the Master routes multi-project work surgically instead of multiplying roles.

Status: functional pass; orchestration-efficiency fail.

Initial evidence:

- The Master spent three provider turns on goal/board/project/pipeline
  discovery, then delegated three separate read-only investigations before
  implementation. This is correct but unnecessarily expensive for a fixture
  this small.
- The Backend investigation completed cleanly. The Frontend role was correctly
  routed once to Admin and once to the public Frontend because that role is
  explicitly bound to both projects.
- `glm-4.7` on the public Frontend repeated four invalid validation commands
  (`cd` into a non-existent child path and `npm` through a blocked PowerShell
  script) before recovering. This is model-efficiency evidence, not a provider
  or permission failure: the project was already the process cwd and `pnpm`
  worked in the other runs.
- The Master created a useful implementation DAG only after all three
  investigations. No Shared Drive artifact existed at that point despite the
  task making it the authoritative cross-project contract.
- Company runs used unrestricted tool mode and did not stop for approval.

Final evidence:

- Independent validation after the run: Backend 7/7, public Frontend 4/4,
  Admin 5/5; all three builds passed.
- Functional completion took about 30m53s. The stream was aborted at 31m41s
  only to stop the post-completion resurrection loop described below.
- The session made 138 provider calls and returned 190 tool results, 16 of
  them errors. `glm-4.7` accounted for 98 calls across eight runs; the
  `glm-5.2` Master used 40 calls/38 turns.
- `glm-4.7`: 1,255,052 input tokens, 1,107,840 cache-read tokens (88.3%),
  15,908 output tokens, 138 tool results and 13 tool errors.
- `glm-5.2`: 946,672 input tokens, 878,656 cache-read tokens (92.8%),
  8,823 output tokens, 52 tool results and 3 tool errors.
- The implementation Backend alone needed 18 turns and made the same syntax
  mistake in two functions before tests exposed and corrected both instances.
- The final board had 12 cards: only 4 done, with 8 automatic spawn cards and
  9 cards carrying false "worker died" reset comments. The Shared Drive was
  empty even though the Master claimed to have published the contract there.
- After the specialists had already supplied passing test/build evidence, the
  Master spawned three more read-only verification agents. This added 15
  provider calls, 17 tool results and one avoidable Kanban error.

### Live defect 2 — `wait=true` exposed orphan Kanban cards

`spawn_subordinate_agent` created an automatic card in `in_progress`, then
passed `wait=true` into the low-level spawn. The low-level call returns only
after the subordinate exits, so the card remained unassigned for the entire
run. The runtime reconciler observed it between creation and assignment,
incorrectly commented that the worker died, reset it to `todo`, and made it
eligible for duplicate scheduling.

The tool now always obtains the run id immediately, creates/assigns the
automatic card synchronously, and only then performs its optional targeted
wait. Both the spawn and fleet-wait tools explicitly opt out of the generic
five-minute tool timeout because their own wait loop owns a bounded
30-minute deadline. Focused regression coverage verifies ordering, terminal
status, and timeout metadata.

### Live defect 3 — template `projectHints` were documentation-only

The public template contract said symbolic `projectHints` would resolve during
session creation, but the route persisted role assignments unchanged. A user
choosing a template therefore got unbound default agents unless they manually
edited "Agentes por projeto" afterward.

Session creation now resolves hints against the selected projects' labels,
names, and paths, with narrow aliases such as Backend→API/server,
Frontend→web/client, and Admin→console. Explicit selected `projectIds` still
win; unmatched hints remain unbound instead of being guessed. Tests cover
single/multi-project resolution, common aliases, false substring matches, and
explicit-binding preservation.

### Live defect 4 — the master promised Drive usage without Drive tools

The S1 master had 42 visible tools even though its nominal compact cap was 28:
the complete Master tier was protected, so the protected set alone overflowed
the cap. It spent a turn listing pipelines, later said it would publish
`contracts/board-card-contract.md` to the Shared Drive, but
`write_shared_file` had been trimmed. It posted the entire contract to the
Board instead and the Drive remained empty.

The protected surface is now a closed operational loop rather than the entire
Master catalog: delegation/wait, Board, three Kanban operations
(`plan_graph/list/move`), and Drive `write/read/list`, plus the ordinary
lifecycle floor. Pipeline and detailed mutation tools remain discoverable.
The equivalent weak-model test now trims 63 eligible tools to exactly 28
instead of overflowing with 42; both Drive publication and the minimal Kanban
loop survive, while `list_pipelines` and `start_pipeline` do not.

### Live defect 5 — one answered question caused repeated Master resurrection

After the S1 Master had already emitted its final answer and `done`, it was
reactivated twice with "subordinate reported completion". The actual trigger
was the auto-continue flag: `HumanInTheLoop` mirrors an accepted answer into
both its own flag and `MasterLifecycle`, while the consumer used
`human.consume() || master.consume()`. JavaScript short-circuiting left the
second flag armed, so the next terminal Master exit consumed it and launched
another unnecessary run.

The consumer now drains both producers eagerly and only then ORs their values.
A regression test sets both mirrored flags and verifies that the first poll is
true, the second false, and both producers were consumed twice. The complete
focused suite at this checkpoint was 43/43.

### S2 — Expanded company

Planned only after S1 evidence. Candidate additions are Admin, Architect, and
QA, using `glm-4.5`, `glm-5`, and `glm-5.1` selectively.

Reusable template created as id `5`:
`Expandida — Arquitetura + Back + Front + Admin + QA (Z.AI)`.

- Master: `glm-5.2`
- Architect: `glm-5.1`
- Backend: `glm-5`
- Frontend: `glm-4.5`
- Admin: `glm-5.1`
- QA: `glm-5.2`

Each role has a short operational override and symbolic project hints; the
new session-creation resolver will turn those into concrete bindings.

Status: functional pass; lifecycle-efficiency fail.

Early evidence:

- Session creation resolved the template exactly as configured:
  Architect/QA → projects 184/185/186, Backend → 184, Frontend → 185,
  Admin → 186.
- The Master created the intended five-card dependency graph before spawning:
  Architect → Backend/Frontend/Admin → one QA. No automatic cards or false
  worker-reset comments were created.
- The Master published the approved 6,024-byte contract to the Shared Drive
  after the Architect's attempted write landed in the Backend filesystem.
- Backend `glm-5` eventually passed 15/15 tests and build, but needed 30
  provider turns. It introduced an import in the middle of a module, corrected
  it, then needed another failing test cycle before reaching green.
- After an operator interjection documented below, Frontend `glm-4.5` and
  Admin `glm-5.1` started concurrently with `wait=false`.

Final evidence:

- Independent validation after the run: Backend 15/15, public Frontend 4/4,
  Admin 9/9; all three production builds passed.
- All five planned cards reached Done and the Shared Drive retained
  `contracts/release-completion-policy.md` (6,024 bytes). The final QA verdict
  was approved. Unlike S1, there were no redundant investigation agents,
  automatic cards, or false worker-reset comments.
- Functional work finished in about 23m58s. The session was manually aborted
  at 25m59s because a pre-pause QA runner remained alive after a replacement
  runner had already delivered the final verdict.
- The expanded session made 183 provider calls, returned 250 tool results
  (20 errors), consumed 4,327,829 input tokens, 4,044,672 cache-read tokens
  (93.5%), and 39,309 output tokens. Cache behavior was healthy; orchestration
  and prompt/tool mismatches, not cache misses, dominated waste.

Per-role/model evidence:

| Role | Model | Provider calls | Tool results/errors | Input/cache-read | Output | Observed duration |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Master | `glm-5.2` | 25 | 40 / 3 | 495,479 / 443,392 (89.5%) | 9,169 | 25.54m |
| Architect | `glm-5.1` | 24 | 41 / 4 | 436,811 / 410,816 (94.0%) | 7,030 | 3.35m |
| Backend | `glm-5` | 32 | 35 / 2 | 810,516 / 757,632 (93.5%) | 10,184 | 9.53m |
| Frontend | `glm-4.5` | 10 | 14 / 0 | 118,048 / 96,512 (81.8%) | 1,374 | 1.24m |
| Admin | `glm-5.1` | 50 | 63 / 8 | 1,021,678 / 960,512 (94.0%) | 5,464 | 5.34m |
| QA | `glm-5.2` | 42 | 57 / 3 | 1,445,297 / 1,375,808 (95.2%) | 6,088 | 4.97m |

The deliberately weak `glm-4.5` was the most efficient specialist when its
scope was narrow and its contract was already settled: ten calls, zero tool
errors, passing tests/build. Stronger models did not compensate for an
ambiguous process contract. Admin and QA spent 45 combined calls trying to
obey a mandatory memory instruction after the useful work was already done.

### Live defect 6 — multi-project roles collapsed to one project

The Architect role was bound to 184/185/186, but spawning without
`project_id` failed and forced the Master to retry against project 184. The
created coder session, agent-run record, Company authorization context, prompt,
and returned handle all contained only `[184]`. The Architect consequently
inspected Backend only while claiming a three-project review.

Bound roles now resolve one primary root plus their complete configured scope.
Omitting `project_id` chooses the first binding; supplying it only changes the
primary. The complete ordered set is linked into the global coder session and
persisted in the agent run, authorization context, prompt, resume path, and
handle. Unknown Company projects fail closed. Focused tests cover selection,
deduplication, primary ordering, session links, and invalid ids.

### Live defect 7 — subordinate Drive tools were trimmed

The subordinate prompt explicitly required Shared Drive use, but the Architect
had no `write_shared_file` tool in its compact catalog. It therefore wrote
`contracts/release-completion-policy.md` under the Backend filesystem. Admin
later said it would use Drive but called `read_file` twice and received ENOENT.

Drive `write/read/list` is now part of the shared Company floor for Master and
subordinates. A saturated `glm-4.5` catalog still stays at 28 tools while all
three Drive operations, Board, and master escalation survive.

### Live defect 8 — apparent parallel fan-out serialized on `wait=true`

The `glm-5.2` Master emitted Backend, Frontend, and Admin spawns together and
called all three "parallel", but each carried `wait=true`. Tool calls execute in
order, so Backend monopolized the turn and the other two were not spawned.

The compact Master contract and `spawn_subordinate_agent` schema now state one
executable rule: fan-out every independent role with `wait=false`, then call
`wait_for_subordinates` once. `wait=true` is explicitly single-task and
serializing. No extra orchestration chapter was added.

### Live defect 9 — auto-approved interactive post lost its response

Backend attached `awaits_response: approval` to its mandatory deliverable.
`post_to_board` emitted `plan_posted` before arming `waitForUserInput`.
`HumanInTheLoop` auto-approved synchronously, so `provideUserInput` fired
before a waiter existed and the tool remained blocked despite the visible
`plan_auto_approved` event.

The waiter is now armed before both plan/question events. Deliverable,
handoff, and blocker posts also ignore `awaits_response` by contract because
a final artifact must never create a fresh gate. Regression coverage exercises
the synchronous auto-approval race and the final-deliverable safeguard.
The live S2 run was recovered with one explicit operator interjection; Backend
then finished and the Master correctly spawned Frontend/Admin with
`wait=false`.

Current focused regression result after defects 6–9: 55/55 passing (the
smallest rerun of the core new surfaces is 38/38). Package-local TypeScript
`--noEmit` remains obscured by the repository's existing cross-package
`TS6059`/`TS6307` and stale `dist` declaration noise, so runtime verification
after restart remains mandatory.

### Live defect 10 — mandatory memory ritual delayed completed agents

Admin and QA had already produced the required evidence but repeatedly called
tool discovery looking for memory operations that were not visible. The
subordinate system prompt treated memory search/save as a mandatory
pre-deliverable checklist even though the durable contract already existed in
the Shared Drive. This converted optional institutional learning into a
terminal liveness dependency.

The contract is now deliberately small and advisory: search once only before
re-exploring an unfamiliar area and only when the tool is available; save only
a novel fact useful to unrelated future tasks. Agents are explicitly told not
to search for a missing tool, duplicate a Drive contract, save transient task
state, or delay the deliverable for memory work. Regression coverage locks
those negative constraints.

### Live defect 11 — pause changed persistence but did not stop the new runner

Pausing Admin/QA called `CoderRunner.abort()` and persisted `paused`, but the
behavior-tree runtime never consulted the runner's abort flag. A resumed QA
runner therefore ran beside the original one; the replacement posted the
approval while the old runner continued memory-tool discovery. This also kept
the Master finalization path alive until the operator aborted the session.

The host abort flag is now bridged into the behavior tree and checked before
and after every node. An abort arriving during a provider/tool node lets that
single awaited operation settle, then terminalizes with `reason=aborted`
before any subsequent provider or tool turn. A focused regression simulates
an abort during Bootstrap and verifies that Executing is never entered.

### Boundary observation — unrestricted shell can leave a role's primary root

Before the multi-project scope correction was loaded, QA was persisted with
only the Backend project. Native `read_file` correctly rejected Frontend/Admin
paths, but unrestricted `run_command` could still `cd` to their absolute
paths. In S2 the role was intended to own all three projects, so this did not
produce an unauthorized product change; it does prove that role-project scope
is not a shell security boundary in unrestricted mode. S3 must verify native
multi-project routing so no absolute-path escape is needed. Hard shell
confinement is a separate product-policy decision from “Sem Impedimento”.

Current focused regression after the abort and prompt corrections: 7 files,
21 tests, all passing.

### S3 — Short multiproject/Drive acceptance after restart

Status: passed.

This scenario deliberately made no product edits. It used only Master
`glm-5.2`, Architect `glm-5.1`, and QA `glm-5.2` to isolate the corrected
contracts:

1. Master created exactly two dependent cards (Architect → QA).
2. Architect was spawned without `project_id`, received project ids
   `[184,185,186]`, read all three README files through native slug routing,
   and wrote `acceptance/multiproject-routing.md` to the Shared Drive.
3. QA was also spawned without `project_id`, received the same complete
   project scope, read the Drive artifact, independently read all three
   projects through native slug routing, and returned PASS.
4. Both cards reached Done; no automatic cards or extra agents appeared.

The run made 18 provider calls and 22 tool calls with zero tool errors:

| Role | Model | Calls | Tools/errors | Input/cache-read | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| Master | `glm-5.2` | 8 | 8 / 0 | 94,159 / 73,408 | 1,655 |
| Architect | `glm-5.1` | 5 | 8 / 0 | 43,015 / 34,816 | 602 |
| QA | `glm-5.2` | 5 | 6 / 0 | 43,919 / 35,648 | 401 |

The exact specialist tool surface was surgical: Architect used three
`list_directory`, three `read_file`, one `write_shared_file`, and one
deliverable; QA used one Drive read, three native file reads, one glob, and
one deliverable. There were no memory, shell, test, build, absolute-path, or
code-edit calls. The Master catalog was exactly 28 tools.

This closes the boundary observation above for intended multiproject roles:
the normal path no longer requires shell escape. Unrestricted shell remains a
policy boundary, but it did not participate in S3.

### Live defect 13 — finalization completed agents but not the Company session

S3 initially finished all agents and reported “Session complete”, but the
Company row remained `running` and the SSE connection stayed open. The
`finalize_subordinates` tool only changed subordinate rows; ordinary idle
handling later owned the Company row and bus.

Explicit finalization now:

- fences the session as finalized before subordinate status events fire;
- persists Company status `completed`;
- prevents idle handling from downgrading it to `paused`; and
- emits terminal bus event `done { reason: "finalized" }` immediately after
  the Master exits.

The first live verification exposed and removed an ordering race where a
subordinate-change event could enqueue `paused` before the final flag. The
second verification ended with Company `completed`, Master/Architect/QA all
`completed`, terminal event `finalized`, and the SSE client recording
`ended_at`. Focused regression now passes 9 files / 30 tests.

## Product defaults after evidence

Two real reusable Z.AI templates are installed:

1. `Essencial — Master + Backend + Frontend (Z.AI)` — novice/default path:
   Master `glm-5.2`, Backend `glm-5`, Frontend/Admin `glm-4.5`.
2. `Expandida — Arquitetura + Back + Front + Admin + QA (Z.AI)` — advanced
   path: `glm-5.2` Master/QA, `glm-5.1` Architect/Admin, `glm-5` Backend, and
   `glm-4.5` Frontend.

The essential template was updated after the benchmark: `glm-4.7` remains the
weak baseline, not the recommended production specialist. The benchmark does
not support “strongest model everywhere”: `glm-4.5` was fastest and error-free
on the narrow Frontend task, while process loops made stronger Admin/QA runs
expensive.

The novice experience should expose the essential preset as the explicit
recommended choice, not silently invent roles for every Company. Provider
availability and project topology cannot be guessed safely. “Default agents”
therefore means a one-click, short, inspectable team; expanded Architect/Admin/
QA roles stay opt-in when the task really has cross-project contract risk.

## Final validation

- Company-focused regression: 13 files / 39 tests passing, including runtime
  resolution, template project binding, compact tool surface, delegation,
  Board, pause/abort, and finalization.
- Final fixture: Backend 15/15, Frontend 4/4, Admin 9/9; all three production
  builds passing.
- Final S3 lifecycle: Company, Master, Architect, and QA persisted as
  `completed`; the SSE stream ended with reason `finalized`.
- Scoped `git diff --check`: clean.

Package-local TypeScript checks are not reported as a final success signal:
the monorepo currently emits pre-existing `TS6059`/`TS6307` project-boundary
and stale declaration noise outside this Company change. The focused runtime,
route, lifecycle, prompt, delegation, and fixture validations above are the
evidence used for this benchmark.
