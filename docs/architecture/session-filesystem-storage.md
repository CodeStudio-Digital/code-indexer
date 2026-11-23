# Session filesystem storage

Status: current TypeScript filesystem implementation.

## Authority

SQLite is not a session store. `FileSessionRepository` and `SessionWriter`
in `packages/session-storage` own the filesystem session bundles. The agent
runs in TypeScript workers and uses these repositories to persist conversations,
state, artifacts and metrics. Session writes do not require a Rust addon or
external supervisor.

There is one fenced writer per session. Public session IDs are opaque UUID
strings; journal sequence numbers order commits. There is no dual-write or
SQLite fallback for session data. The removed Rust runtime is described only
in the [retirement record](./runtime-retirement.md).

## Placement

- Project-owned coder, single-project Company, and Sprite sessions:
  `<project>/.mcp-indexer/session/<uuid>`.
- Global coder, multi-project Company, and App Studio sessions:
  `<MCP_DATA_DIR>/sessions/global/<uuid>`.

Missing, read-only, symlinked, or otherwise unsafe roots fail closed. A
project-owned session is never silently redirected to the global data directory.

## Bundle and recovery

Each bundle contains `session.json`, `state.json`, `conversation.jsonl`,
and directories for attachments, tool outputs, snapshots, metrics, events,
checkpoints, chapters, plans, tasks, inputs, memory, subagents and Company data.

Logical conversation commits form an append-only hash chain. A commit includes
its sequence, operation identity, request hash, payload and artifact references.
Artifacts are committed before the records that reference them. An operation
cannot be replayed with conflicting content. Recovery validates the journal
and can discard an incomplete final record; it rejects sequence or hash
corruption.

In coder sessions, `conversation.jsonl` has one row per active chat message.
Each row contains its role, content blocks and optional assistant phase.
Attachment and tool-result blocks refer to their existing payload files.
The writer appends new messages and rebuilds this projection after a content
patch, rollback, boundary change or interrupted write.

`journal.jsonl` preserves operation identities, checksums and audit data.
When a summary advances the boundary, its chapter directory receives
`messages-<sha256>.ndjson` for original messages and patches and
`records-<sha256>.ndjson` for the corresponding operational records. The
journal points to checked byte ranges in those files. A late edit to an
archived message belongs to its chapter. Opening a chapter reads the requested source rows.

The ChatGPT adapter loads `provider_replay/<sha256>.json` only for assistant
messages included in a continuation for the same account and model whose
visible contents still match. File length, digest and scope are verified.
If an optional continuation file is damaged, the adapter uses the visible
message to continue the conversation and logs the read failure.
Ordinary chat reads expose only the conversation. Session duplication copies
the continuation files alongside the other durable artifacts.

A writer upgrades a legacy bundle under its lease. It persists the new files
before publishing the journal and can regenerate the active transcript after a
crash. A read-only client can still open an older bundle. Backups and moves
should include the entire bundle.

Mutable projections use same-directory temporary files and atomic rename.
The writer lease and persisted fencing counter prevent stale owners from
committing. Different sessions can make progress independently. Deletion uses
an explicit trash operation and must not traverse symlinks or junctions.

Session metrics are filesystem data. Credentials and raw environment values
are not session artifacts.

## SQLite boundary

SQLite retains shared catalogs and index data: projects, indexing and semantic
state, providers, credentials, MCP configuration, plugins, global settings,
skills, phase profiles, reusable pipelines, Company templates, and project
memory/snapshots that are not owned by a session.

Coder/Company/App Studio/Sprite runtime data, session metrics, tool outputs,
and session-scoped overrides belong to the filesystem bundle. Mixed tables
are cleaned through explicit row and column dispositions.

Application startup refuses a legacy database that still contains session
state. The supported cutover is the offline `pnpm sessions:fs-migrate`
command, followed by complete verification and removal of the source database.

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
