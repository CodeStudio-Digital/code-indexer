# Live agent effectiveness benchmark

This benchmark runs the real coder runner against fresh copies of a small
oracle project. It is intentionally different from historical telemetry:
every case has a deterministic verifier and every run records model, agent,
tools, usage, elapsed time, changed files, final text and provider swaps.

## Cases

| Case | Agent | Pass condition |
| --- | --- | --- |
| `explore_session_expiry` | explore | Finds both TTL sources, identifies the disconnected config, traces expiry, changes nothing |
| `plan_login_lockout` | plan | Submits a scoped plan with the real files, risks and tests, changes nothing |
| `build_invoice_rounding` | build | Fixes the seeded invoice bug and only the production file |
| `builder_paused_badge` | builder | Fixes the accessible paused badge and only its production file |
| `admin_release_branch` | admin | Creates the requested branch and exact release marker |

The default comparison is the configured Z.AI weak/current pair:
`glm-4.7-flash::coding` and `glm-5.2`.

## Running

Because the desktop database uses Electron's native ABI, run through Electron:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\.bin\electron.cmd .\node_modules\tsx\dist\cli.mjs scripts/bench-agent-effectiveness-live.ts
```

By default the harness asks the running CodeStudio API at
`http://127.0.0.1:7333` to build the fresh fixture's real semantic generation
and waits for complete vector coverage before starting the agent. This is
required for claims about semantic-search effectiveness. Use
`--semantic-index off` only for an explicit FTS-fallback control, or
`--api-base` when the API listens elsewhere.

Useful filters:

```powershell
# One smoke case on one model
.\node_modules\.bin\electron.cmd .\node_modules\tsx\dist\cli.mjs scripts/bench-agent-effectiveness-live.ts `
  --models glm-5.2 --cases build_invoice_rounding --repetitions 1

# Full paired matrix with five repetitions
.\node_modules\.bin\electron.cmd .\node_modules\tsx\dist\cli.mjs scripts/bench-agent-effectiveness-live.ts `
  --repetitions 5
```

Fresh projects are retained under `.tmp/agent-effectiveness/runs` for audit.
JSON and Markdown reports are written under `.tmp/agent-effectiveness/reports`.

## Deterministic guardrail A/B

The retrieval guard is runtime logic, not prompt text. It coalesces compatible
same-batch greps, defers a broad repo map when targeted semantic search is
already present, and leaves potentially complementary sibling searches intact.
Every requested tool call still receives a protocol-balanced result.

The finish-evidence guard is also runtime logic. After a successful current-run
write, a text-only finish is delayed once when no successful test, typecheck,
lint, or build covers the latest write. The injected instruction is short and
bounded: validate now, or accurately say why validation is unavailable. It
does not loop and it does not affect read-only work.

For implementation cases, `submit_plan` is approved automatically so the same
run proceeds through edit and validation. Only the `plan_login_lockout` case
rejects the captured plan, because its deliverable is the plan itself.

Reports separate:

- requested calls (model behavior);
- executed calls (provider/backend cost);
- coalesced calls (guard intervention);
- task correctness, tool-count efficiency and deterministic trajectory checks.

Run the same matrix twice to compare guard off/on:

```powershell
.\node_modules\.bin\electron.cmd .\node_modules\tsx\dist\cli.mjs scripts/bench-agent-effectiveness-live.ts `
  --cases explore_session_expiry,plan_login_lockout --repetitions 3 --retrieval-guard off

.\node_modules\.bin\electron.cmd .\node_modules\tsx\dist\cli.mjs scripts/bench-agent-effectiveness-live.ts `
  --cases explore_session_expiry,plan_login_lockout --repetitions 3 --retrieval-guard on
```
