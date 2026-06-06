# MCP IDE

An AI-native IDE for builders. Bring your own keys, work in a fast desktop app, let agents reason over your codebase.

> Status: **alpha**. Active development on the `feature/ide-mvp` branch (this branch). The Electron shell, file tree, Monaco editor, terminal, agent chat, snapshots, and git tool windows are wired end-to-end. Billing/auth, packaging, and the marketing surface are the next milestones.

## What's in the box

- **Workspace** — JetBrains-style IDE shell with two activity rails (Files · Search · Snapshots · Git on the left, Agent chat · Sessions · Inbox on the right), a Monaco editor with multi-tab editing + LSP completion / hover / Ctrl+Click / diagnostics, a bottom panel hosting an integrated terminal (PTY rooted at the project), and a status bar.
- **Agent chat** — multi-provider (Claude · OpenAI · Gemini · ZAI · DeepSeek · Bedrock · Kimi-Code · Cloudflare) with extended thinking, compaction, smart reducers, tool calling, sub-agent spawning. BYOK — your tokens, your costs.
- **Project understanding** — built on the MCP Code Indexer: hybrid FTS5 + vector search over the codebase, dependency graph, symbol hierarchy, snapshots (curated project notes), and a docs RAG corpus (Pro feature).
- **Local first** — the backend runs in-process inside Electron. No HTTP loopback is exposed in production (a Hono port can be enabled with `MCP_DEV_HTTP=1` for debugging). API surface lives in `@mcp/api-bus`; handlers in `@mcp/api-handlers`; transport adapters mount them on `ipcMain.handle` (Electron) or Hono routes (dev / external clients).
- **Multi-platform** — Windows, macOS, Linux via `electron-builder` (release pipeline in progress).
- **Plugins** — extend the agent + workspace with installable plugins: agent tools (run isolated in a worker thread), MCP servers, skills, sandboxed webview tool windows, command-palette commands, and themes. Authored with a typed SDK + CLI, Claude Code-compatible, and distributed through a hosted Market (Cloudflare Worker + D1 + R2, Ed25519-signed bundles). See [docs/PLUGINS.md](docs/PLUGINS.md).

## Quick start

```bash
# 1. Install
pnpm install
pnpm electron:rebuild    # rebuild better-sqlite3 against Electron's Node ABI

# 2. Run the dashboard in Electron (dev mode)
pnpm electron:dev
```

The Electron window opens at the project list. Pick a project to enter the Workspace — the legacy analytics view is still reachable at `/projects/:id/analytics`.

**Don't have a project yet?** Click `+ New project` on the home screen, point at any folder on your disk, and hit `Index`. The agent + Monaco LSP both work against that path.

### Other entry points

| Command | What it runs |
| --- | --- |
| `pnpm dev` | Vite dashboard (`:7317`) + Hono backend (`:7333`) in the browser, no Electron |
| `pnpm dev:server` | Backend only (`:7333`) — handy when developing the API surface |
| `pnpm dev:dashboard` | Dashboard only — pairs with `electron:dev` or `dev:server` |
| `pnpm start:api` | Production backend (`node dist/apps/http-api/server.js`) |
| `pnpm start` | CLI (`node dist/apps/cli/index.js`) |
| `pnpm start:server` | MCP Server (stdio protocol for Claude Desktop / Cursor / etc.) |

See [docs/ELECTRON_DEV.md](docs/ELECTRON_DEV.md) for the full Electron dev setup, including how to swap native modules between Node and Electron ABIs.

## Keyboard shortcuts (Workspace)

| Action | Shortcut |
| --- | --- |
| Quick Open file | `Ctrl/Cmd+P` |
| Command Palette | `Ctrl/Cmd+Shift+P` |
| Save active file | `Ctrl/Cmd+S` |
| Save all | `Ctrl/Cmd+Shift+S` |
| Close active tab | `Ctrl/Cmd+W` |
| Toggle left tool rail | `Ctrl/Cmd+B` |
| Toggle right tool rail | `Ctrl/Cmd+Alt+B` |
| Toggle terminal | `Ctrl/Cmd+J` |
| Toggle bottom panel | `Ctrl/Cmd+`` ` |
| Rename file in tree | `F2` |
| Reload window | `Ctrl/Cmd+R` |

`Ctrl/Cmd+Shift+P` opens the Command Palette where every action is searchable + shows its shortcut.

## Architecture (one-paragraph version)

The whole stack is a TypeScript monorepo. `apps/dashboard` is the React SPA (Vite + Tailwind + Radix). `apps/electron` boots the React renderer + imports the backend in-process (no child_process, no localhost HTTP). `apps/http-api` exposes the same operations as Hono routes for browser dev. The RPC contract lives in `packages/api-bus`; handler implementations in `packages/api-handlers`; storage in `packages/store` (SQLite with 100+ migrations). The agent runtime is `packages/code-agent` (multi-provider, tool use, LSP, sub-agents). Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the deep dive.

## Repo layout

```
apps/
  dashboard/           React SPA (Vite + Tailwind + Radix)
  electron/            Electron main + preload + IPC bridge
  http-api/            Hono backend (dev + diagnostics path)
  cli/                 mcp-code-indexer CLI
  mcp-server/          MCP protocol server (stdio)
  landing/             marketing surface (in progress)
packages/
  api-bus/             Transport-agnostic RPC contract (types only)
  api-handlers/        Pure handler implementations
  worker-pool/         Dynamic per-kind worker_threads pool
  store/               SQLite schema + DAOs + migrations
  services/            Providers, sandbox, chrome, qa, auth
  code-agent/          CoderRunner + tools + LSP + agent presets
  company/             Multi-agent orchestrator (master + subordinates)
  docs-agent/          Documentation RAG + DocsResearchBridge
  design-system/       Design System MCP tools
  indexer/             Indexing pipeline + hybrid search
  shared/              Types + utilities shared across packages
  candidate-pipeline/  ML classifiers (quality, tool-selection)
  orchestrator-host/   Host orchestration
worker/                Cloudflare Worker — vector embeddings (existing)
worker-license/        Cloudflare Worker — auth + billing (planned, Week 3)
docs/                  Internal + user docs
```

## Documentation

- [Architecture overview](docs/ARCHITECTURE.md) — package boundaries, IPC bridge, Electron lifecycle.
- [Workspace user guide](docs/IDE_WORKSPACE.md) — every tool window, every shortcut, the mental model.
- [Electron dev setup](docs/ELECTRON_DEV.md) — pnpm gotchas, native rebuild flow, debugging tips.
- [Indexer (legacy README)](docs/INDEXER.md) — the original v3.11 release notes for the code indexer + coder agent.
- [Project plan](https://github.com/) — see `C:/Users/maico/.claude/plans/projeto-ambiciso-criar-uma-cheerful-rabin.md` for the 5-week IDE Freemium roadmap.

## License

MIT — see [LICENSE](LICENSE).
