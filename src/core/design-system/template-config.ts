/**
 * Static configuration for the "Design System Creator" company template.
 *
 * Defines the master + 6 specialist subordinates, their tier, skills and
 * system prompt overrides. This is referenced by:
 *   - `bootstrap/ensure-design-system-template.ts` to seed the row in
 *      `company_templates` so the dashboard's existing CompanySession
 *      flow can spawn DS sessions.
 *   - The DS routes (`/api/design-system/sessions`) when creating a new
 *      company session: they pass `template_id` resolved from the seeded
 *      row plus the DS-specific `config_json` (stack, package_name).
 *
 * The skills referenced here MUST exist in `src/core/coder/skills/builtin/`.
 * Provider/model placeholders match what the existing templates use —
 * boot-time wiring picks the host-default provider when these aren't
 * known yet.
 */
import type { CompanyRoleConfig } from '../coder/company/types.js';

export const DESIGN_SYSTEM_TEMPLATE_NAME = 'Design System Creator';
export const DESIGN_SYSTEM_TEMPLATE_DESCRIPTION =
  'Multi-agent pipeline that turns an uploaded HTML/CSS theme into a versioned, MCP-augmented npm package published to the embedded Verdaccio.';

/**
 * Master prompt — orchestrator-only. The actual buildXxx prompts in
 * system-prompts.ts already render the standard master scaffolding;
 * this override appends domain context.
 */
export const MASTER_PROMPT_OVERRIDE = `
# Role: Design System Master

You orchestrate a small team that converts an uploaded HTML/CSS/SCSS theme into
a versioned npm package with bundled MCP server, Storybook and docs.

## Workflow per round

1. Spawn the **extractor** to read the compact \`source-inventory.json\` index,
   follow its shards under \`source-inventory/\`, and produce a validated
   DesignSystemManifestV2 at \`manifest.json\`.
   Wait for completion, then run \`ds_validate_manifest\`.
2. Approve the manifest only after validation (or send back if gaps). Then spawn the
   **components-builder** matching the session's stack
   (ds-components-react / -vue / -angular).
3. Optionally spawn a **pages-builder** in parallel with components for
   page templates (DashboardPage, TablePage, SettingsPage).
4. Spawn the **mcp-builder** once components-builder is done.
5. Spawn **docs-writer** and **storybook-builder** in parallel after mcp.
6. Once all subordinates are green, run \`ds_get_session_info\` and
   \`ds_audit_package\` to confirm state, then call **\`ds_publish_version\`** with
   \`pkg_dir\`. The publish tool runs \`npm pack\` itself after the audit passes.
7. The publish tool either bumps semver and publishes, or marks the
   draft as \`skipped\` (no source changes since last published version).

## Defaults

- Auto-bump kind = patch on every successful round, unless the operator
  set \`next_bump_hint\` to \`minor\` or \`major\` via the dashboard.
- Never edit code yourself — orchestrate only.
- If a subordinate fails twice, mark the draft \`failed\` via
  \`ds_set_version_status({ status: 'failed', error: ... })\` and ask the
  operator for guidance.
`;

/**
 * Roles in the template. \`provider\`/\`model\` are placeholders — the
 * actual values are filled in at session creation from the host's
 * default provider, mirroring what the existing seeded templates do.
 */
export function buildDesignSystemRoles(opts: {
  provider: string;
  model: string;
}): CompanyRoleConfig[] {
  const { provider, model } = opts;
  return [
    {
      role: 'design-system-master',
      provider,
      model,
      tier: 'full',
      systemPromptOverride: MASTER_PROMPT_OVERRIDE,
      // Master has no skill list — it uses master tools + DS publish/status.
    },
    {
      role: 'extractor',
      provider,
      model,
      tier: 'navigate',
      skills: ['ds-extractor'],
    },
    {
      role: 'components-builder',
      provider,
      model,
      tier: 'full',
      // Stack-aware: only the matching ds-components-<stack> skill is
      // enabled per session. Resolved at spawn-time by `resolveRoleSkills`.
      // Previously all three were enabled, so the agent saw conflicting
      // React/Vue/Angular instructions in the same prompt.
      skills: {
        conditional: [
          { when: "session.stack === 'react-ts'", skill: 'ds-components-react' },
          { when: "session.stack === 'vue-ts'", skill: 'ds-components-vue' },
          { when: "session.stack === 'angular'", skill: 'ds-components-angular' },
        ],
      },
    },
    {
      role: 'pages-builder',
      provider,
      model,
      tier: 'full',
      skills: {
        conditional: [
          { when: "session.stack === 'react-ts'", skill: 'ds-components-react' },
          { when: "session.stack === 'vue-ts'", skill: 'ds-components-vue' },
          { when: "session.stack === 'angular'", skill: 'ds-components-angular' },
        ],
      },
    },
    {
      role: 'mcp-builder',
      provider,
      model,
      tier: 'navigate',
      skills: ['ds-mcp-server'],
    },
    {
      role: 'docs-writer',
      provider,
      model,
      tier: 'navigate',
      skills: ['ds-docs'],
    },
    {
      role: 'storybook-builder',
      provider,
      model,
      tier: 'navigate',
      skills: ['ds-storybook'],
    },
  ];
}
