# CodeStudio Local

This edition opens directly into the desktop IDE. Projects, chats, settings, API collections and saved SSH hosts live on the machine. Agents use the model endpoint or provider credentials you configure. Local multi-agent collaboration, Git, terminals and the editor run independently of the CodeStudio account service.

The Windows installer is **CodeStudio Local Setup**. This edition uses its own application identity, Electron profile and default data directory (`~/.codestudio-local`). For a local model, add an OpenAI-compatible provider in Settings, enter the server URL and add its model ID. Cloud providers use the credentials you supply. The CLI shim beside the executable is `codestudio-local.cmd`. Set `MCP_DATA_DIR` to choose a different local data directory.

## Related repositories

| Repository | What it holds | Location |
| --- | --- | --- |
| **codestudio-desktop** (this one) | Electron shell, React dashboard, TypeScript agent runtime, indexer, bundled providers/plugins | `D:\MCP` |
| **codestudio-cloud** | Cloudflare Workers (cloud-api + worker-market), cloud bounded contexts (`@cloudstudio/cloud-*`), account-portal SPA | `D:\repos\codestudio-cloud` |
| **codestudio-unity** | Unity Editor plugin (`com.maicon.scene-analyzer`) — Scene Analyzer / Asset Modeler | `D:\repos\codestudio-unity` |
| **codestudio-web** | Public React/Vite institutional and product website | `D:\repos\codestudio-web` |

The standalone edition lives on `codex/codestudio-local`. To build the Windows installer from this checkout, use `node scripts/build-electron.mjs --target=nsis` after installing the workspace dependencies and the vendored Draw.io distribution.

## What's in the box

- **Workspace** — JetBrains-style IDE shell with two activity rails (Files · Search · Snapshots · Git on the left, Agent chat · Sessions · Inbox on the right), a Monaco editor with multi-tab editing + LSP completion / hover / Ctrl+Click / diagnostics, a bottom panel hosting an integrated terminal (PTY rooted at the project), and a status bar.
- **Agent chat** — GitHub Copilot, AWS Bedrock, OpenAI-compatible endpoints and Anthropic-compatible endpoints with extended thinking, compaction, smart reducers, tool calling, sub-agent spawning. BYOK — your tokens, your costs.
- **Project understanding** — hybrid FTS5 and vector search, dependency graphs, symbol hierarchies, project snapshots and a local documentation corpus.
- **Local first** — the backend runs in-process inside Electron. No HTTP loopback is exposed in production (a Hono port can be enabled with `MCP_DEV_HTTP=1` for debugging). API surface lives in `@mcp/api-bus`; handlers in `@mcp/api-handlers`; transport adapters mount them on `ipcMain.handle` (Electron) or Hono routes (dev / external clients).
- **Multi-platform** — Windows, macOS, Linux via `electron-builder` (release pipeline in progress).
- **Plugins** — extend the agent + workspace with installable plugins: agent tools (run isolated in a worker thread), MCP servers, skills, sandboxed webview tool windows, command-palette commands, and themes. Install a plugin from disk or configure your own registry. See [docs/PLUGINS.md](docs/PLUGINS.md).

Browser tools and documentation rendering use the Chromium bundled with Electron. Container Playwright suites can use a configured PLAYWRIGHT_WS_ENDPOINT.

Open the **Figma** panel to connect a personal access token with `current_user:read` and `file_content:read`. The bundled Figma MCP tools can inspect a file or frame link, render PNG previews, and return asset export URLs. Reading Enterprise variables also requires `file_variables:read`.

Project chats reuse Figma layers, design tokens and PNG previews from the CodeStudio profile across chats, worktrees and restarts. Export links are reused while valid. The cache lives in the profile’s `cache/figma-v1` directory, outside the Git checkout. Tools default to `prefer_cache`. Use `cache_only` for local reads or `refresh` to fetch the selected resource again. Disconnecting Figma or replacing its token clears the previous connection’s cache.

## Quick start

```bash
# 1. Set up dependencies with a prebuilt Electron-compatible SQLite module
pnpm electron:setup

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
  indexer/             Indexing pipeline + hybrid search
  shared/              Types + utilities shared across packages
  candidate-pipeline/  ML classifiers (quality, tool-selection)
  orchestrator-host/   Host orchestration
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
