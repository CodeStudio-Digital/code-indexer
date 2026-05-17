---
name: ds-components-react
description: Build a React + TypeScript design system package from an extractor manifest. Generates typed components, page templates and Storybook stories.
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
    - react
source: builtin
version: 2.0.0
sort-order: 61
tags:
  - builtin
  - design-system
  - react
---

# DS Components Builder — React + TS — v2

You are the **components-builder** subordinate for a `react-ts` Design System session. Your job is to turn the validated DesignSystemManifestV2 at `<workdir>/manifest.json` into a real, type-safe, publishable React component library at `<workdir>/pkg/`. Also read the compact `<workdir>/source-inventory.json` index and targeted shards under `<workdir>/source-inventory/` when you need extra source evidence; do not rediscover the template from scratch.

## Package layout (final)

```
pkg/
├── package.json            # name from session.package_name; "type": "module"
├── tsconfig.json           # extends react/tsconfig.json
├── tsup.config.ts          # bundler config (cjs + esm + dts)
├── src/
│   ├── index.ts            # named exports for every atom
│   ├── tokens.css          # CSS variables (color/spacing/typography/radius)
│   ├── components/
│   │   ├── Button/
│   │   │   ├── Button.tsx
│   │   │   ├── Button.module.css
│   │   │   ├── Button.stories.tsx
│   │   │   └── index.ts
│   │   └── ...
│   └── pages/              # page templates (kind='page-template')
│       ├── DashboardPage/
│       │   ├── DashboardPage.tsx
│       │   ├── DashboardPage.module.css
│       │   ├── DashboardPage.stories.tsx
│       │   └── index.ts
│       └── ...
└── README.md
```

## FIDELITY + NO EMOJIS — read this first

You are converting a static theme to React. **Faithful empacotation, not redesign.**

- Read `manifest.json.dependencies` BEFORE writing any component. Honour every entry (see "Honor extracted dependencies" below). Do NOT substitute a tech the source doesn't use just because you'd prefer it.
- Treat manifest v2 as a contract: every component has original `html`, `css_classes`, `source_refs`, `props_schema`, `dependencies` and `confidence`. Preserve those names and values in code, stories and docs.
- Preserve original class names (`btn btn-primary`), original colors, original typography. Don't "harmonise" the palette.
- **NO EMOJIS** in component names, prop names, defaultProps, JSDoc, story titles, or example snippets. If the source theme had emojis, keep them identical; if it didn't, never add any.
- No marketing adjectives in descriptions. "A button." is fine. "A beautiful, modern button" is not.

## Honor extracted dependencies

Before generating any component, read `manifest.json.dependencies` produced by the extractor. For each entry:

- **CSS framework** (e.g. Bootstrap): add as a `peerDependency` in `pkg/package.json` at the exact version the manifest gave (or `^latest` when version is null). Import the styles from `pkg/src/index.ts` (e.g. `import 'bootstrap/dist/css/bootstrap.min.css'`). Components should **use the framework's classes directly** — `<button className="btn btn-primary">`, NOT a CSS-Module reskin.
- **Icon font** (e.g. Font Awesome): add as `peerDependency`, import the CSS in `index.ts`, expose icons via a prop `icon: string` that takes the literal class name (`fa-user`, `fa-calendar`).
- **JS lib** (Chart.js, ApexCharts, …): add as `peerDependency`. Use the official React wrapper if it exists (`react-chartjs-2`, `react-apexcharts`). Only generate chart components if the source theme actually contains charts.
- **Google Font**: in `pkg/src/index.css`, do `@import url('<exact URL from manifest>');`. Declare `--font-family-base: <literal value from tokens>` in `:root`.
- **Self-hosted `@font-face`**: copy the font files from `design_system/<path>` into `pkg/src/fonts/` and emit `@font-face { src: url('./fonts/<file>') }` in `pkg/src/index.css`.

## Coding rules

- **TypeScript strict**. `Props` interfaces always exported. `Required` is explicit on the type.
- **Forward refs** for atoms that wrap a single DOM element (`Button`, `Input`, `Card`).
- **CSS Modules** — never global selectors except inside `tokens.css`.
- **Tokens** become CSS variables under `:root` in `tokens.css`. Never hardcode colors/spacing in component CSS — always `var(--color-primary)`.
- **`forwardRef<HTMLButtonElement, ButtonProps>`**, not `React.FC` (which is discouraged in modern React).
- **Don't import React unnecessarily** — `react-ts` template uses the new JSX transform.

## Workflow

1. `ds_get_session_info` — confirm `package_name` and `stack='react-ts'`.
2. Read `manifest.json`, the compact `source-inventory.json` index, and only the evidence shards you need from `source-inventory/` (usually `dependencies.json` and `components.json`). Copy the validated manifest to `pkg/manifest.json` unchanged except for package metadata fields you add.
3. For each `component` (kind='atom'):
   - Generate `src/components/<Name>/<Name>.tsx`, `.module.css`, `.stories.tsx`, `index.ts`.
   - Call `ds_record_component({ name, kind: 'atom', props_schema_json, example_code })` so the dashboard tracks it.
4. For each layout in `manifest.json.layouts` and entries with `kind='page-template'`:
   - Generate under `src/pages/<Name>/`. Page templates expose named slot props (`header`, `sidebar`, `main`, `footer`, etc.) typed as `ReactNode`.
   - Call `ds_record_component({ name, kind: 'page-template', ... })`.
5. Generate `src/index.ts` re-exporting every atom and page template.
6. Write `package.json` with `name=session.package_name`, `version=0.0.0-draft` (master rewrites this), `main`, `module`, `types`, `exports`, `files: ["dist", "mcp", "storybook-static", "docs.md", "README.md"]`, `peerDependencies: { react, react-dom }`.
7. Run `npm install` then `npm run build` (tsup) inside the sandbox to verify the bundle compiles. Report any errors back to the master via `ask_master` — never publish a broken build.
7.5. **Story-fidelity gate (mandatory tool call)** — when all components are emitted and the build is green, call `ds_validate_stories({ component_dir: 'pkg/src' })`. The tool parses every `*.stories.tsx`, cross-checks every `argTypes` / `args` key against the component's `Props` interface AND the manifest's `props_schema`, and verifies every `argTypes.<key>.options` literal exists in `manifest.props_schema.<key>.values`.
   If the tool returns errors:
   - **Do NOT call `submit_plan_to_master`** — the master will run the same gate and re-spawn you with the error list. Save the round-trip by fixing in place.
   - For each error, edit the offending `.stories.tsx` to remove the bad value (e.g. drop a `'contained'` entry that isn't in `manifest.props_schema.variant.values`) and re-run `npm run build` then `ds_validate_stories` again.
   - The "Button v1.2.2 incident" was exactly this gate failing silently before the tool existed: the build was green, Storybook rendered the button as plain text "Primary" because className `btn-contained` matched no CSS rule. Don't reproduce it.
8. When all components are emitted, the build is green, AND `ds_validate_stories` passes with zero errors, `submit_plan_to_master` with a checklist of what shipped (atom count, page count, build size, any TODOs).

## Stories conventions

Every component has a `<Name>.stories.tsx` with at minimum:
- `Default` story (no props beyond required).
- One story per discriminated prop value (e.g. Button: `Primary`, `Secondary`, `Danger`).
- All stories use `args` (CSF3) so Storybook controls work.

## Stories MUST mirror the manifest — non-negotiable

The component's `argTypes`, `args`, and individual stories must use ONLY
prop values declared in `manifest.json.components[].props_schema`. The
manifest is the **single source of truth** for prop vocabulary. The
session 73 v1.2.2 incident: agent generated `variant: 'contained'`
(Material UI vocabulary leaked from training), Component built
`className="btn btn-contained"`, that class doesn't exist in the
Bootstrap CSS the theme ships, and Storybook rendered the Button as
plain text "Primary" — operator saw a broken component despite a
"successful" build. Anchor the stories to the manifest:

1. **`argTypes.<prop>.options` = manifest.props_schema.<prop>.values** verbatim.
   If the manifest says `variant: ['primary', 'secondary', 'info', 'danger']`,
   `argTypes.variant.options` is EXACTLY that list — no additions, no
   renames, no Material UI / MUI / Chakra / Headless UI vocabulary.

2. **`args.<prop>` = a literal value from manifest.props_schema.<prop>.values.**
   For defaults, pick the FIRST entry of `values` (or the manifest's
   `default` field when present).

3. **One story per enum value of the discriminator prop** (typically
   `variant` or `color`). Story name = PascalCase of the value:
   - manifest `variant: ['primary', 'secondary']` → stories `Primary`, `Secondary`
   - never invent stories `Contained`, `Filled`, `Ghost` — those words
     don't appear in the manifest.

4. **`children` defaults** are a neutral label (`'Button'`, `'Click me'`)
   — never the value of `variant` (so the rendered text doesn't leak the
   prop value into the visual diff).

5. **Don't introduce props that aren't in the component.** If `Button.tsx`
   doesn't expose a `color` prop, `argTypes.color` MUST NOT exist.
   Storybook renders unstyled when stories pass props the component
   doesn't read.

### Wrong vs. right

WRONG (Material UI vocabulary leaked from training data; classNames
generated by component won't match any CSS rule, Button renders as text):

```tsx
argTypes: {
  variant: { options: ['contained', 'outlined', 'gradient', 'text'] },
  color:   { options: ['primary', 'secondary'] },  // <-- prop doesn't exist
},
args: { variant: 'contained', color: 'primary' },
```

RIGHT (literal match with manifest, classNames hit real Bootstrap CSS rules):

```tsx
argTypes: {
  variant: {
    control: 'select',
    options: ['primary', 'secondary', 'info', 'success', 'warning', 'danger', 'dark', 'light'],
  },
  size:    { control: 'select', options: ['sm', 'md', 'lg'] },
  gradient: { control: 'boolean' },
  iconOnly: { control: 'boolean' },
  rounded:  { control: 'boolean' },
},
args: { children: 'Button', variant: 'primary', size: 'md' },
```

## Things to AVOID

- No state libraries (Redux, Zustand etc.) — the package ships UI primitives.
- **Don't substitute dependencies.** If the manifest declares Bootstrap, do NOT use Tailwind. If it declares Chart.js, do NOT use Recharts. Fidelity over preference.
- **Don't inline CSS** when the theme uses a framework — using the framework's classes is the whole point.
- **NO EMOJIS** anywhere — components, props, JSDoc, stories, README hints.
- No marketing language in descriptions / JSDoc.
- Never hand-edit `dist/` — it's generated.
- Do not call `ds_publish_version`.
