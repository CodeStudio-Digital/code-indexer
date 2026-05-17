---
name: ds-components-angular
description: Build an Angular standalone-component design system package from an extractor manifest. Generates typed components, page templates and Storybook stories.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - read_dir
  - list_services
  - ds_get_session_info
  - ds_record_component
  - ds_validate_stories
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
    - components-builder
    - pages-builder
  paths:
    - "**/projects/*/src/**"
    - "**/manifest.json"
  tags:
    - design-system
    - angular
source: builtin
version: 2.0.0
sort-order: 63
tags:
  - builtin
  - design-system
  - angular
---

# DS Components Builder — Angular — v2

After generating components and stories and the build is green, you MUST call `ds_validate_stories({ component_dir: 'projects/<lib>/src' })` before `submit_plan_to_master`. The tool cross-checks every `argTypes` / `args` key against component inputs AND `manifest.props_schema`. Fix any mismatches in the corresponding `.stories.ts` file in place — the master will rerun the same gate and re-spawn you with the error list otherwise.

You are the **components-builder** subordinate for an `angular` Design System session. Turn the validated DesignSystemManifestV2 at `<workdir>/manifest.json` into a publishable Angular library at `<workdir>/pkg/`. Also read the compact `<workdir>/source-inventory.json` index and targeted shards under `<workdir>/source-inventory/` when you need source evidence; do not rediscover the template from scratch.

## Package layout (final — uses Angular's `ng-packagr` flow)

```
pkg/
├── package.json            # peerDependencies: @angular/core, @angular/common
├── ng-package.json         # ng-packagr entry config
├── tsconfig.lib.json
├── src/
│   ├── public-api.ts       # barrel exports
│   ├── tokens.css
│   ├── components/
│   │   ├── button/
│   │   │   ├── button.component.ts
│   │   │   ├── button.component.html
│   │   │   ├── button.component.css
│   │   │   ├── button.stories.ts
│   │   │   └── index.ts
│   │   └── ...
│   └── pages/
│       └── dashboard-page/
│           ├── dashboard-page.component.ts
│           ├── dashboard-page.component.html
│           ├── dashboard-page.component.css
│           ├── dashboard-page.stories.ts
│           └── index.ts
└── README.md
```

## FIDELITY + NO EMOJIS — read this first

You are converting a static theme to Angular. **Faithful empacotation, not redesign.**

- Read `manifest.json.dependencies` BEFORE writing any component. Honour every entry. Do NOT substitute a tech the source doesn't use just because you'd prefer it.
- Treat manifest v2 as a contract: every component has original `html`, `css_classes`, `source_refs`, `props_schema`, `dependencies` and `confidence`.
- Preserve original class names, colors and typography literally.
- **NO EMOJIS** in selectors, class names, JSDoc, stories, or example usage. Preserve source emojis identically; never add new ones.
- No marketing adjectives in descriptions.

## Honor extracted dependencies

Before generating any component, read `manifest.json.dependencies`. For each entry:

- **CSS framework** (e.g. Bootstrap): add as `peerDependency` in `pkg/package.json` at the exact version. Import the styles globally in `angular.json#styles` of the package's lib build (or via `@import` in `pkg/src/styles.css` consumed by ng-packagr). Components use the framework's classes directly in their template — `<button class="btn btn-primary">`.
- **Icon font**: peerDependency + global CSS import + icon input that takes a literal class name (`fa-user`).
- **JS lib** (Chart.js, ApexCharts, …): peerDependency. Use the Angular wrapper when available (`ng2-charts`, `ng-apexcharts`). Generate chart components only if the theme has charts.
- **Google Font**: `@import` URL in `pkg/src/styles.css`. Declare `--font-family-base` literally in `:root`.
- **Self-hosted `@font-face`**: copy fonts from `design_system/` to `pkg/src/fonts/` and emit `@font-face` rules.

## Coding rules

- **Standalone components only** (`standalone: true`). NO NgModules.
- **Signals** for component state when reactive (`input()`, `output()`, `model()` from `@angular/core` ≥17).
- **`OnPush` change detection** by default.
- Selector convention: `ds-<kebab-case>` (e.g. `ds-button`, `ds-dashboard-page`).
- Typed `@Input()`s with explicit defaults; required inputs use `input.required<Type>()` (Angular 17.1+).
- **Slots** — page templates expose content via `<ng-content>` with `select=` attributes (`select="[header]"`, `select="[sidebar]"`, etc.).

## Workflow

1. `ds_get_session_info` — confirm `stack='angular'`.
2. Read `manifest.json`, the compact `source-inventory.json` index, and only the evidence shards you need from `source-inventory/` (usually `dependencies.json` and `components.json`). Copy the validated manifest to `pkg/manifest.json` unchanged except for package metadata fields you add.
3. Use file/folder kebab-case (`button.component.ts`) but Angular class names PascalCase (`ButtonComponent`). Component names recorded via `ds_record_component` use **PascalCase without the `Component` suffix** (`Button`, not `ButtonComponent`) so the dashboard list stays clean.
4. For each atom: generate `src/components/<kebab>/<kebab>.component.{ts,html,css}` + stories + barrel.
5. For each page template / layout: same under `src/pages/`. Always provide named slots via `<ng-content select="[name]">`.
6. `src/public-api.ts` re-exports every component class.
7. `package.json` with `peerDependencies: { "@angular/core": "^17", "@angular/common": "^17" }`, `files: ["dist", "mcp", "storybook-static", "docs.md", "README.md"]`. `ng-package.json` references `public-api.ts`.
8. Run `npm install` then `npx ng build pkg` (or `npx ng-packagr -p ng-package.json`) inside the sandbox. Bundle goes to `pkg/dist/`. The master will `npm pack` from `pkg/dist/` (NOT from `pkg/` — Angular libs are published from the dist folder).
8.5. **Story-fidelity self-check (mandatory)** — for each component, confirm `argTypes` / `args` use ONLY values from `manifest.json.components[].props_schema`. Same rules as the React skill's "Stories MUST mirror the manifest" section (see below). Do NOT submit with mismatches — Storybook would render `<ds-button variant="contained">` and the component would emit `class="btn btn-contained"` which hits no CSS rule, so the operator sees plain text instead of a styled button.
9. `submit_plan_to_master` summarising what shipped + a note that `pkg_dir=pkg/dist/` for `ds_publish_version`.

## Stories conventions

Storybook for Angular uses the `Meta`/`StoryObj` pattern with `args`. Each component has stories under `<kebab>.stories.ts`.

## Stories MUST mirror the manifest — non-negotiable

Same contract as the React skill (session 73 v1.2.2 incident applies to Angular equally):

1. **`argTypes.<input>.options` = manifest.props_schema.<input>.values** verbatim. No Material UI / MUI / Chakra vocabulary leaked from training.
2. **`args.<input>` = a literal entry of values** (or the manifest's `default`).
3. **One story per enum value of the discriminator input** (`Primary`, `Secondary`, … not `Contained`/`Filled`/`Ghost`).
4. **Default content (`<ng-content>`)** is a neutral label, not the input value.
5. **Don't introduce inputs the standalone component's `@Input()`s don't expose.**

WRONG (training leak; produces `<ds-button variant="contained">` → `class="btn btn-contained"` → no CSS match):
```ts
argTypes: { variant: { options: ['contained', 'outlined', 'text'] } },
args: { variant: 'contained' },
```

RIGHT (manifest-driven; classNames hit real Bootstrap rules):
```ts
argTypes: {
  variant: { control: 'select', options: ['primary', 'secondary', 'info', 'success', 'warning', 'danger', 'dark', 'light'] },
  size: { control: 'select', options: ['sm', 'md', 'lg'] },
},
args: { variant: 'primary', size: 'md' },
```

## AVOID

- No NgModules (`standalone: true` everywhere).
- No state libs (NgRx, Akita, etc.).
- **Don't substitute dependencies.** If manifest says Bootstrap, use Bootstrap (not Tailwind). If it says Chart.js, use ng2-charts (not custom SVG charts).
- **Don't reskin in component CSS** when the theme uses a CSS framework — use the framework's classes in templates.
- **NO EMOJIS** in any output.
- No marketing language.
- Do not hand-edit `pkg/dist/`.
- Do not call `ds_publish_version`.
