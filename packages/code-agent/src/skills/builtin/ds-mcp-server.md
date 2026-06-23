---
name: ds-mcp-server
description: Generate the auto-MCP server bundled inside the design system npm package. Each component becomes one tool (ds_use_<component>) with a JSON schema derived from the props.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - read_dir
  - ds_get_session_info
  - ds_record_component
  - ds_audit_package
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
    - mcp-builder
  paths:
    - "**/pkg/mcp/**"
    - "**/manifest.json"
  tags:
    - design-system
    - mcp
source: builtin
version: 2.0.0
sort-order: 64
tags:
  - builtin
  - design-system
  - mcp
---

# DS MCP Server Builder — v2

You are the **mcp-builder** subordinate. After components-builder finishes, you generate the **MCP server** that ships INSIDE the npm package, so any company-mode agent that `npm install`s the package immediately gets one tool per component.

## Output location

```
pkg/
├── mcp/
│   ├── server.ts           # entry — exposed via package.json "bin"
│   ├── manifest.json       # mirror of manifest.json for runtime introspection
│   └── tools/
│       └── ds-use-button.ts
└── package.json            # adds "bin": { "<package>-mcp": "./mcp/server.js" }
```

After build, `mcp/server.ts` compiles to `mcp/server.js` (alongside `dist/`). The `bin` entry makes `npx <package>-mcp` work for the consumer's agent.

## Tool generation rule

For every component recorded in the design_system_components table (queryable via the manifest the components-builder wrote), generate ONE tool:

- **Tool name**: `ds_use_<snake_case_component>` (e.g. `ds_use_button`, `ds_use_dashboard_page`).
- **Description**: one-line summary of when to use it. Pull from the component's manifest entry.
- **Input schema**: copy the component's `props_schema_json`. Required props stay required; everything else optional.
- **Output**: returns a JSX/template snippet **as a string** (NOT compiled HTML — the consumer agent edits the snippet directly into their codebase).

Example `mcp/tools/ds-use-button.ts` (React stack):

```ts
import type { Tool, ToolHandler } from '@modelcontextprotocol/sdk';

export const dsUseButton: Tool = {
  name: 'ds_use_button',
  description: 'Insert a Button atom from the design system. Variants: primary | secondary | danger.',
  inputSchema: { /* mirror props_schema_json */ },
};

export const handle: ToolHandler<typeof dsUseButton> = async (input) => {
  const props = renderProps(input); // serialises to `variant="primary" disabled`
  return { content: [{ type: 'text', text: `<Button ${props}>${input.children ?? 'Click'}</Button>` }] };
};
```

For Vue, return `<DsButton variant="primary" />`. For Angular, return `<ds-button variant="primary"></ds-button>`.

## Workflow

1. `ds_get_session_info` to learn stack + package_name.
2. Read `pkg/manifest.json` (the validated DesignSystemManifestV2 written by components-builder) for the full component list and props schemas. If it's missing or not v2-shaped, ask the master to route back to components-builder; do not invent a manifest from memory.
3. Generate `mcp/server.ts` that registers every tool and starts a stdio MCP server (use `@modelcontextprotocol/sdk/server/stdio`).
4. Generate one file per tool under `mcp/tools/`.
5. Generate `mcp/manifest.json` — a flat mirror of the components and their schemas so consumers can introspect without booting the server. This file is mandatory for publish.
6. Update `pkg/package.json`:
   - `"bin": { "<package-name>-mcp": "./mcp/server.js" }`
   - Add `dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" }`
   - `files` array MUST include `"mcp"`.
7. Build the MCP server (`tsc mcp/**/*.ts` or part of the main bundler config) so `mcp/server.js` exists before publish.
8. `submit_plan_to_master` reporting tool count and any components you skipped (e.g. zero-prop components are fine; just generate a tool with empty input schema).

## AVOID

- Don't write a separate package for the MCP — it ships INSIDE the design system package.
- Don't bundle the runtime — components stay as source/dist; the MCP just emits string snippets.
- Don't shell out to anything from the MCP tools — they're pure string emitters.
- **NO EMOJIS** in tool names, descriptions, JSDoc, or emitted snippets. Tone is technical and terse.
- No marketing adjectives in descriptions ("beautiful", "modern", "stunning").
- Do not call `ds_publish_version`.
