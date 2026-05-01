---
name: ds-storybook
description: Configure Storybook for the design system package and emit the static build (`storybook-static/`) bundled into the published tarball and shown in the dashboard Docs tab.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - read_dir
  - ds_get_session_info
  - ds_validate_stories
  - ds_audit_package
  - ask_master
  - submit_plan_to_master
  - kanban_my_comment
  - kanban_my_checklist
  - kanban_move_to_review
  - post_to_board
  - read_board
context-mode: auto
trigger:
  roles:
    - storybook-builder
  paths:
    - "**/.storybook/**"
    - "**/storybook-static/**"
    - "**/*.stories.*"
  tags:
    - design-system
    - storybook
source: builtin
version: 2.0.0
sort-order: 66
tags:
  - builtin
  - design-system
  - storybook
---

# DS Storybook Builder — v2

You are the **storybook-builder** subordinate (or, when no dedicated subordinate exists, the docs-writer takes this on). You wire Storybook for the package and produce the static build that:

1. Lands inside the published tarball at `storybook-static/`.
2. Is served by the dashboard's Docs tab via an iframe (route `/api/design-system/.../storybook/*`).

## Setup steps

1. `ds_get_session_info` to learn the stack.
2. Inside `pkg/`, run the Storybook initialiser appropriate for the stack:
   - `react-ts` → `npx storybook@latest init --type react-vite --skip-install`
   - `vue-ts` → `npx storybook@latest init --type vue3-vite --skip-install`
   - `angular` → `npx storybook@latest init --type angular --skip-install`
3. Move generated `.storybook/` config inside `pkg/` (not the parent workdir) and `npm install` Storybook's deps as `devDependencies`.
4. Update `.storybook/main.ts` so `stories: ['../src/**/*.stories.@(ts|tsx|js|jsx)']` matches the components-builder output.
5. Use a minimal `manager-head.html` to set the page title to `<PackageName> — Design System`.
5.5. **Story-fidelity gate (mandatory, BEFORE build-storybook)** — call `ds_validate_stories({ component_dir: 'pkg/src' })`. The tool parses every `*.stories.{ts,tsx,jsx,js}`, cross-checks every `argTypes` / `args` key against the component's `Props` interface AND `manifest.props_schema`, and verifies every `argTypes.<key>.options` literal exists in `manifest.props_schema.<key>.values`.

   If the tool returns errors:
   - **Do NOT proceed to `npm run build-storybook`.** The build will succeed but the rendered iframe shows unstyled markup (the v1.2.2 Button incident: `argTypes.variant = ['contained','outlined','text']` from training-data leak; CSS only had `.btn-primary`/`.btn-secondary`; result was a button with text "Primary" and zero styling).
   - `submit_plan_to_master` immediately with the tool's error output. The master will re-spawn `components-builder` with the fix list — that retry already exists in the round template.
   - Do NOT try to author stories yourself; story shape is the components-builder's responsibility.

   This was previously a textual self-check that components-builder was supposed to run, but mismatches slipped through silently. The dedicated tool removes the "did the agent actually check?" ambiguity.
6. Run `npm run build-storybook` (or `npx storybook build`) — output goes to `pkg/storybook-static/`.
7. Add `storybook-static` to `package.json#files` so it's included in `npm pack`.
8. If docs and MCP are already present, you may run `ds_audit_package({ pkg_dir: 'pkg' })` and report the result. If audit fails because docs/MCP are still being built in parallel, report only the Storybook-specific checks you completed; the master runs the final audit before publish.

## Story coverage rule

Storybook only renders what components-builder emitted. If a story is missing for a component, ask the master to route it back to components-builder rather than authoring stories yourself — story shape is part of the component contract.

## Output expectations

- `pkg/storybook-static/index.html` exists and loads the side-panel of components.
- `pkg/storybook-static/iframe.html` works without a parent host (the dashboard embeds it directly).
- Build size capped reasonably — strip unused addons (a11y is fine to keep; controls is required; docs is required).

## What to report

`submit_plan_to_master` with:
- Number of stories per component.
- Storybook bundle size.
- Storybook version pinned.

## AVOID

- Don't run Storybook in dev mode (`storybook dev`) — only `build` for the publish path.
- Don't enable webpack-based Storybook for vite stacks; keep build under 60s.
- Don't author stories here — components-builder owns story shape.
- **NO EMOJIS** in story titles, group labels, manager-head titles, or any custom UI text you add.
- No marketing language ("modern", "beautiful").
- Do not call `ds_publish_version`.
