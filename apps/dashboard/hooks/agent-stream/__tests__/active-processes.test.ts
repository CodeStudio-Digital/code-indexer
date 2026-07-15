import { describe, expect, it } from 'vitest';
import {
  replaceActiveProcesses,
  retainBackgroundProcesses,
  selectVisibleActiveProcesses,
  upsertActiveProcess,
} from '../active-processes.js';

describe('active process state', () => {
  it('preserves start/background metadata across sparse progress updates', () => {
    const initial = upsertActiveProcess([], {
      id: 'agent:g:0',
      source: 'agent',
      kind: 'subagent',
      label: 'Scout',
      background: true,
      startedAt: 1_000,
    }, 1_000);
    const updated = upsertActiveProcess(initial, {
      id: 'agent:g:0',
      source: 'agent',
      kind: 'subagent',
      label: 'Scout',
      elapsedMs: 5_000,
      note: 'reading files',
    }, 6_000);

    expect(updated[0]).toMatchObject({
      background: true,
      startedAt: 1_000,
      updatedAt: 6_000,
      elapsedMs: 5_000,
      note: 'reading files',
    });
  });

  it('retains only detached work at a message boundary', () => {
    const processes = [
      { id: 'tool:1', source: 'tool', kind: 'tool', label: 'read_file', background: false },
      { id: 'agent:g:0', source: 'agent', kind: 'subagent', label: 'Scout', background: true },
    ].reduce((state, patch) => upsertActiveProcess(state, patch as Parameters<typeof upsertActiveProcess>[1], 1_000), []);

    expect(retainBackgroundProcesses(processes).map((process) => process.id)).toEqual(['agent:g:0']);
  });

  it('replaces a wrapper with richer agent rows and hides overlapping activities', () => {
    const wrapper = upsertActiveProcess([], {
      id: 'tool:spawn', source: 'tool', kind: 'spawn_agent', label: 'spawn_agent',
    }, 1_000);
    const replaced = replaceActiveProcesses(
      wrapper,
      (process) => process.source === 'tool' && process.label === 'spawn_agent',
      [{ id: 'agent:g:0', source: 'agent', kind: 'subagent', label: 'Scout' }],
      2_000,
    );
    const withOverlap = upsertActiveProcess(replaced, {
      id: 'op:scout', source: 'activity', kind: 'subagent', label: 'Scout operation',
    }, 2_000);

    expect(selectVisibleActiveProcesses(withOverlap).map((process) => process.id)).toEqual(['agent:g:0']);
  });
});
