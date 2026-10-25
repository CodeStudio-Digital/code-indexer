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

    expect(prefix).toContain('# Ultra collaboration');
    expect(prefix).toContain('Keep simple work in one agent');
    expect(prefix).toContain('Preserve Explore/Plan');
    expect(prefix).toContain('reply_chat_message');
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
