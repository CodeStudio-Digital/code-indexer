# Changelog

Notable changes on the `feature/ide-mvp` branch — the IDE Freemium
rewrite on top of the v3.15.1 indexer base. Listed newest first. The
legacy v3.x indexer changelog is preserved at
[docs/CHANGELOG-INDEXER.md](docs/CHANGELOG-INDEXER.md).

## Workspace — JetBrains-style rewrite

### Editor + Git diffs
- **Inline diff viewer** in the editor pane. Click a file in the Git
  tool window to open a read-only side-by-side diff as a tab; staged
  vs unstaged diffs render distinctly. Backed by `react-diff-view`.
- **Open-diff API** on the workspace store — `openDiff({path, title,
  patch, source})` upserts a `kind: 'diff'` tab; re-clicking refreshes
  the patch in place.

### Tool windows (real implementations)
- **Git** — branch · ahead/behind · staged / changes / untracked
  sections with per-file stage / unstage / discard, bulk actions per
  section, commit dialog. Hover a row to reveal actions; click the
  row to open the diff in the editor.
- **Snapshots** — project notes CRUD grouped by category, inline
  editor dialog (title + category + monospace textarea), delete
  confirm.
- **Files** — wraps the existing FileTreeRail; right-click → new file
  / new folder / rename (F2, inline) / copy path / delete.
- **Search** — debounced (300 ms) hybrid FTS5 + vector search; click
  result opens the file.
- **Sessions** — compact list of coder sessions per project; click
  loads in the Chat window (right rail auto-switches).
- **Chat** — wraps the existing AgentChat.
- **Inbox / Problems / Output / Find** — placeholders for now.

### Editor experience
- Welcome screen with brand mark, 2×2 action cards (Quick Open ·
  Project files · Agent chat · Terminal), and shortcut hints.
- Monaco config: font ligatures (JetBrains Mono), bracket pair
  colorization with independent pools, sticky scroll on the TS
  outline, smooth caret animation, subtle minimap, inlay hints
  on-unless-pressed, folding controls on mouseover.
- Multi-tab edits with dirty dot, X on hover, middle-click to close.
- Diff tabs render a `GitCompare` icon and friendly title.
- LSP: TypeScript/JavaScript completion · hover · Ctrl+Click to
  definition · Find All References · 1 s diagnostics polling with
  markers.

### Activity bars + status bar
- Left rail: Files · Search · Snapshots · Git
- Right rail: Chat · Sessions · Inbox
- Status bar (h-5): green dot + project · active file + unsaved
  count · file/symbol totals · LSP idle.
- Layout sizes + active selections persist to localStorage.

### Keyboard shortcuts (global)
- `Ctrl/Cmd+P` Quick Open · `Ctrl/Cmd+Shift+P` Command Palette
- `Ctrl/Cmd+S` save · `Ctrl/Cmd+Shift+S` save all · `Ctrl/Cmd+W`
  close active tab
- `Ctrl/Cmd+B` toggle left rail · `Ctrl/Cmd+Alt+B` toggle right rail
- `Ctrl/Cmd+J` toggle terminal · `` Ctrl/Cmd+` `` toggle bottom panel
- `F2` rename file in tree

## Backend / API

- **`@mcp/api-bus`** — transport-agnostic RPC contract. 16 namespaces.
  `AsyncStream<T>` primitive for streaming. `ApiContext` (user, request
  id, signal). `ApiError` with code + status + details.
- **`@mcp/api-handlers`** — pure handler factories that don't import
  Hono or Electron. Mounted by both the Hono adapter and the Electron
  IPC bridge. Tests can call handlers directly.
- **`@mcp/worker-pool`** — dynamic per-kind worker_threads pool
  (`coder` / `lsp` / `index`). Min/max/idle/auto-scale. Saturation
  queueing with timeout. Currently used opportunistically; in-process
  LSP is the default.
- **`projectGit` namespace** — local working-tree git operations
  (status / diff / log / stage / unstage / discard / commit / branch).
  Wraps the `git` CLI at the project's `root_path`. Distinct from the
  sandbox git surface in `workspace.git.*`.
- **`files` namespace** gained `delete` / `rename` / `mkdir`. Path
  traversal protection via `resolveSafe`. Refuses to delete project
  root. ENOTEMPTY surfaces as a structured 409 so the UI can re-ask.
- **LSP tsconfig references** — `ts-service.ts` walks
  `projectReferences` recursively (Vite / Angular / Solid scaffolds
  finally resolve their imports).

## Electron shell

- **In-process backend** — no child_process, no localhost HTTP exposed
  in production. `createApp()` from `apps/http-api/server` runs in
  the Electron main process.
- **IPC bridge** — preload exposes `window.electronAPI.api.<ns>.<m>`
  via a Proxy that maps to `ipcMain.handle('api:<ns>:<m>')`. Streaming
  methods open a `MessageChannel` per call; main pumps frames onto
  it; renderer wraps the port as `AsyncIterable<T>`.
- **`MCP_DEV_HTTP=1`** (default in `electron:dev`) makes the Hono
  server also listen on `127.0.0.1:3333` so legacy `fetch('/api/...')`
  callsites keep working during migration. `MCP_DEV_HTTP=0` forces
  IPC-only.
- **`scripts/check-undeclared-deps.mjs`** scans for module specifiers
  used without being declared in `package.json`. Caught `node-fetch`
  and `ws` after the migration from a previous package manager.
- **`pnpm.onlyBuiltDependencies`** lists better-sqlite3, electron,
  esbuild, and node-pty so pnpm runs their postinstall (downloads the
  Electron binary, builds the SQLite native).
- **`pnpm electron:rebuild` / `pnpm node:rebuild`** — swap better-
  sqlite3's native ABI between Electron and system Node.

## Dashboard

- **AppShell** — top horizontal nav (h-9, 11px), brand + nav buttons +
  recent-sessions dropdown + language + theme. Hides itself in
  Workspace mode. Padding by default; full-bleed surfaces opt out.
- **Default route swap** — `/projects/:id` → Workspace IDE.
  `/projects/:id/analytics` keeps the legacy 9-tab dashboard.
- **Premium tokens** — dark `#0b0d12` background, electric `#4d8cff`
  primary, `--radius: 6px`, Inter + JetBrains Mono via Google Fonts
  CDN.
- **Chat fix** — bypass Vite proxy in Electron via a global fetch
  interceptor (`install-fetch-base.ts`) that rewrites `/api/*` and
  `/ws/*` to `http://127.0.0.1:3333`. Solved the "iniciando…" hang.

## Docs

- README rewritten — IDE-first, quick start, shortcut table, repo
  layout.
- `docs/ARCHITECTURE.md` — package boundaries, IPC bridge, streaming
  contract, namespaces with their tier gates.
- `docs/IDE_WORKSPACE.md` — user-facing guide to every tool window,
  keyboard reference, common workflows, alpha caveats.
- `docs/ELECTRON_DEV.md` — pnpm gotchas, native rebuild flow.
- `docs/INDEXER.md` — legacy v3.11 README preserved verbatim.

## Known gaps / next up

- `worker-license/` Cloudflare Worker (auth + Stripe + D1) — Week 3 of
  the plan. UI auth flows + tier gating depend on it.
- Multi-language LSP (Python / Go / Rust) — Monaco syntax highlight
  works; IntelliSense doesn't.
- `node-pty` Windows prebuilds — swap to
  `@homebridge/node-pty-prebuilt-multiarch` so the terminal works
  without Visual Studio Build Tools.
- Drag-reorder tabs · multi-window · split view in the editor pane.
- Toast/notification system (today's errors fall back to window.alert).
