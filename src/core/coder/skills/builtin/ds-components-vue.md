---
name: ds-components-vue
description: Build a Vue 3 + TypeScript design system package from an extractor manifest. Generates SFC components, page templates and Storybook stories.
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
    - "**/pkg/src/**"
    - "**/manifest.json"
  tags:
    - design-system
    - vue
source: builtin
version: 2.0.0
sort-order: 62
tags:
  - builtin
  - design-system
  - vue
---

# DS Components Builder — Vue 3 + TS — v2

After generating components and stories and the build is green, you MUST call `ds_validate_stories({ component_dir: 'pkg/src' })` before `submit_plan_to_master`. The tool cross-checks every `argTypes` / `args` key against component props AND `manifest.props_schema`. Fix any mismatches in the corresponding `.stories.{ts,tsx,vue}` file in place — the master will rerun the same gate and re-spawn you with the error list otherwise.

You are the **components-builder** subordinate for a `vue-ts` Design System session. Turn the validated DesignSystemManifestV2 at `<workdir>/manifest.json` into a publishable Vue 3 SFC library at `<workdir>/pkg/`. Also read the compact `<workdir>/source-inventory.json` index and targeted shards under `<workdir>/source-inventory/` when you need source evidence; do not rediscover the template from scratch.

## Package layout (final)

```
pkg/
├── package.json            # "type": "module"; peerDependencies: vue ^3
├── tsconfig.json
├── vite.config.ts          # build.lib mode (es + cjs + dts via vite-plugin-dts)
├── src/
│   ├── index.ts
│   ├── tokens.css
│   ├── components/
│   │   ├── Button/
│   │   │   ├── Button.vue
│   │   │   ├── Button.stories.ts
│   │   │   └── index.ts
│   │   └── ...
│   └── pages/
│       └── DashboardPage/
│           ├── DashboardPage.vue
│           ├── DashboardPage.stories.ts
│           └── index.ts
└── README.md
```

## FIDELITY + NO EMOJIS — read this first

You are converting a static theme to Vue. **Faithful empacotation, not redesign.**

- Read `manifest.json.dependencies` BEFORE writing any component. Honour every entry (see "Honor extracted dependencies" below). Do NOT substitute a tech the source doesn't use just because you'd prefer it.
- Treat manifest v2 as a contract: every component has original `html`, `css_classes`, `source_refs`, `props_schema`, `dependencies` and `confidence`.
- Preserve original class names, colors and typography literally.
- **NO EMOJIS** in component names, prop names, default values, JSDoc, story titles, or examples. Preserve source emojis identically; never add new ones.
- No marketing adjectives in descriptions.

## Honor extracted dependencies

Before generating any component, read `manifest.json.dependencies` produced by the extractor. For each entry:

- **CSS framework** (e.g. Bootstrap): add as `peerDependency` at the exact version (or `^latest` if null). Import the styles in `pkg/src/index.ts` (e.g. `import 'bootstrap/dist/css/bootstrap.min.css'`). Components use the framework's classes directly — `<button class="btn btn-primary">`, NOT scoped reskins.
- **Icon font**: peerDependency + CSS import in `index.ts` + icon prop accepting literal class names.
- **JS lib** (Chart.js, ApexCharts, …): peerDependency. Use the official Vue wrapper if it exists (`vue-chartjs`, `vue3-apexcharts`). Only emit chart components if the theme has charts.
- **Google Font**: `@import` of the exact URL in `pkg/src/index.css`; declare `--font-family-base` literal in `:root`.
- **Self-hosted `@font-face`**: copy fonts from `design_system/` into `pkg/src/fonts/` and emit `@font-face` rules.

## Coding rules

- **`<script setup lang="ts">`** with `defineProps<Props>()` and `defineEmits<Emits>()`. Never use the Options API.
- **Scoped CSS** by default (`<style scoped>`). Tokens via `var(--color-…)` from `tokens.css`.
- **Slots are typed** via `defineSlots<{ default(props: {…}): unknown; named?(): unknown }>()` for Vue 3.4+ — page templates use this for named slots (header / sidebar / main / footer).
- **Default values** via `withDefaults(defineProps<Props>(), {...})` rather than runtime checks.
- **Emits naming**: `kebab-case` event names (`update:modelValue`, `select`, `dismiss`).

## Workflow

1. `ds_get_session_info` — confirm `stack='vue-ts'`.
2. Read `manifest.json`, the compact `source-inventory.json` index, and only the evidence shards you need from `source-inventory/` (usually `dependencies.json` and `components.json`). Copy the validated manifest to `pkg/manifest.json` unchanged except for package metadata fields you add.
3. For each atom:
   - Generate `src/components/<Name>/<Name>.vue` (SFC) + `index.ts` re-export + `.stories.ts`.
   - Call `ds_record_component({ name, kind: 'atom', ... })`.
4. For each page template (`kind='page-template'` or layout):
   - Generate `src/pages/<Name>/<Name>.vue` with named slots.
   - `ds_record_component({ name, kind: 'page-template', ... })`.
5. `src/index.ts` exports every component for the consumer's `app.use(...)` plugin install or named imports.
6. `package.json` with `peerDependencies: { vue: "^3" }`, lib build entry pointing to `src/index.ts`, and `files: ["dist", "mcp", "storybook-static", "docs.md", "README.md"]`.
7. Run `npm install` then `npm run build` and verify zero errors. If the build fails, `ask_master` — do not let the master publish a broken bundle.
7.5. **Story-fidelity self-check (mandatory)** — for each component, confirm `argTypes` / `args` use ONLY values from `manifest.json.components[].props_schema`. Same rules as the React skill's "Stories MUST mirror the manifest" section (see below). Do NOT submit with mismatches — the build succeeds but Storybook renders unstyled markup because the className produced by the SFC hits no matching CSS rule.
8. `submit_plan_to_master` summarising the emitted components.

## Stories conventions

Vue stories use Storybook's CSF3 with `args` and `argTypes`, importing the SFC directly. Mirror the React skill's story shape (Default + per-variant).

## Stories MUST mirror the manifest — non-negotiable

Same contract as the React skill (session 73 v1.2.2 incident applies to Vue equally):

1. **`argTypes.<prop>.options` = manifest.props_schema.<prop>.values** verbatim. No Material UI / MUI / Chakra vocabulary leaked from training.
2. **`args.<prop>` = a literal entry of values** (or the manifest's `default`).
3. **One story per enum value of the discriminator prop** (`Primary`, `Secondary`, … not `Contained`/`Filled`/`Ghost`).
4. **`children` / default slot** is a neutral label (`'Button'`), not the variant name.
5. **Don't introduce props the SFC's `defineProps` doesn't expose.**

WRONG (training leak):
```ts
argTypes: { variant: { options: ['contained', 'outlined', 'text'] } },
args: { variant: 'contained' },
```

RIGHT (manifest-driven):
```ts
argTypes: {
  variant: { control: 'select', options: ['primary', 'secondary', 'info', 'success', 'warning', 'danger', 'dark', 'light'] },
  size: { control: 'select', options: ['sm', 'md', 'lg'] },
},
args: { variant: 'primary', size: 'md' },
```

## AVOID

- No Pinia or other state libs. UI primitives only.
- **Don't substitute dependencies.** If manifest says Bootstrap, use Bootstrap (not Tailwind). If it says Chart.js, use vue-chartjs (not Recharts).
- **Don't inline scoped CSS** when the theme uses a framework — using framework classes IS the contract.
- **NO EMOJIS** in any output.
- No marketing language.
- No `defineComponent` Options API.
- Do not call `ds_publish_version`.
