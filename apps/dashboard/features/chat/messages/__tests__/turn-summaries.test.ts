import { describe, expect, it } from 'vitest';
import type { VisualGroup } from '../../types.js';
import { computeTurnEditSummaries } from '../turn-summaries.js';

type Tool = { name: string; input: Record<string, unknown> };

function userGroup(messageId = 100): VisualGroup {
  return { kind: 'user', message: { role: 'user', content: [] }, messageId };
}

function asstGroup(tools: Tool[]): VisualGroup {
  return {
    kind: 'assistant',
    messages: [
      {
        role: 'assistant',
        content: tools.map((tl, i) => ({ type: 'tool_use', id: `t${i}`, name: tl.name, input: tl.input })),
      },
    ],
    messageIds: [1],
    usages: [undefined],
    hasText: false,
  };
}

describe('computeTurnEditSummaries', () => {
  it('keys a turn summary by the last assistant group index', () => {
    const groups: VisualGroup[] = [userGroup(), asstGroup([{ name: 'edit_file', input: { path: 'a.ts' } }])];
    const out = computeTurnEditSummaries(groups);
    expect([...out.keys()]).toEqual([1]);
    expect(out.get(1)).toEqual({
      roundMessageId: 100,
      paths: [{ path: 'a.ts', op: 'edit' }],
    });
  });

  it('coalesces consecutive assistant groups into one turn, keyed at the last', () => {
    const groups: VisualGroup[] = [
      userGroup(),
      asstGroup([{ name: 'edit_file', input: { path: 'a.ts' } }]),
      asstGroup([{ name: 'write_file', input: { path: 'b.ts', content: 'x' } }]),
    ];
    const out = computeTurnEditSummaries(groups);
    expect([...out.keys()]).toEqual([2]);
    expect(out.get(2)).toEqual({
      roundMessageId: 100,
      paths: [
        { path: 'a.ts', op: 'edit' },
        { path: 'b.ts', op: 'edit' },
      ],
    });
  });

  it('produces one entry per turn across a multi-turn conversation', () => {
    const groups: VisualGroup[] = [
      userGroup(100),
      asstGroup([{ name: 'edit_file', input: { path: 'a.ts' } }]),
      userGroup(200),
      asstGroup([{ name: 'create_file', input: { path: 'c.ts', content: '' } }]),
    ];
    const out = computeTurnEditSummaries(groups);
    expect([...out.keys()]).toEqual([1, 3]);
    expect(out.get(3)).toEqual({
      roundMessageId: 200,
      paths: [{ path: 'c.ts', op: 'add' }],
    });
  });

  it('dedupes a path edited twice in a turn (last op wins)', () => {
    const groups: VisualGroup[] = [
      userGroup(),
      asstGroup([
        { name: 'create_file', input: { path: 'a.ts', content: '' } },
        { name: 'edit_file', input: { path: 'a.ts' } },
      ]),
    ];
    const out = computeTurnEditSummaries(groups);
    expect(out.get(1)).toEqual({
      roundMessageId: 100,
      paths: [{ path: 'a.ts', op: 'edit' }],
    });
  });

  it('emits no entry for a turn with no file edits (or only non-edit tools)', () => {
    const groups: VisualGroup[] = [
      userGroup(),
      asstGroup([{ name: 'read_file', input: { path: 'a.ts' } }, { name: 'grep', input: { pattern: 'x' } }]),
    ];
    expect(computeTurnEditSummaries(groups).size).toBe(0);
  });
});
