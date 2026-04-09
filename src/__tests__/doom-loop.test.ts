import { describe, it, expect } from 'vitest';
import { toolCallsSignature } from '../core/coder/core/runner.js';

describe('toolCallsSignature', () => {
  it('is empty for zero tool calls', () => {
    expect(toolCallsSignature([])).toBe('');
  });

  it('is stable regardless of key order in input', () => {
    const a = toolCallsSignature([{ name: 'read_file', input: { path: 'a.ts', offset: 0 } }]);
    const b = toolCallsSignature([{ name: 'read_file', input: { offset: 0, path: 'a.ts' } }]);
    expect(a).toBe(b);
  });

  it('is stable regardless of tool call order within a turn', () => {
    const blocks1 = [
      { name: 'read_file', input: { path: 'a.ts' } },
      { name: 'grep', input: { pattern: 'x' } },
    ];
    const blocks2 = [
      { name: 'grep', input: { pattern: 'x' } },
      { name: 'read_file', input: { path: 'a.ts' } },
    ];
    expect(toolCallsSignature(blocks1)).toBe(toolCallsSignature(blocks2));
  });

  it('differentiates on args', () => {
    const a = toolCallsSignature([{ name: 'read_file', input: { path: 'a.ts' } }]);
    const b = toolCallsSignature([{ name: 'read_file', input: { path: 'b.ts' } }]);
    expect(a).not.toBe(b);
  });

  it('handles nested objects and arrays', () => {
    const a = toolCallsSignature([
      { name: 'edit_file', input: { path: 'a.ts', opts: { deep: [1, 2], keep: true } } },
    ]);
    const b = toolCallsSignature([
      { name: 'edit_file', input: { opts: { keep: true, deep: [1, 2] }, path: 'a.ts' } },
    ]);
    expect(a).toBe(b);
  });
});
