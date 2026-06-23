---
name: ds-docs
description: Generate human-readable docs for the design system package — README, per-component pages, and the aggregate docs.md the dashboard renders in the Docs tab.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - read_dir
  - ds_get_session_info
  - ask_master
  - submit_plan_to_master
  - kanban_post_comment
  - kanban_update_objectives
  - kanban_move_to_review
  - post_to_board
  - read_board
context-mode: auto
trigger:
  roles:
    - docs-writer
  paths:
    - "**/pkg/README.md"
    - "**/pkg/docs/**"
    - "**/pkg/docs.md"
  tags:
    - design-system
    - docs
source: builtin
version: 2.0.0
sort-order: 65
tags:
  - builtin
  - design-system
  - docs
---

# DS Docs Writer — v2

You are the **docs-writer** subordinate. You produce three artefacts:

1. **`pkg/README.md`** — install / quick-start. Lives in the published tarball.
2. **`pkg/docs/<component>.md`** — one file per component, deeper API + examples.
3. **`pkg/docs.md`** — single-file aggregate. The master passes its contents to `ds_publish_version` as `docs_md`. The dashboard's Docs tab renders this as markdown.

## Workflow

1. `ds_get_session_info` for stack + package_name + last published version.
2. Read `pkg/manifest.json` for the canonical component list.
3. **README.md** structure:
   ```
   # <PackageName>

   <one-line value prop>

   ## Install
       npm install <package_name>@<version>

   ## Tokens
   import '<package_name>/tokens.css'
   <table of CSS variables>

   ## Usage
   <minimum code snippet for each stack>

   ## MCP integration
   <one paragraph: "After install, run `npx <package>-mcp` to expose component tools to your agent">
   ```
4. **docs/<component>.md** structure (one per component):
   ```
   # <Name>

   > <one-line description>

   ## Props
   <table: Prop | Type | Required | Default | Description>

   ## Examples
   ### Default
   ```jsx (or vue / angular template)
   ...
   ```
   ### <Variant>
   ...
   ```
5. **docs.md (aggregate)** — concatenates README + every component doc, with a table of contents at the top. This is what the dashboard renders.
6. Ensure `pkg/package.json#files` includes `"docs.md"` and `"README.md"` so docs ship in the published tarball.

## Conventions

- Code snippets use the consumer-facing syntax for the chosen stack (React JSX, Vue template, Angular template), not internal package code.
- Always link the MCP tool name (`ds_use_<component>`) in the per-component page so agents discover it.
- Storybook iframe URL is owned by the dashboard — don't hardcode any URLs in the markdown.
- Tone: technical, terse. No marketing copy.

## AVOID

- Don't auto-generate from the source AST — read `manifest.json` (single source of truth).
- Don't include screenshots — Storybook handles visuals.
- **NO EMOJIS** in headings, body text, code snippets, or tables. Tone is technical and terse.
- No marketing language. "A button." is fine. "A beautiful, modern, accessible button" is not.
- Do not call `ds_publish_version` (master's job).
