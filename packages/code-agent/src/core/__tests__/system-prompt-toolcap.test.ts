/**
 * The old "Tool visibility" block repeated what "# Tool discovery" already
 * says (use find_tools for a missing schema) on every capped session. It was
 * removed; the discovery guidance lives once, in "# Tool discovery".
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type PromptContext } from '../system-prompt.js';

function baseCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    projectName: 'demo',
    projectRoot: 'D:/demo',
    os: 'win32',
    providerFamily: 'zai',
    profile: 'bootstrap',
    availableTools: new Set(['find_tools', 'code_exec', 'read_file']),
    ...overrides,
  };
}

describe('system prompt — discovery guidance appears once', () => {
  it('renders "# Tool discovery" and no "# Tool visibility" block', () => {
    // The host used to pass a direct-tool budget on every capped session; an
    // extra field like that must not bring the duplicate block back.
    const prompt = buildSystemPrompt({ ...baseCtx(), toolCap: { maxTools: 28, approxCatalog: 89 } } as PromptContext);
    expect(prompt).toContain('# Tool discovery');
    expect(prompt).not.toContain('# Tool visibility');
    expect(prompt).not.toContain('Direct-tool budget');
  });
});
