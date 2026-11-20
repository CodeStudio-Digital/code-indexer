---
name: init
description: Analyze the current project and generate (or refresh) an AGENTS.md at the repo root — onboarding doc for future agent sessions and humans.
slash-command: init
allowed-tools:
  - read_file
  - list_directory
  - glob
  - grep_code
  - mcp__get_project_pulse
  - mcp__get_file_skeleton
  - mcp__read_file
  - mcp__list_directory
  - mcp__grep_code
  - write_file
  - apply_patch
context-mode: auto
tags:
  - builtin
  - onboarding
  - documentation
sort-order: 10
version: 1.0.0
---

# `/init` — Generate AGENTS.md

You are a senior software engineer asked to explore the **current project directory** and produce (or refresh) a single `AGENTS.md` file at the repository root. The file is written for AI coding agents who land in this repo with **zero prior context**.

## Operating mode

- Read-only investigation first. Do not edit code or run mutating commands.
- The only file you should write is `AGENTS.md` at the project root, via `write_file` (or `apply_patch` if updating an existing one).
- Prefer the cheap MCP tools when available: `mcp__get_project_pulse`, `mcp__get_file_skeleton`. List and read with `list_directory`, `glob` and `read_file`.
- Do not invent facts. If you cannot confirm something from the code/config, omit it.

## Language detection (important)

Pick the language for `AGENTS.md` automatically — do NOT ask the user:

1. Sample the project's existing prose: `README.md`, top-level `docs/`, comments in `package.json`/`pyproject.toml`/`Cargo.toml` description fields, the first comment block of 2–3 source files chosen at random.
2. If the dominant prose is Portuguese (pt-BR / pt-PT cues like "ç", "ã", "é", common words `não`, `não é`, `como`, `função`, `pacote`), write `AGENTS.md` in **Portuguese (pt-BR)**.
3. Otherwise default to **English**.
4. Always include code identifiers (function names, file paths) verbatim — never translate them.

If the project is empty or has no prose, default to English.

## Investigation checklist

Run these in order. Stop as soon as you have enough to fill each section — do not exhaustively read every file.

1. **Identity** — what is this project? Read root `README*`, `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod` for name, description, version.
2. **Stack** — primary language, framework, package manager, runtime requirements.
3. **Top-level layout** — list root directories with a one-line purpose each (use `mcp__get_project_pulse` if available; otherwise `list_directory` at depth 1–2).
4. **Build & run** — extract the commands actually defined in `package.json` scripts, `Makefile`, `justfile`, etc. Do NOT guess; quote them.
5. **Tests** — how to run the test suite. Note the framework (vitest, pytest, jest, etc.) if obvious.
6. **Conventions** — formatter (prettier/ruff/gofmt), linter, type checker, anything in CONTRIBUTING/AGENTS/CLAUDE files already.
7. **Entry points** — main executable / server / CLI entry. Cite `file:line`.
8. **Security/secrets** — any `.env.example`, secrets management notes, deployment caveats.

## Output structure

Write `AGENTS.md` with these sections (omit a section if there is nothing concrete to say):

```
# AGENTS.md

## Project overview
<2–4 sentences: what it does, why it exists, who it's for>

## Stack
- Language: <…>
- Framework: <…>
- Package manager: <…>
- Other notable deps: <…>

## Layout
- `path/` — <one-line purpose>
…

## Build, run, test
- Install: `<cmd>`
- Run dev: `<cmd>`
- Build: `<cmd>`
- Test: `<cmd>`
- Lint / format / typecheck: `<cmds>`

## Entry points
- `<path:line>` — <what it does>

## Conventions
<formatter, linter, file naming, any project-specific rules you found>

## Security / secrets
<env files, do-not-commit notes — only if observed>

## Notes for agents
<anything an AI agent specifically should know: tools available, MCP servers in use, dangerous commands to avoid, where to find more context>
```

## Final action

- Call `write_file` (or `apply_patch` for an existing file) to write the body to `AGENTS.md` at the project root.
- After writing, print a 2-line summary in chat: file size + the top-level sections you included. Do not paste the full body back to the user.

If `AGENTS.md` already exists, **read it first** and treat it as the source of truth — merge your new findings without dropping anything the previous version captured. The goal is incremental refinement, not a fresh-start overwrite.
