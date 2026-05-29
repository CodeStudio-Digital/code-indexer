# Architecture

A bird's-eye view of how the IDE fits together. Read [the original
indexer README](INDEXER.md) for the deep dive on the coder agent,
indexing pipeline, and tool tier system — the architecture here is the
delivery layer on top of all that.

## Layered view

```
┌────────────────────────────────────────────────────────────────┐
│  apps/electron/main.ts                                          │
│  ─ owns BrowserWindow, native menus, auto-updater (planned)     │
│  ─ imports the backend in-process; no child_process, no port    │
│  ─ wires every handler in @mcp/api-handlers onto ipcMain.handle │
└─────────────┬──────────────────────────────────┬────────────────┘
              │ contextBridge                    │ in-process calls
              ▼                                  ▼
┌─────────────────────────┐    ┌───────────────────────────────────┐
│  apps/dashboard (React) │    │  @mcp/api-handlers                │
│  ─ React 19 + Vite      │    │  ─ Pure handler factories         │
│  ─ Tailwind + Radix     │    │  ─ Throw ApiError on typed faults │
│  ─ Zustand state slices │    │  ─ AsyncIterable<T> for streams   │
│  ─ apiCall / apiStream  │    │  ─ Mounted by ipcMain AND Hono    │
└─────────────┬───────────┘    └────┬──────────────────────────────┘
              │                     │
              │                     ▼
              │   ┌────────────────────────────────────────────────┐
              │   │  @mcp/api-bus                                  │
              │   │  ─ Transport-agnostic RPC contract             │
              │   │  ─ Interface per namespace (coder, files, …)   │
              │   │  ─ AsyncStream<T> primitive for streaming      │
              │   │  ─ ApiContext (user, requestId, signal)        │
              │   │  ─ ApiError (code + status + details)          │
              │   └────────────────────────────────────────────────┘
              │
              │   ┌────────────────────────────────────────────────┐
              │   │  apps/http-api (Hono)                          │
              │   │  ─ Thin adapter: parses request → calls handler│
              │   │  ─ Only listens when MCP_DEV_HTTP=1            │
              │   │    or running standalone (`pnpm start:api`)     │
              │   │  ─ SSE wraps the same AsyncIterable handlers   │
              │   └────────────────────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────────────────────┐
│  @mcp/store · @mcp/services · @mcp/code-agent · @mcp/company …  │
│  Persistence + providers + agent runtime + orchestrator         │
└──────────────────────────────────────────────────────────────────┘
```

The big decision: **the API surface is one set of pure handlers**.
Hono routes are an adapter; Electron's IPC is an adapter; tests call
handlers directly. Adding a new operation means adding a method to the
`api-bus` interface, implementing it in `api-handlers`, and (optionally)
mapping it to an HTTP route. The renderer reaches it via
`window.electronAPI.api.<namespace>.<method>(input)` with full type
coverage thanks to the bus.

## Namespaces

The `Api` interface in [packages/api-bus/src/index.ts](../packages/api-bus/src/index.ts):

| Namespace | What it does | Tier gate |
| --- | --- | --- |
| `projects` | CRUD projects, stats, run/stream indexing | Free (limited to 1 project once gating lands) |
| `files` | Read/write/list/tree, mkdir/rename/delete | Free |
| `lsp` | TypeScript completion / hover / definition / refs / diagnostics | Free (TS/JS) |
| `terminal` | Spawn PTY (`project` target), write/resize/kill, stream output | Free |
| `coder` | Sessions CRUD, providers, groups, skills, message stream (Day 8) | Free |
| `snapshots` | Project notes CRUD | Free |
| `runs` | Indexer run history | Free |
| `search` | Hybrid (FTS5 + vector) search | Free |
| `projectGit` | Local working-tree status, stage, diff, commit | Free |
| `docs` | RAG collections + ingestion + search | Pro (planned) |
| `designSystem` | UI component catalog | Pro (planned) |
| `company` | Multi-agent orchestrator (master + subordinates) | Pro (planned) |
| `workspace` | Sandbox file/git operations | Pro (planned) |
| `admin` | Provider config, quality dashboards, MCP servers | Operator |
| `auth` / `billing` | Proxy to `worker-license` (Cloudflare Worker) | Always |
| `plugins` | Install/uninstall/list/enable plugins, read webview assets, search the Market | Free |

## Streaming

`AsyncStream<T>` is the streaming primitive. Handlers return
`AsyncIterable<T>`; transport layers adapt to whatever wire is
appropriate:

- **Electron**: the IPC bridge transfers a `MessagePort` to the
  renderer (`webContents.postMessage`) and pumps frames over
  `port.postMessage`. The renderer wraps the port as an
  `AsyncIterable<T>` so the React side never sees the transport.
- **Hono**: streams are framed as SSE (`text/event-stream`) using
  Hono's `streamSSE` helper, with the same handler doing the
  iteration.

This is why `projects.indexStream` and `terminal.output` and (eventually)
`coder.stream.sendMessage` all look the same from the React side:

```ts
for await (const frame of apiStream<MyEvent>('projects.indexStream', input)) {
  // …
}
```

## Worker pool (`@mcp/worker-pool`)

Per-kind dynamic pool (`coder` / `lsp` / `index` / `plugin`) with auto-scale,
idle eviction, and saturation queueing. See
[packages/worker-pool/src/pool.ts](../packages/worker-pool/src/pool.ts).
LSP currently runs in-process for simplicity; the pool is the lever
when a real user hits a project big enough to feel the main-thread cost.

## Plugins

Installable extensions that add agent + workspace capabilities. A plugin
(`plugin.json` + `.app.json` + optional `.mcp.json` / `skills/` + a built
`dist/plugin.js`) contributes agent tools, MCP servers, skills, sandboxed
webview tool windows, palette commands, and themes. Claude Code-compatible.

- **Authoring** — `@mcp/plugin-sdk` (`definePlugin` / `contributeX` + a
  `create` / `build` / `validate` / `publish` CLI).
- **Install** — `@mcp/plugin-host` materializes a bundle by namespace into
  `{dataDir}/plugins/{ns}/`, applies skills/MCP/contributions, records the
  `installed_plugins` row (migration 112). Sources: local · github · market.
- **Agent execution** — tools run isolated in a `worker_thread`
  (`apps/http-api/sse/PluginWorkerHost.ts` + `workers/plugin-worker.ts`); the
  http-api builds `pluginTools` and passes them to `runCoder`.
- **UI** — a Zustand contribution registry (hydrated from `plugins.list`)
  merges plugin rail items / tool windows / commands / themes with the
  built-ins; tool windows render in a null-origin sandboxed iframe bridged by a
  read-only api-bus whitelist.
- **Market** — `worker-market/`: a Cloudflare Worker (D1 catalog + R2 bundles +
  Ed25519 signing). The host re-hashes and verifies a bundle's signature before
  extracting.

Full guide: [docs/PLUGINS.md](PLUGINS.md).

## Storage

`@mcp/store` owns SQLite (WAL mode, `better-sqlite3`). 100+ migrations
under `packages/store/src/migrations/`. The schema covers projects,
files, symbols, code-agent sessions/messages/tool-calls, snapshots,
company sessions, sandboxes, docs corpus, embeddings, auth, audit, and
QA runs.

The Electron build embeds the SQLite native binary via `asarUnpack`
(see [apps/electron/electron-builder.json](../apps/electron/electron-builder.json)).
Native ABI is rebuilt by `pnpm electron:rebuild` — necessary because
Electron's bundled Node uses a different ABI than the system Node.

## Why not just keep HTTP?

The original dashboard used `fetch('/api/...')` against the Hono backend
on `:3333` (via Vite proxy in dev). Inside Electron that's an
unnecessary loopback hop — serialization, TCP, proxy buffering. Worse:
the Vite proxy was eating SSE flushes intermittently, which surfaced as
"chat stuck on iniciando" for the user.

The IPC path:
- Zero JSON-on-the-wire overhead for streams (MessagePort transfers
  structured-cloned values directly).
- Zero spawn cost — the backend lives in the same process as the
  window.
- Zero exposed network surface — production builds don't open
  127.0.0.1:3333.

Hono still exists because: (a) `pnpm dev` (browser only) needs it,
(b) the standalone API server (`pnpm start:api`) is the integration
surface for external MCP clients, (c) `MCP_DEV_HTTP=1` makes debugging
with curl trivial.

## Auth + billing (planned)

The `worker-license/` package (planned) will host a Cloudflare Worker
with D1 for user accounts + Stripe webhooks. The local backend will
proxy `auth.*` and `billing.*` calls to it and validate JWTs (Ed25519,
30-day TTL, cached in SQLite for offline). Pro tier features will be
gated server-side via a `requireTier('pro')` middleware before they
ever touch a handler.

The plan lives at
`C:/Users/maico/.claude/plans/projeto-ambiciso-criar-uma-cheerful-rabin.md`.

## Development reminders

- Don't run `pnpm dev` and `pnpm electron:dev` simultaneously — they
  fight for `:5173`.
- After running `pnpm dev` you need `pnpm node:rebuild` before
  `pnpm electron:dev` (and vice versa) — better-sqlite3's native ABI
  differs.
- `scripts/check-undeclared-deps.mjs` scans for module specifiers used
  but not declared in `package.json`. Run it if a fresh install ever
  fails on import resolution.
