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
