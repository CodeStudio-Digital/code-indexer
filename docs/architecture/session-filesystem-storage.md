# Session filesystem storage

Status: normative for the filesystem-session cutover.

## Authority

SQLite is not a session store. The target authority for physical session
persistence is the Rust `agent-session-store`: it owns the per-session writer
lease, assigns the canonical sequence, commits the journal and publishes
projections, artifacts, checkpoints and metric rollups.

The TypeScript host remains the semantic control/integration plane: it decides
commands, policy, provider bindings and user-visible projections, but it does
not implement filesystem commits after a bundle moves to the Rust storage
generation. The host invokes the native store through generated, idempotent
contracts and an opaque in-process Rust bridge owner. Wire requests carry only
registered `root_id` values and writer handles, never mutable filesystem paths.
The host only acknowledges a durable transition after receiving the Rust commit
receipt.

The existing TypeScript `FileSessionRepository` is the transition writer for
bundles that have not moved yet. A bundle has exactly one persisted
`storageGeneration` and one writer implementation at a time:

- `typescript_fs_v1` while the legacy filesystem writer is authoritative;
- `rust_fs_v1` after drain, verification and fenced lease transfer.

Rust agent execution does not require an immediate storage transfer: during
rollout it may submit commits through the host to the currently selected
writer. Conversely, legacy execution may use the Rust writer through the same
neutral facade. Dual-write and concurrent TypeScript/Rust writers are
forbidden. After `rust_fs_v1`, TypeScript reads through Rust queries or
immutable published projections and never opens mutable bundle files.

There is no dual-write, SQLite fallback, or legacy-ID lookup after cutover.
Public session IDs are opaque UUID strings. Sequence numbers order records;
UUID lexical order never does.

## Placement

- Project-owned coder, single-project Company, and Sprite sessions:
  `<project>/.mcp-indexer/session/<uuid>`.
- Global coder, multi-project Company, and App Studio sessions:
  `<MCP_DATA_DIR>/sessions/global/<uuid>`.

Missing, read-only, symlinked, or otherwise unsafe roots fail closed. A
project-owned session is never silently redirected to the global data
directory.

## Bundle

Each bundle has `session.json`, `state.json`, `conversation.jsonl`, and
independent directories for attachments, tool outputs, snapshots, metrics,
events, checkpoints, chapters, plans, tasks, inputs, memory, subagents,
Company data, and Sprite data. Para `rust_fs_v1`, `session.json` é o manifesto
imutável com layout version, session ID, `storageGeneration` e a referência ao
`storage-authority.jsonl`. Esse authority log é append-only e hash-chained:
cada transição persiste o próximo lease epoch e o writer ID. A identidade do
último commit durável vem do journal/receipt, não de atualização in-place do
manifesto.

`conversation.jsonl` is canonical and append-only. Every line is a complete
commit containing a monotonic sequence, operation ID, storage generation,
lease epoch, writer ID, durability class, previous hash, current hash, payload,
and artifact references. Artifacts are content-addressed and durably committed
before the line that references them. O receipt idempotente repete essa
identidade fenced e não pode ser usado por outra sessão, generation ou epoch.

Mutable projections such as `state.json` are written to a same-directory
temporary file, fsynced, renamed, and followed by a best-effort directory
fsync. Recovery truncates only an incomplete final JSONL line and rejects hash
or sequence divergence.

Session metrics are also filesystem data. Durable usage, cost, lifecycle and
resource rollups live under `metrics/` in bounded, versioned segments.
High-frequency samples are coalesced before commit and rotate by byte/time
quota; session/run IDs belong in journal or traces, never as unbounded metric
labels. Ephemeral pulse samples, secrets, provider credentials and raw
environment values are never persisted.

## Concurrency and deletion

One Rust-owned writer queue and one fenced lease exist per session after
`rust_fs_v1`. Work on separate sessions can proceed independently. A duplicate
writer or stale lease epoch cannot commit. Runners and the supervisor never
open the bundle directly; they submit bounded records to the storage owner.

Storage transfer requires: stop admission for the bundle, drain in-flight
commits, verify journal/hash/projections, advance the persisted lease epoch,
activate the new writer and only then reopen admission. Failure before
activation leaves the old generation authoritative; failure after activation
recovers in Rust and never falls back to a TypeScript writer.

Archiving changes `state.json`. Normal deletion atomically renames the complete
bundle into a trash directory on the same volume. Permanent deletion is a
separate explicit operation and must not traverse symlinks or junctions.

## SQLite boundary

SQLite retains shared catalogs and index data: projects, indexing and semantic
state, providers, credentials, MCP configuration, plugins, global settings,
skills, phase profiles, reusable pipelines, Company templates, and project
memory/snapshots that are not owned by a session.

Coder/Company/App Studio/Sprite runtime data, control-plane execution journals,
session metrics, tool outputs, and session-scoped overrides are forbidden in
SQLite. They are owned by the filesystem bundle and, after storage transfer,
physically committed by Rust. Mixed tables are cleaned through explicit row
and column dispositions; table names are never inferred by wildcard.

Application startup refuses a legacy database that still contains session
state. The only supported cutover is the offline
`pnpm sessions:fs-migrate` command, followed by complete verification and
irreversible removal of the source database.

## Offline cutover runbook

Run the inventory first while the application is stopped:

```text
pnpm sessions:fs-migrate -- --dry-run
```

The dry run checks SQLite integrity in strict read-only mode, inventories all
declared session tables and side stores, validates every project/global root,
estimates space, audits active processes, and reports unresolved relationships
without acquiring the mutating maintenance lock, changing the database, or
publishing bundles.

After every diagnostic is resolved, execute the one supported cutover:

```text
pnpm sessions:fs-migrate -- --apply --delete-source-db
```

Export happens in same-volume staging directories. Completed bundles are
resumable through `migration.json`; the source database remains authoritative
and untouched until all hashes, counts, links, UTF-8 records, artifacts and
runtime projections pass verification. The command then cleans and vacuums a
clone, performs an offline application smoke test, atomically swaps the clone,
reopens every bundle, and only then removes the source database plus WAL/SHM and
staging files. Failure before the swap leaves the original database intact.

Verification can be repeated independently:

```text
pnpm sessions:fs-migrate -- --verify-only
```

Do not manually add the layout marker. It is evidence produced by the verified
cutover, not an override. The application also validates the post-cut schema
and rejects forbidden tables, mixed session rows/columns, or missing write
guards even when a marker exists.
