# Electron dev setup

Quick reference for getting `pnpm electron:dev` working on a fresh checkout.
This is dev-only — production builds (`pnpm electron:build`) follow a
different path documented in `RELEASE_PROCESS.md`.

## TL;DR

```bash
pnpm electron:setup     # install dependencies and prepare SQLite for Electron
pnpm electron:dev       # launches Vite dev + Electron together
```

Run setup on a fresh checkout or after changing dependencies. It tests SQLite in
Electron and downloads the published binary for the installed release if needed.
On Windows x64 the prebuilt binary runs on machines without Visual Studio Build
Tools. The downloads use the dependency and registry configuration on the machine.

If you flip between Node-only dev (`pnpm dev`) and Electron-only dev
(`pnpm electron:dev`), you need to swap the native ABI:

```bash
pnpm electron:setup     # before running pnpm electron:dev
pnpm node:rebuild       # before running pnpm dev (Node ABI)
```

## What `pnpm electron:dev` does

1. Starts Vite dev server on `:7317` (serves the React dashboard).
2. Spawns Electron via `apps/electron/dev.ts`, which:
   - Sets `MCP_ELECTRON_DEV_URL=http://localhost:7317` so the renderer
     loads the live Vite output.
   - Sets `MCP_DEV_HTTP=1` so the Hono server also listens on
     `127.0.0.1:7333` in parallel with the IPC bridge. The dashboard's
     legacy `useApi('/...')` callsites fetch via the Vite proxy →
     `:7333`; new code uses `apiCall('namespace.method', input)` which
     prefers IPC. Both work side by side during the migration.
   - Forwards `--import tsx/esm` so the Electron main process can
     `require` the TS files in `apps/electron/` and `apps/http-api/`
     directly.

To force IPC-only (surface any callsite that still relies on HTTP) set:

```bash
MCP_DEV_HTTP=0 pnpm electron:dev
```

## Common gotchas

### "Electron failed to install correctly"

pnpm ignores native build scripts by default. The package.json declares
`pnpm.onlyBuiltDependencies` to opt `electron`, `esbuild`, `better-sqlite3`,
and `node-pty` back in. If you still hit this after `pnpm install`:

```bash
node node_modules/.pnpm/electron@*/node_modules/electron/install.js
```

### `NODE_MODULE_VERSION` mismatch on better-sqlite3

The native module installed for the system Node version may target a different
ABI from Electron. Run:

```bash
pnpm electron:setup
```

Run `pnpm node:rebuild` before switching back to the browser development
server with `pnpm dev`.

### "Cannot find module 'ws'" / "node-fetch"

If you see import resolution errors on a fresh checkout, run the
proactive scan:

```bash
node scripts/check-undeclared-deps.mjs
```

It flags any specifier in `apps/**` or `packages/**` that isn't in
`package.json` (or a workspace package, or a Node builtin). Most hits
are template-literal false positives (code embedded in strings); real
ones get added to `package.json`.

### node-pty doesn't rebuild on Windows

`node-pty` ships no Electron prebuilt and needs Visual Studio Build
Tools to compile via node-gyp. The Workspace's bottom-panel terminal
(via `terminal.spawn` → node-pty) degrades gracefully when the module
fails to load — the panel shows an error banner instead of crashing.

To enable the terminal under Electron:

1. Install Visual Studio Build Tools with "Desktop development with C++"
   workload, OR
2. Swap node-pty for `@homebridge/node-pty-prebuilt-multiarch` (drop-in
   API, ships prebuilds for Node + Electron on all three platforms).

The second route is the recommended fix when the IDE moves out of "it
works on my machine" — tracked as a follow-up.

## What's running where

```
┌────────────────────────────────────────────┐
│ pnpm electron:dev                           │
│   ├─ vite (7317)        ── dashboard SPA    │
│   └─ tsx apps/electron/dev.ts               │
│        └─ spawns Electron                   │
│             ├─ main process (Node)          │
│             │   ├─ createApp() backend      │
│             │   ├─ Hono on 127.0.0.1:7333   │ ← MCP_DEV_HTTP=1
│             │   ├─ ipcMain handlers         │ ← IPC bridge
│             │   └─ BrowserWindow            │
│             │        └─ loadURL :7317       │
│             └─ renderer (Chromium)          │
│                  └─ window.electronAPI.api  │
└────────────────────────────────────────────┘
```

Stop with Ctrl+C in the shell — `concurrently` propagates SIGINT to
both processes.
