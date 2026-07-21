import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PromptContext,
} from '../system-prompt.js';

function baseCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    projectName: 'demo',
    projectRoot: 'D:/demo',
    os: 'win32',
    providerFamily: 'openai',
    profile: 'full',
    availableTools: new Set(['spawn_agent', 'task_list', 'execute_tasks']),
    ...overrides,
  };
}

describe('system prompt — multi-agent execution mode', () => {
  it('makes Ultra proactive but bounded, selective, and non-mandatory', () => {
    const prompt = buildSystemPrompt(baseCtx({ multiAgentMode: 'proactive' }));
    const [prefix, suffix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

    expect(prefix).toContain('# Multi-agent mode (Ultra)');
    expect(prefix).toContain('when parallel work materially improves speed or quality');
    expect(prefix).toContain('Delegation is not a quota');
    expect(prefix).toContain('reasoning to root and children');
    expect(prefix).toContain('At most 3 proactive children');
    expect(prefix).toContain('only read-only `investigator` or `reviewer`');
    expect(prefix).toContain('`verifier` has shell');
    expect(prefix).toContain('children cannot spawn further sub-agents');
    expect(prefix).toContain('Never proactively spawn `implementer` or `full`');
    expect(prefix).toContain("`task_list({gate:'approve'})` then `execute_tasks`");
    expect(prefix).toContain('Ultra grants no write bypass.');
    expect(suffix).not.toContain('Multi-agent mode');
  });

  it('revokes proactive delegation when the session selects the explicit policy', () => {
    const prompt = buildSystemPrompt(baseCtx({ multiAgentMode: 'explicit_request_only' }));

    expect(prompt).toContain('# Multi-agent mode (explicit request only)');
    expect(prompt).toContain('Any earlier instruction enabling proactive multi-agent delegation no longer applies.');
    expect(prompt).toContain('unless the user or applicable AGENTS.md/skill instructions explicitly ask');
    expect(prompt).not.toContain('# Multi-agent mode (Ultra)');
  });

  it('fails closed when proactive mode is requested without spawn_agent', () => {
    const prompt = buildSystemPrompt(baseCtx({
      multiAgentMode: 'proactive',
      availableTools: new Set(['task_list', 'execute_tasks']),
    }));

    expect(prompt).toContain('# Multi-agent mode (explicit request only)');
    expect(prompt).not.toContain('# Multi-agent mode (Ultra)');
  });

  it('preserves the legacy prompt when no mode override is supplied', () => {
    expect(buildSystemPrompt(baseCtx())).not.toContain('# Multi-agent mode');
  });
});
