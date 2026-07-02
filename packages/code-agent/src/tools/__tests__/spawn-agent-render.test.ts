/**
 * spawn-agent-render — byte-parity lock with the legacy inline rendering in
 * spawn-agent.ts (the dashboard regex-parses these headers back out of
 * persisted history), plus the optional spawn=/group=/attempt= tokens used
 * by the async/resume paths.
 */
import { describe, it, expect } from 'vitest';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import {
  renderSingleHeader,
  renderSingleBody,
  renderParallelHeader,
  renderAgentSection,
  renderParallelBody,
  renderResumeHint,
  type RenderableAgentResult,
} from '@mcp/code-agent/tools/spawn-agent-render.js';

const info = { provider: 'openai', model: 'gpt-5.4-mini' };
const usage: ChatUsage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 };

function result(overrides: Partial<RenderableAgentResult> = {}): RenderableAgentResult {
  return {
    label: 'auth-flow',
    type: 'explore',
    reason: 'completed',
    toolCallCount: 7,
    usage,
    finalText: 'found it',
    ...overrides,
  };
}

describe('spawn-agent-render', () => {
  it('single header matches the legacy byte format', () => {
    expect(renderSingleHeader(info, 'explore', 'completed', usage)).toBe(
      '[subagent provider=openai model=gpt-5.4-mini type=explore ' +
      'reason=completed input=100 output=50 cache_hit=25]\n\n',
    );
  });

  it('single header appends spawn= token only when provided', () => {
    expect(renderSingleHeader(info, 'explore', 'error', usage, 'ab12cd34')).toBe(
      '[subagent provider=openai model=gpt-5.4-mini type=explore ' +
      'reason=error input=100 output=50 cache_hit=25 spawn=ab12cd34]\n\n',
    );
  });

  it('single body falls back with the legacy phrasing', () => {
    expect(renderSingleBody('summary', 'completed')).toBe('summary');
    expect(renderSingleBody('', 'timed_out')).toBe(
      '(subagent did not produce a final summary — reason=timed_out. Retry with narrower scope or investigate directly.)',
    );
  });

  it('parallel header matches the legacy byte format, group= token optional', () => {
    expect(renderParallelHeader(3, info, usage)).toBe(
      '[parallel agents: 3 agents, provider=openai model=gpt-5.4-mini, ' +
      'input=100 output=50 cache_hit=25]\n\n',
    );
    expect(renderParallelHeader(3, info, usage, '9d2c41aa')).toBe(
      '[parallel agents: 3 agents, group=9d2c41aa, provider=openai model=gpt-5.4-mini, ' +
      'input=100 output=50 cache_hit=25]\n\n',
    );
  });

  it('agent section matches the legacy byte format', () => {
    expect(renderAgentSection(0, result())).toBe(
      '### Agent 1: auth-flow\n[type=explore reason=completed tools=7 input=100 output=50]\nfound it',
    );
  });

  it('agent section renders attempt= only from attempt 2 and (no summary produced) fallback', () => {
    expect(renderAgentSection(1, result({ attempt: 1 }))).not.toContain('attempt=');
    expect(renderAgentSection(1, result({ attempt: 2, finalText: '' }))).toBe(
      '### Agent 2: auth-flow\n[type=explore reason=completed tools=7 input=100 output=50 attempt=2]\n(no summary produced)',
    );
  });

  it('parallel body joins sections with the legacy separator', () => {
    const body = renderParallelBody([result(), result({ label: 'db-layer' })]);
    expect(body.split('\n\n---\n\n')).toHaveLength(2);
    expect(body).toContain('### Agent 1: auth-flow');
    expect(body).toContain('### Agent 2: db-layer');
  });

  it('resume hint names the tool, the spawn id and the guidance arg', () => {
    const hint = renderResumeHint('9d2c41aa', 2);
    expect(hint).toContain('resume_agent({spawn_id:"9d2c41aa"})');
    expect(hint).toContain('2 agents did not complete');
    expect(hint).toContain('guidance');
    expect(renderResumeHint('x', 1)).toContain('1 agent did not complete');
  });
});
