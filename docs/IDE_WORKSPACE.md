# Workspace user guide

The IDE workspace is the screen you land on when you open a project.
It mimics JetBrains conventions: two activity rails (left + right)
that toggle tool windows, an editor in the middle, an optional
bottom panel, and a status bar.

## Layout

```
┌─Top bar──────────────────────────────────────────────────────────┐
│  Home › Project › Workspace        Analytics  Bottom panel       │
├─┬───────────┬───────────────────────┬─────────────────────┬─────┤
│L│  Left     │  Editor tab bar       │  Right tool panel   │  R  │
│e│  tool     │  ── tab tab tab ──    │  ── chat / sessions │  i  │
│f│  panel    ├───────────────────────┤     / inbox         │  g  │
│t│  (files,  │                       │                     │  h  │
│ │   search, │  Monaco editor        │                     │  t  │
│R│   snaps,  │                       │                     │  R  │
│a│   git)    │                       │                     │  a  │
│i│           ├───────────────────────┤                     │  i  │
│l│           │  Bottom panel (term…) │                     │  l  │
├─┴───────────┴───────────────────────┴─────────────────────┴─────┤
│  Status bar — project · file · unsaved count · file/symbol cnt  │
└──────────────────────────────────────────────────────────────────┘
```

The activity rails (the two slim icon columns on either side) toggle
their respective panel. Click an icon to open; click the active icon
to close. Layout sizes and which panels are open persist to
localStorage so the workspace looks the same after a reload.

## Top bar

- **Home** (`Home` icon, far left) — back to the project list.
- **Breadcrumb** — `Home › <Project> › Workspace`. The project chip
  takes you to the project analytics view (the legacy 9-tab dashboard
  with search / files / dependencies / architecture / snapshots / diff
  / costs / runs).
- **Analytics shortcut** — chart icon on the right, jumps straight to
  the analytics view without losing the workspace state.
- **Bottom panel toggle** — last icon on the right.

## Left rail tool windows

| Icon | Tool window | What it does |
| --- | --- | --- |
| `FileCode2` | **Project files** | Recursive file tree. Click to open in the editor. Right-click any node for **New file / New folder / Rename / Copy path / Delete**. F2 renames the active file inline (select the basename, type the new name, Enter / Esc). |
| `Search` | **Search** | Hybrid (FTS5 + vector) search across the project. Debounced; results show file path + matching snippet. Click to open. |
| `History` | **Snapshots** | Curated project notes — decisions, requirements, context. Grouped by category. Click any to edit; plus button up top to create. Notes embed in the project context the agent uses. |
| `GitBranch` | **Git** | Working-tree status. Sections for **Staged**, **Changes**, **Untracked**. Hover a row for per-file stage / unstage / discard. Bulk actions on each section header. Commit dialog from the toolbar (or `Ctrl/Cmd+Shift+P → Commit`). |

## Right rail tool windows

| Icon | Tool window | What it does |
| --- | --- | --- |
| `MessageSquare` | **Agent chat** | The full AgentChat — composer, message stream, plan/question prompts, snapshots panel. Resume any session by picking it from the inner sidebar. |
| `History` | **Sessions** | Compact list of coder sessions for this project. Click a row to load it in the Chat tool window (the rail auto-switches). |
| `Bell` | **Inbox** | (Coming soon) Background agent notifications + interrupt-resume prompts. |

## Bottom panel

Tabs (toggle visibility from the top bar or `Ctrl/Cmd+J`):

- **Terminal** — interactive PTY rooted at the project's `root_path`.
  PowerShell on Windows; the user's shell elsewhere. Resizes with the
  panel. Restart button surfaces if the shell exits.
- **Problems** *(coming soon)* — LSP diagnostics across the workspace.
- **Output** *(coming soon)* — tool output + build logs.
- **Find** *(coming soon)* — search across files results.

## Editor

Monaco with:

- Multi-tab editing, dirty dot on unsaved tabs, middle-click to close.
- IntelliSense for TS / TSX / JS / JSX (completion, hover, Ctrl/Cmd+Click
  to go to definition, Find All References, red squigglies). Other
  languages get Monaco's built-in syntax highlight.
- Bracket pair colorization, font ligatures (JetBrains Mono), sticky
  scroll on the TS outline, inlay hints, folding, minimap.
- `Ctrl/Cmd+S` saves the active file. `Ctrl/Cmd+Shift+S` saves all
  dirty files at once.
- `Ctrl/Cmd+W` closes the active tab.

## Quick Open + Command Palette

- **Quick Open** (`Ctrl/Cmd+P`) — fuzzy-find every indexed file. ↑/↓
  navigate, Enter opens.
- **Command Palette** (`Ctrl/Cmd+Shift+P`) — every action in one
  searchable list. Shortcuts appear on the right of each row so you
  learn the bindings while using the palette.

## Status bar

- Green dot + project name (left)
- Active file path + unsaved count
- Indexed file count + symbol count (right)
- LSP idle indicator

## Keyboard reference

| | |
| --- | --- |
| Quick Open | `Ctrl/Cmd+P` |
| Command Palette | `Ctrl/Cmd+Shift+P` |
| Save / Save all | `Ctrl/Cmd+S` / `Ctrl/Cmd+Shift+S` |
| Close active tab | `Ctrl/Cmd+W` |
| Toggle left rail / right rail | `Ctrl/Cmd+B` / `Ctrl/Cmd+Alt+B` |
| Toggle terminal / bottom panel | `Ctrl/Cmd+J` / `` Ctrl/Cmd+` `` |
| Rename file in tree | `F2` |
| Reload window | `Ctrl/Cmd+R` |

## Workflow tips

- **Right-click the file tree** to create or delete files without
  leaving the workspace. The tree refreshes itself after every
  mutation.
- **Open a file from search**: type the keyword in the Search tool
  window, click the result. The file opens in a new tab; the search
  panel stays put so you can keep clicking results.
- **Commit a small change**: switch to the Git tool window
  (`Ctrl/Cmd+B`, click GitBranch icon), stage your files, hit the
  commit-dot icon, type the message, Enter. The git tree refreshes
  automatically.
- **Plan something with the agent without losing the editor**: open
  the Chat tool window (`Ctrl/Cmd+Alt+B`), type your prompt. The
  editor keeps your file in view; the agent sees the same files you
  do via its built-in tools.
- **Annotate context for the agent**: open Snapshots, create a note
  with category `decision` or `context`. The agent picks it up via
  the project context bundle on the next turn.

## Known limitations (alpha)

- **Diff viewer inside the editor** — not yet wired. Use the terminal
  + `git diff` for now.
- **Untyped languages (Python / Go / Rust)** — Monaco renders their
  syntax fine but no IntelliSense. LSP support beyond TS/JS is on the
  v1.1 roadmap.
- **Project-local terminal on Windows without VS Build Tools** —
  `node-pty` ships no prebuilt for Electron's Node ABI on Windows, so
  the terminal tab shows an error banner until either VS Build Tools
  is installed or we swap to `@homebridge/node-pty-prebuilt-multiarch`.
- **No drag-reorder of tabs yet** — middle-click closes; click selects.
- **Multi-window** — single window per Electron process; opening a
  second project replaces the workspace state in the same window.
