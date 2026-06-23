/**
 * Tests for the spec-mode policy gate. The dedicated `specMode`/`specApproved`
 * fields on `PolicyContext` (added by the SDD feature) must block mutating
 * tools until a `submit_spec` is approved, mirroring the long-standing
 * `planMode` gate but on a separate flag so the two modes never collide.
 */
import { describe, it, expect } from 'vitest';
import { evaluateToolInvocation, type PolicyContext } from '@mcp/code-agent/core/policy.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

function makeTool(overrides: Partial<CoderTool> = {}): CoderTool {
  return {
    name: 'write_file',
    description: 'test',
    source: 'native',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ content: '' }),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    planMode: false,
    planApproved: false,
    specMode: false,
    specApproved: false,
    taskScope: null,
    strict: false,
    adminOverride: true,
    sandboxBound: true,
    ...overrides,
  };
}

describe('policy — spec mode gate', () => {
  it('blocks a mutating tool when specMode is on and specApproved is false', () => {
    const tool = makeTool({ name: 'write_file' });
    const decision = evaluateToolInvocation(tool, { path: 'foo.ts', content: 'x' }, makeCtx({ specMode: true }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('spec_mode');
      expect(decision.detail).toMatch(/spec mode/i);
    }
  });

  it('allows the same mutating tool once specApproved flips to true', () => {
    const tool = makeTool({ name: 'write_file' });
    const decision = evaluateToolInvocation(
      tool,
      { path: 'foo.ts', content: 'x' },
      makeCtx({ specMode: true, specApproved: true }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('does not interfere with read-only tools while in spec mode', () => {
    const tool = makeTool({ name: 'read_file' });
    const decision = evaluateToolInvocation(tool, { path: 'foo.ts' }, makeCtx({ specMode: true }));
    expect(decision.allowed).toBe(true);
  });

  it('runs independently of planMode (both off → no gate)', () => {
    const tool = makeTool({ name: 'write_file' });
    const decision = evaluateToolInvocation(tool, { path: 'foo.ts' }, makeCtx({ planMode: false, specMode: false }));
    expect(decision.allowed).toBe(true);
  });

  it('planMode failure path is unchanged when spec fields are absent', () => {
    const tool = makeTool({ name: 'write_file' });
    const decision = evaluateToolInvocation(tool, { path: 'foo.ts' }, makeCtx({ planMode: true, planApproved: false }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('plan_mode');
  });
});
