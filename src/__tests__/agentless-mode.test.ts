import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSystemPrompt } from '@mcp/code-agent/core/system-prompt.js';

/**
 * B7 — Agentless-style pipeline mode. Pure prompt-engineering hint, gated by
 * CODER_AGENTLESS_MODE=1. When off, the system prompt must not contain the
 * pipeline section (it would otherwise pollute every session).
 */

describe('Agentless pipeline hint — env gated', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CODER_AGENTLESS_MODE;
    delete process.env.CODER_AGENTLESS_MODE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CODER_AGENTLESS_MODE;
    else process.env.CODER_AGENTLESS_MODE = prev;
  });

  function ctx() {
    return {
      projectName: 'p',
      projectRoot: '/p',
      os: process.platform,
      providerFamily: 'generic' as const,
    };
  }

  it('omits the pipeline hint when CODER_AGENTLESS_MODE is unset', () => {
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).not.toContain('Pipeline mode (procedural)');
    expect(prompt).not.toContain('Localize');
  });

  it('omits the pipeline hint when CODER_AGENTLESS_MODE=0', () => {
    process.env.CODER_AGENTLESS_MODE = '0';
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).not.toContain('Pipeline mode (procedural)');
  });

  it('ignores the retired CODER_AGENTLESS_MODE=1 switch', () => {
    process.env.CODER_AGENTLESS_MODE = '1';
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).not.toContain('Pipeline mode (procedural)');
    expect(prompt).toContain('# Operating contract');
  });

  it('keeps the complete prompt stable across retired environment settings', () => {
    const baseline = buildSystemPrompt(ctx());
    process.env.CODER_AGENTLESS_MODE = '1';
    expect(buildSystemPrompt(ctx())).toBe(baseline);
  });
});
