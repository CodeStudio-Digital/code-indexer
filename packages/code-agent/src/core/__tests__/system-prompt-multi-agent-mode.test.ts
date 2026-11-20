import { describe, expect, it } from 'vitest';
import { resolveUltraPreset } from '../../sessions/ultra-policy.js';
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
    // A Company subordinate under Ultra: it delegates with workflow (spawn_agent is gone).
    availableTools: new Set(['workflow', 'task_list', 'execute_tasks', 'reply_chat_message']),
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

  it('names only the peer tools present in the session', () => {
    const prompt = buildSystemPrompt(baseCtx({ multiAgentMode: 'proactive', availableTools: new Set(['workflow', 'send_chat_message']) }));
    expect(prompt).toContain('send_chat_message');
    expect(prompt).not.toMatch(/list_chats|reply_chat_message|resume_chat/);
  });

  it('revokes proactive delegation when the session selects the explicit policy', () => {
    const prompt = buildSystemPrompt(baseCtx({ multiAgentMode: 'explicit_request_only' }));

    expect(prompt).toContain('# Multi-agent mode (explicit request only)');
    expect(prompt).toContain('Any earlier instruction enabling proactive multi-agent delegation no longer applies.');
    expect(prompt).toContain('unless the user or applicable AGENTS.md/skill instructions explicitly ask');
    expect(prompt).not.toContain('# Multi-agent mode (Ultra)');
  });

  it('keeps Ultra for a Company master through spawn_subordinate_agent, and no longer for spawn_agent', () => {
    expect(buildSystemPrompt(baseCtx({ multiAgentMode: 'proactive', availableTools: new Set(['spawn_subordinate_agent']) })))
      .toContain('# Ultra collaboration');
    expect(buildSystemPrompt(baseCtx({ multiAgentMode: 'proactive', availableTools: new Set(['spawn_agent']) })))
      .toContain('# Multi-agent mode (explicit request only)');
  });

  it('fails closed when proactive mode is requested without a tool that delegates', () => {
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

  it.each([{ maxParallel: 0 }, { canDelegate: false }])('honors the resolved delegation limit %j', (limits: { maxParallel?: number; canDelegate?: boolean }) => {
    const prompt = buildSystemPrompt(baseCtx({
      multiAgentMode: 'proactive',
      ultraPolicy: resolveUltraPreset({ enabled: true, ...limits }),
    }));
    expect(prompt).not.toContain('# Ultra collaboration');
    expect(prompt).not.toContain('at most 0 children');
  });

  it('renders the effective child cap rather than the requested preset cap', () => {
    const prompt = buildSystemPrompt(baseCtx({
      multiAgentMode: 'proactive',
      ultraPolicy: resolveUltraPreset({ enabled: true, maxParallel: 1 }),
    }));
    expect(prompt).toContain('at most 1 children');
  });
});
