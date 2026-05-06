import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildSystemPrompt } from '../core/coder/core/system-prompt.js';

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

  it('includes the pipeline hint when CODER_AGENTLESS_MODE=1', () => {
    process.env.CODER_AGENTLESS_MODE = '1';
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).toContain('Pipeline mode (procedural)');
    expect(prompt).toContain('Localize');
    expect(prompt).toContain('Plan');
    expect(prompt).toContain('Patch');
    expect(prompt).toContain('Verify');
  });

  it('places the pipeline hint AFTER the base body (cache-stable prefix)', () => {
    process.env.CODER_AGENTLESS_MODE = '1';
    const prompt = buildSystemPrompt(ctx());
    // The base body comes from prompts/base.txt and includes "Project:" or
    // similar boilerplate. Whatever the exact opener, the pipeline hint
    // must come AFTER it so toggling the env on/off doesn't move the cache
    // prefix.
    const pipelineIdx = prompt.indexOf('Pipeline mode (procedural)');
    const interactionIdx = prompt.indexOf('Interactive tools');
    expect(pipelineIdx).toBeGreaterThan(0);
    expect(interactionIdx).toBeGreaterThan(0);
    expect(pipelineIdx).toBeGreaterThan(interactionIdx);
  });
});
