import { describe, it, expect } from 'vitest';
import {
  evaluateToolInvocation,
  resolveToolMetadata,
  findScopeViolations,
  type PolicyContext,
} from '@mcp/code-agent/core/policy.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

/**
 * Minimal tool factory — only the fields the policy module reads. Handlers
 * and parameters are stubbed; we never actually invoke the tool here.
 */
function makeTool(partial: Partial<CoderTool> & Pick<CoderTool, 'name'>): CoderTool {
  return {
    description: '',
    source: 'native',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }),
    ...partial,
  };
}

const baseCtx: PolicyContext = {
  planMode: false,
  planApproved: false,
  taskScope: null,
  strict: false,
  adminOverride: true,
  sandboxBound: false,
};

describe('resolveToolMetadata', () => {
  it('returns the tool\'s explicit metadata when declared', () => {
    const tool = makeTool({
      name: 'custom_tool',
      mutates: true,
      parallelSafe: false,
      riskLevel: 'admin',
      requiresSandbox: true,
      scopeAware: true,
      interactive: false,
    });
    expect(resolveToolMetadata(tool)).toMatchObject({
      mutates: true,
      parallelSafe: false,
      riskLevel: 'admin',
      requiresSandbox: true,
      scopeAware: true,
      interactive: false,
    });
  });

  it('falls back to the built-in classifier for known native tools', () => {
    const tool = makeTool({ name: 'write_file' });
    const meta = resolveToolMetadata(tool);
    expect(meta.mutates).toBe(true);
    expect(meta.scopeAware).toBe(true);
    expect(meta.parallelSafe).toBe(false);
    expect(meta.riskLevel).toBe('write');
  });

  it('classifier marks shell tools as non-mutating (self-gated)', () => {
    const meta = resolveToolMetadata(makeTool({ name: 'run_command' }));
    expect(meta.mutates).toBe(false);   // shell.ts gates internally
    expect(meta.parallelSafe).toBe(false);
    expect(meta.riskLevel).toBe('execute');
  });

  it('classifier marks ask_user / submit_plan as interactive', () => {
    expect(resolveToolMetadata(makeTool({ name: 'ask_user' })).interactive).toBe(true);
    expect(resolveToolMetadata(makeTool({ name: 'submit_plan' })).interactive).toBe(true);
    expect(resolveToolMetadata(makeTool({ name: 'submit_tasks' })).interactive).toBe(true);
  });

  it('explicit fields take precedence over the classifier', () => {
    // Even though `write_file` is classified as mutating, an explicit
    // `mutates: false` on the tool definition wins (e.g., for a wrapper
    // that does its own gating).
    const tool = makeTool({ name: 'write_file', mutates: false });
    expect(resolveToolMetadata(tool).mutates).toBe(false);
  });

  it('unknown native tools default to non-mutating (legacy posture)', () => {
    const meta = resolveToolMetadata(makeTool({ name: 'unknown_native_tool' }));
    expect(meta.mutates).toBe(false);
    expect(meta.parallelSafe).toBe(true);
  });

  it('treats unknown external tools as mutations and serializes them', () => {
    const meta = resolveToolMetadata(
      makeTool({ name: 'ext_unknown__danger', source: 'mcp_external' }),
    );
    expect(meta.mutates).toBe(true);
    expect(meta.parallelSafe).toBe(false);
  });
});

describe('evaluateToolInvocation', () => {
  it('allows a read tool by default', () => {
    const decision = evaluateToolInvocation(makeTool({ name: 'read_file' }), {}, baseCtx);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.metadata.mutates).toBe(false);
  });

  it('blocks a mutating tool in plan mode (no approval)', () => {
    const decision = evaluateToolInvocation(
      makeTool({ name: 'write_file' }),
      { path: 'src/foo.ts', content: 'x' },
      { ...baseCtx, planMode: true, planApproved: false },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('plan_mode');
      expect(decision.detail).toMatch(/submit_plan/);
    }
  });

  it('allows a mutating tool after plan approval', () => {
    const decision = evaluateToolInvocation(
      makeTool({ name: 'write_file' }),
      { path: 'src/foo.ts', content: 'x' },
      { ...baseCtx, planMode: true, planApproved: true },
    );
    expect(decision.allowed).toBe(true);
  });

  it('allows shell tool in plan mode (self-gated by classifier)', () => {
    // Shell tools are classified as `mutates: false` so the policy lets
    // them through; the read-only allowlist inside shell.ts is what
    // actually gates the per-command behaviour during plan mode.
    const decision = evaluateToolInvocation(
      makeTool({ name: 'run_command' }),
      { command: 'ls' },
      { ...baseCtx, planMode: true, planApproved: false },
    );
    expect(decision.allowed).toBe(true);
  });

  it('blocks when sandbox is required but not bound', () => {
    const tool = makeTool({ name: 'sandbox_only_tool', requiresSandbox: true });
    const decision = evaluateToolInvocation(tool, {}, { ...baseCtx, sandboxBound: false });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('sandbox_required');
    }
  });

  it('allows when sandbox is required and bound', () => {
    const tool = makeTool({ name: 'sandbox_only_tool', requiresSandbox: true });
    const decision = evaluateToolInvocation(tool, {}, { ...baseCtx, sandboxBound: true });
    expect(decision.allowed).toBe(true);
  });

  it('strict mode blocks execute/admin tools without adminOverride', () => {
    const tool = makeTool({ name: 'admin_action', riskLevel: 'admin', mutates: false });
    const decision = evaluateToolInvocation(tool, {}, {
      ...baseCtx,
      strict: true,
      adminOverride: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('admin_required');
  });

  it('strict mode lets execute/admin tools through with adminOverride', () => {
    const tool = makeTool({ name: 'admin_action', riskLevel: 'admin', mutates: false });
    const decision = evaluateToolInvocation(tool, {}, {
      ...baseCtx,
      strict: true,
      adminOverride: true,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('findScopeViolations', () => {
  const isInside = (candidate: string, files: string[]) =>
    files.some((f) => f === candidate || candidate.startsWith(f + '/'));

  it('returns empty when every path is inside the scope', () => {
    expect(findScopeViolations(['src/foo.ts', 'src/bar.ts'], ['src/foo.ts', 'src/bar.ts'], isInside))
      .toEqual([]);
  });

  it('returns violators when some paths are outside', () => {
    expect(findScopeViolations(
      ['src/foo.ts', 'lib/baz.ts'],
      ['src/foo.ts'],
      isInside,
    )).toEqual(['lib/baz.ts']);
  });

  it('returns empty for empty candidates (caller treats as no scope check needed)', () => {
    expect(findScopeViolations([], ['src/foo.ts'], isInside)).toEqual([]);
  });
});
