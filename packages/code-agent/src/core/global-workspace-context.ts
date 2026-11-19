import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/** Shared main-agent/subagent briefing for filesystem-backed global sessions. */
export function buildGlobalWorkspaceBriefing(
  ctx: Pick<ToolContext, 'globalWorkspace'>,
): string {
  const gw = ctx.globalWorkspace;
  if (!gw) return '';

  const projectLines = gw.projects.length > 0
    ? gw.projects
        .map((p) => `- ${p.slug}/ -> ${p.name}${p.isPrimary ? ' (primary)' : ''}`)
        .join('\n')
    : '- (no linked projects reported; stop and report the workspace error)';

  return `<workspace-context>
This is a GLOBAL multi-project session.
- Primary project root: ${gw.primaryRootPath}
- Linked project roots:
${projectLines}

There is no virtual union directory. Native file tools route a <project-slug>/ prefix to the corresponding real root.
For shell commands, set cwd to the project slug.
Start orientation with native list_directory/glob when the project scope is unclear; their cross-project results use slug prefixes.
The primary project's MCP tools keep their ordinary names. Secondary projects use mcp__<project-slug>__* tools.
If a project root is unavailable, stop and report it; never fall back to another root.
</workspace-context>`;
}
