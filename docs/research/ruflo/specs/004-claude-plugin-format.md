# Spec 004 — Publish D:\MCP as a Claude Code plugin

**Effort:** S (1 day) · **ROI:** High · **Status:** Proposed
**Inspiration:** [ruflo .claude-plugin/marketplace.json](https://github.com/ruvnet/ruflo/blob/main/.claude-plugin/marketplace.json)

---

## Problem

D:\MCP is currently distributed as:
- A self-hosted dashboard + HTTP API + MCP server (`apps/`)
- A VSCode extension and a JetBrains plugin (`extensions/`)

It is **not** installable as a Claude Code plugin. Users on Claude Code who'd benefit from D:\MCP's indexer + LSP + 60+ MCP tools have no easy way to add it. Meanwhile ruflo, with a less-developed substrate, reaches every Claude Code user via `/plugin install ruflo-X@ruflo`.

The Claude Code plugin format is well-defined and additive — D:\MCP can keep all its current product surfaces and **also** become a one-line install for Claude Code users:

```
/plugin marketplace add anthropics-or-org/mcp-code-indexer
/plugin install mcp-code-indexer-core@mcp-code-indexer
```

---

## Solution

Add a `.claude-plugin/` directory at the repo root with a `marketplace.json` listing 3-5 plugin bundles, each pointing at a sub-folder under `plugins/` that packages a subset of D:\MCP's MCP tools, agents, commands, and skills.

**Initial bundle structure (5 plugins):**

| Plugin | What it ships | MCP tools exposed |
|---|---|---|
| `mcp-indexer-core` | Core: index a project, FTS5 + LSH search, symbol hierarchy, dependency graph | ~15 tools (search, definition, references, symbols) |
| `mcp-indexer-coder` | Coder agent: tier system, presets, skills, snapshots | ~30 tools (read, write, edit, shell, git, lsp-*) |
| `mcp-indexer-workers` | Background workers (depends on spec 001 being merged) | ~5 tools (`worker_*`) |
| `mcp-indexer-safety` | 3-gate safety pipeline (depends on spec 003) | ~3 tools (`safety_inspect`, `safety_audit`, `safety_stats`) |
| `mcp-indexer-docs` | Docs-agent: docs search, drift detection, generation | ~5 tools |

Plugins pin to a specific D:\MCP CLI version (major+minor). Each plugin's `scripts/smoke.sh` is its conformance contract.

---

## Files to create

**Root manifest:**
- `.claude-plugin/marketplace.json` — lists 5 plugins
- `.claude-plugin/plugin.json` — parent plugin metadata (umbrella name `mcp-code-indexer`, version, repo URL)

**Per-plugin (5 folders under `plugins/`):**
Each plugin has the standard Claude Code plugin shape:
```
plugins/mcp-indexer-core/
  .claude-plugin/plugin.json    # metadata + MCP server registration
  agents/                       # any agent persona files (optional)
  commands/                     # slash command markdown files
  skills/                       # SKILL.md files
  hooks/                        # hooks json (e.g. PostToolUse)
  docs/                         # plugin user docs
  scripts/smoke.sh              # conformance contract
  README.md
```

---

## Reference: ruflo's marketplace.json shape

```json
{
  "name": "ruflo",
  "description": "...",
  "owner": { "name": "ruvnet", "url": "https://github.com/ruvnet" },
  "plugins": [
    {
      "name": "ruflo-core",
      "source": "./plugins/ruflo-core",
      "description": "Core ..."
    },
    ...
  ]
}
```

Our equivalent:

```json
{
  "name": "mcp-code-indexer",
  "description": "MCP Code Indexer — codebase indexing, hybrid search, coder agent, background workers, and safety gates for Claude Code",
  "owner": { "name": "<TBD>", "url": "<TBD>" },
  "plugins": [
    {
      "name": "mcp-indexer-core",
      "source": "./plugins/mcp-indexer-core",
      "description": "Index a project + hybrid search (FTS5 + LSH) + symbol hierarchy + dependency graph"
    },
    {
      "name": "mcp-indexer-coder",
      "source": "./plugins/mcp-indexer-coder",
      "description": "Tiered coder agent (bootstrap / navigate / admin) with 60+ MCP tools, snapshots, and skills"
    },
    {
      "name": "mcp-indexer-workers",
      "source": "./plugins/mcp-indexer-workers",
      "description": "Background workers: index_refresh, audit, testgaps, document, consolidate, optimize, preload, deepdive"
    },
    {
      "name": "mcp-indexer-safety",
      "source": "./plugins/mcp-indexer-safety",
      "description": "3-gate safety pipeline — PII redaction, sanitization, prompt-injection detection"
    },
    {
      "name": "mcp-indexer-docs",
      "source": "./plugins/mcp-indexer-docs",
      "description": "Docs-agent — search, drift detection, generation"
    }
  ]
}
```

---

## Per-plugin manifest example

`plugins/mcp-indexer-core/.claude-plugin/plugin.json`:

```json
{
  "name": "mcp-indexer-core",
  "description": "MCP Code Indexer — core. Index a project, hybrid search (FTS5 + LSH), symbol hierarchy, dependency graph.",
  "version": "0.1.0",
  "author": { "name": "<TBD>" },
  "homepage": "https://github.com/<org>/mcp-code-indexer",
  "license": "MIT",
  "keywords": ["mcp", "indexing", "fts5", "lsh", "code-search", "claude-code"],
  "engines": { "claudeCode": ">=2.0.0", "node": ">=20.0.0" },
  "mcpServers": {
    "mcp-indexer": {
      "command": "npx",
      "args": ["mcp-code-indexer", "mcp", "start"],
      "description": "MCP Indexer server — 15 search/symbol/graph tools"
    }
  }
}
```

The `npx mcp-code-indexer mcp start` command is provided by the existing `apps/mcp-server/`. The plugin install just registers the MCP server with Claude Code — no source bundling needed.

---

## Existing skills migration

D:\MCP already has skills in [`.claude/skills/`](../../../.claude/skills/) (from the user's local config). For the plugin format, move the **product-defining** skills (not user-personal ones) into the appropriate plugin's `skills/` folder. Examples:

| Current skill | Target plugin |
|---|---|
| (any existing coder-agent skill) | `mcp-indexer-coder/skills/` |
| (any indexer skill) | `mcp-indexer-core/skills/` |
| (a new `worker-dispatch.md` per spec 001) | `mcp-indexer-workers/skills/` |

User-specific skills stay in `~/.claude/skills/`.

---

## Hooks integration

Each plugin can register Claude Code hooks (PostToolUse, PreTask, etc.) for in-process behavior. Example:

`plugins/mcp-indexer-core/hooks/hooks.json`:
```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "npx mcp-code-indexer index --incremental --file \"$CLAUDE_FILE\"" }
      ]}
    ]
  }
}
```

This re-indexes any file the user edits — keeping the index live without a manual re-index trigger.

---

## Tasks

| # | Task | Est |
|---|---|---|
| T1 | `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` at root | 1h |
| T2 | `plugins/mcp-indexer-core/` — manifest + register MCP server + 1 sample command + smoke.sh | 2h |
| T3 | `plugins/mcp-indexer-coder/` — manifest + coder-agent MCP server + skills migration | 3h |
| T4 | `plugins/mcp-indexer-workers/` — manifest + worker MCP server (conditional on spec 001) | 1h |
| T5 | `plugins/mcp-indexer-safety/` — manifest + safety MCP server (conditional on spec 003) | 1h |
| T6 | `plugins/mcp-indexer-docs/` — manifest + docs-agent MCP server | 1h |
| T7 | PostToolUse hook for `mcp-indexer-core` (incremental index on Edit/Write) | 2h |
| T8 | Per-plugin `scripts/smoke.sh` — minimal "MCP server starts, lists tools" check | 2h |
| T9 | README: how to install + uninstall + verify | 1h |
| T10 | CI: smoke tests for all 5 plugins | 2h |
| T11 | Publish marketplace to GitHub (just push to default branch — `/plugin marketplace add <repo>` resolves it) | 1h |

**Total:** ~1.5 days

---

## Plugin pinning + smoke as contract (carry over from ruflo)

Each plugin's `plugin.json` includes:

```json
{
  "engines": { "claudeCode": ">=2.0.0", "mcpIndexerCli": "0.1.x" }
}
```

And each plugin's `scripts/smoke.sh` performs:
1. Start the plugin's MCP server with `--test` flag
2. List MCP tools via stdio
3. Call 1 sanity tool
4. Assert exit 0

CI runs all 5 smoke scripts on every PR to the indexer CLI repo. A failing smoke = the plugin is incompatible with the new CLI version; either bump the plugin's pinned version or fix the CLI.

---

## Test plan

1. **Local install**:
   ```
   /plugin marketplace add file:///D:/MCP
   /plugin install mcp-indexer-core@mcp-code-indexer
   ```
   Then in a Claude Code session: `/mcp` should list `mcp-indexer` server with its tools.
2. **Tool invocation**: from Claude Code, call `mcp-indexer__search` with a query and confirm results.
3. **Hook fire**: edit a file in a project with the plugin installed → confirm incremental index re-runs.
4. **Smoke**: `bash plugins/mcp-indexer-core/scripts/smoke.sh` exits 0.
5. **Uninstall**: `/plugin uninstall mcp-indexer-core@mcp-code-indexer` removes registration; tools no longer available.
6. **Multi-plugin**: install all 5; no name collisions, no startup errors.

---

## Out of scope (defer)

- **Publishing to a public npm registry** with a stable name — name selection + ownership transfer is a separate concern.
- **Auto-bundling the dashboard** as a plugin — the dashboard runs as its own app, not as a Claude Code plugin; users who want the dashboard run D:\MCP CLI alongside.
- **Plugin auto-update** — Claude Code's `/plugin update` covers this once published; nothing extra to build.

---

## Open questions

1. **Marketplace name + owner**: should it be under the user's GitHub org? Will the user maintain it? Decide before T11.
2. **Versioning**: does each plugin version independently or in lockstep with the CLI? Recommendation: lockstep for the first year, decouple once external contributors emerge.
3. **License**: D:\MCP overall license? MIT recommended to match the broader ecosystem (ruflo is MIT).
4. **Coexistence with VSCode/JetBrains extensions**: the Claude Code plugin path is additive — these stay as-is.
