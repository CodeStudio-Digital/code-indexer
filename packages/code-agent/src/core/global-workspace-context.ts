import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/** Shared main-agent/subagent briefing for synthetic global workspaces. */
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
This is a GLOBAL session over a virtual union workspace.
- Virtual root: ${gw.rootPath}
- Linked project folders (directory junctions/symlinks):
${projectLines}

The virtual root is intentionally NOT a Git repository. A Git error at the virtual root does not mean the workspace is empty.
All file paths must start with a linked project slug, for example: <project-slug>/src/file.ts.
For shell and Git commands, set cwd to the linked project folder, for example: run_command({cwd:"<project-slug>", command:"git status --short"}).
Start orientation with native list_directory/glob at the virtual root when the project scope is unclear.
Do not pass or invent project_name for mcp__* tools; the bridge injects the synthetic workspace project.
If an MCP result is empty while the workspace has linked folders, retry with native list_directory/glob before concluding that files are absent.
</workspace-context>`;
}
