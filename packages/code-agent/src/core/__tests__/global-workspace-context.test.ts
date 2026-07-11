import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tool.js';
import { buildGlobalWorkspaceBriefing } from '../global-workspace-context.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { buildSubagentWorkspaceBriefing } from '../../tools/spawn-agent-core.js';

const toolContext = {
  cwd: 'C:/data/global-workspaces/abc',
  projectName: '__global_abc',
  globalWorkspace: {
    syntheticProjectName: '__global_abc',
    rootPath: 'C:/data/global-workspaces/abc',
    projects: [
      {
        projectId: 7,
        name: 'poa-backend',
        slug: 'poa-backend',
        rootPath: 'D:/poa/backend',
        isPrimary: true,
      },
      {
        projectId: 11,
        name: 'poa-intranet-angular',
        slug: 'poa-intranet-angular',
        rootPath: 'D:/poa/intranet',
        isPrimary: false,
      },
    ],
  },
} as ToolContext;

describe('global workspace context', () => {
  it('uses the same briefing for the main agent and subagents', () => {
    const shared = buildGlobalWorkspaceBriefing(toolContext);
    expect(buildSubagentWorkspaceBriefing(toolContext)).toBe(shared);
    expect(shared).toContain('poa-intranet-angular/ -> poa-intranet-angular');
    expect(shared).toContain('intentionally NOT a Git repository');
    expect(shared).toContain('run_command({cwd:"<project-slug>"');
  });

  it('injects the workspace map only into global system prompts', () => {
    const base = {
      projectName: '__global_abc',
      projectRoot: 'C:/data/global-workspaces/abc',
      os: 'win32',
      providerFamily: 'generic' as const,
      profile: 'navigate' as const,
    };
    const globalPrompt = buildSystemPrompt({ ...base, globalWorkspace: toolContext.globalWorkspace });
    const ordinaryPrompt = buildSystemPrompt(base);
    expect(globalPrompt).toContain('<workspace-context>');
    expect(globalPrompt).toContain('poa-backend/ -> poa-backend (primary)');
    expect(ordinaryPrompt).not.toContain('<workspace-context>');
  });
});
