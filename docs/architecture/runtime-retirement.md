# Agent runtime after Rust removal

The Rust agent runtime was removed on 2026-10-23. The desktop application now
executes agents through the TypeScript worker path. There is no Rust runner,
supervisor, host addon, runtime selector, Cargo build, or native runtime payload
in new desktop builds.

`packages/agent-runtime-contracts` and `packages/agent-runtime-host` retain the
TypeScript contracts and integration APIs used by the application. Their names
do not imply a native runtime dependency. Filesystem session storage is owned by
`packages/session-storage`; see [session storage](./session-filesystem-storage.md).

The pre-removal implementation and its benchmarks are recoverable from Git
checkpoint `a36c1a94`. Older research and architecture reports describe that
checkpoint or earlier snapshots. They are historical evidence, not requirements
or instructions for building the current product.

The removal does not delete saved conversations or convert persisted data.
Old native-format artifacts must not be treated as TypeScript transcripts by
silently changing an execution or storage marker.
Conversations with an old authoritative journal return HTTP 409 with code
`RETIRED_CONVERSATION_FORMAT` when opened, continued, forked, or duplicated.
Start a new conversation to use the TypeScript runtime. The original files stay
intact, and metadata management (including archiving and deletion) remains available.

Rust language support in the editor and indexer, and unrelated native
dependencies such as SQLite and node-pty, remain part of the product.

## Retirement of the migration switches (2026-10-24)

The four temporary rollouts that expired on 2026-09-30 have no production
environment consumers anymore:

- `CODER_AGENT_RUN_STORE_ENFORCE`
- `CODER_AGENT_RUN_STORE_SHADOW`
- `CODER_CONTROL_PLANE_SHADOW`
- `CODER_RUNTIME_JOURNAL_SHADOW`

The filesystem command ledger and root/child execution fences were already
authoritative in the TypeScript path. The remaining switches incorrectly gated
startup recovery, journal diagnostics and their status display. Recovery now
starts on every boot. Command admission awaits the store's recovery promise,
preventing the startup scan from fencing a newly admitted run. The server uses
the filesystem store's enabled journal default. Old environment values,
including `0`, no longer disable these paths.
Existing diagnostics response field names remain compatible.

This removes the obsolete controls instead of extending their deadlines or
claiming the historical native-runtime canary was completed. The rollout manifest
is empty; its validator still rejects undeclared, expired, duplicate or incomplete
future rollouts. Reintroducing any of these consumers fails the environment audit.

Command idempotency, lease/fencing checks before execution and result publication,
permission checks, cancellation, timeouts, explicit budgets and unknown-outcome
protection remain in place. Tool journal payloads retain hashes instead of raw
inputs/results, and the bounded observational queue remains separate from awaited
authority writes. These changes do not migrate or delete saved conversations.
Rollback requires a reviewed build change; the retired environment variables are
not a supported way to bypass authority or fencing.

Regression coverage includes filesystem persistence and redaction with flags
absent, `0` and `1`; stale-executor rejection after restart recovery; subagent
failure before provider invocation when a fence cannot be established; worker
terminal publication; command replay/uncertain acknowledgement handling; and the
observational queue's capacity limit.
