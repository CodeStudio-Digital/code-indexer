import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import { activateAppCoordinatorConversation } from '../agents.js';

function setup(options: {
  currentStatus?: 'idle' | 'running' | 'error';
  candidateProjectId?: number;
  candidateAgent?: string | null;
} = {}) {
  const appSession = {
    id: 7,
    project_id: 11,
    coordinator_session_id: 20,
    agent_config_json: JSON.stringify({
      v: 1,
      coordinator_prompt: '',
      coordinator_skills: ['skill-a'],
      profiles: { verify: { enabled: true, additional_prompt: '', skills: ['skill-b'] } },
    }),
  };
  const sessions = new Map<number, Record<string, unknown>>([
    [20, { id: 20, project_id: 11, status: options.currentStatus ?? 'idle', is_archived: false, is_global: false, agent: 'app_orchestrator' }],
    [21, { id: 21, project_id: options.candidateProjectId ?? 11, status: 'idle', is_archived: false, is_global: false, agent: options.candidateAgent ?? 'app_orchestrator' }],
  ]);
  const setCoordinatorSessionId = vi.fn();
  const appendWorkflowEvent = vi.fn();
  const setSessionSkillEnabled = vi.fn();
  const deps = {
    appStudioStore: {
      getSession: vi.fn(() => appSession),
      setCoordinatorSessionId,
      appendWorkflowEvent,
    },
    sessionStore: {
      getSession: vi.fn((id: number) => sessions.get(id) ?? null),
    },
    skillStore: { setSessionSkillEnabled },
  } as unknown as ServerDeps;
  return { deps, setCoordinatorSessionId, appendWorkflowEvent, setSessionSkillEnabled };
}

describe('App Studio coordinator conversations', () => {
  it('activates an App Studio conversation and carries the configured skills', () => {
    const { deps, setCoordinatorSessionId, appendWorkflowEvent, setSessionSkillEnabled } = setup();

    expect(activateAppCoordinatorConversation(deps, 7, 21)).toEqual({
      ok: true,
      coordinator_session_id: 21,
    });
    expect(setSessionSkillEnabled).toHaveBeenCalledWith(21, 'skill-a', true);
    expect(setSessionSkillEnabled).toHaveBeenCalledWith(21, 'skill-b', true);
    expect(setCoordinatorSessionId).toHaveBeenCalledWith(7, 21);
    expect(appendWorkflowEvent).toHaveBeenCalledWith(
      7,
      'agents.coordinator_changed',
      'coder_session',
      '21',
      JSON.stringify({ previous_coordinator_session_id: 20, coordinator_session_id: 21 }),
    );
  });

  it('rejects a conversation from another project or agent', () => {
    expect(activateAppCoordinatorConversation(setup({ candidateProjectId: 12 }).deps, 7, 21)).toMatchObject({ ok: false, status: 404 });
    expect(activateAppCoordinatorConversation(setup({ candidateAgent: 'build' }).deps, 7, 21)).toMatchObject({ ok: false, status: 409 });
  });

  it('does not switch away from a coordinator that is still running', () => {
    const { deps, setCoordinatorSessionId } = setup({ currentStatus: 'running' });

    expect(activateAppCoordinatorConversation(deps, 7, 21)).toMatchObject({ ok: false, status: 409 });
    expect(setCoordinatorSessionId).not.toHaveBeenCalled();
  });
});
