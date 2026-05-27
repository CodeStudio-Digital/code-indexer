/**
 * Unit tests for the tuple-hash dedup guard.
 *
 * Contract:
 *   - 1st identical call → allow, count=1, registered in the map.
 *   - 2nd identical call → allow-with-reminder, reminder mentions first turn.
 *   - 3rd+ identical call → refuse with payload citing the count.
 *   - Polling-pattern names (mcp__list_*, *_status, await_*, …) → never dedup.
 *   - Repeatable tool flag → never dedup.
 *   - Different args under the same name → tracked separately.
 *   - resetDupCalls clears state fully.
 */
import { describe, it, expect } from 'vitest';
import {
  checkDupCall,
  resetDupCalls,
  type DupVerdict,
} from '../tuple-hash-dedup.js';
import type { DupCallEntry } from '../../machine/types.js';

function fresh(): Map<string, DupCallEntry> {
  return new Map();
}

describe('checkDupCall', () => {
  it('allows the first call and registers in the table', () => {
    const dupCalls = fresh();
    const verdict = checkDupCall({
      name: 'read_file',
      input: { path: 'src/foo.ts' },
      isRepeatable: false,
      turn: 1,
      useId: 'u1',
      dupCalls,
    });
    expect(verdict.kind).toBe('allow');
    expect(verdict.entry.count).toBe(1);
    expect(dupCalls.size).toBe(1);
  });

  it('reminds on the 2nd identical call', () => {
    const dupCalls = fresh();
    const base = { name: 'read_file', input: { path: 'src/foo.ts' }, isRepeatable: false, dupCalls };
    checkDupCall({ ...base, turn: 1, useId: 'u1' });
    const verdict = checkDupCall({ ...base, turn: 2, useId: 'u2' });
    expect(verdict.kind).toBe('allow-with-reminder');
    if (verdict.kind === 'allow-with-reminder') {
      expect(verdict.entry.count).toBe(2);
      expect(verdict.reminderText).toMatch(/dedup: 2nd identical call/);
      expect(verdict.reminderText).toMatch(/1st at turn 1/);
    }
  });

  it('refuses on the 3rd identical call', () => {
    const dupCalls = fresh();
    const base = { name: 'read_file', input: { path: 'src/foo.ts' }, isRepeatable: false, dupCalls };
    checkDupCall({ ...base, turn: 1, useId: 'u1' });
    checkDupCall({ ...base, turn: 2, useId: 'u2' });
    const verdict = checkDupCall({ ...base, turn: 3, useId: 'u3' });
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind === 'refuse') {
      expect(verdict.entry.count).toBe(3);
      expect(verdict.refuseText).toMatch(/loop-refused/);
      expect(verdict.refuseText).toMatch(/call #3/);
    }
  });

  it('keeps refusing on subsequent identical calls (idempotent refusal)', () => {
    const dupCalls = fresh();
    const base = { name: 'read_file', input: { path: 'src/foo.ts' }, isRepeatable: false, dupCalls };
    for (let i = 1; i <= 3; i++) checkDupCall({ ...base, turn: i, useId: `u${i}` });
    const verdict = checkDupCall({ ...base, turn: 4, useId: 'u4' });
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind === 'refuse') {
      expect(verdict.entry.count).toBe(4);
    }
  });

  it('treats different args under the same name as separate keys', () => {
    const dupCalls = fresh();
    const a = checkDupCall({
      name: 'read_file',
      input: { path: 'a.ts' },
      isRepeatable: false,
      turn: 1,
      useId: 'u1',
      dupCalls,
    });
    const b = checkDupCall({
      name: 'read_file',
      input: { path: 'b.ts' },
      isRepeatable: false,
      turn: 2,
      useId: 'u2',
      dupCalls,
    });
    expect(a.kind).toBe('allow');
    expect(b.kind).toBe('allow');
    expect(dupCalls.size).toBe(2);
  });

  it('exempts polling-pattern tool names', () => {
    const dupCalls = fresh();
    const cases = ['mcp__list_pages', 'wait_for_build', 'task_status', 'poll_artifact'];
    for (const name of cases) {
      for (let i = 0; i < 10; i++) {
        const verdict = checkDupCall({
          name,
          input: { x: 1 },
          isRepeatable: false,
          turn: i,
          useId: `u${i}`,
          dupCalls,
        });
        expect(verdict.kind, name).toBe('allow');
      }
    }
    // Nothing was registered for polling tools.
    expect(dupCalls.size).toBe(0);
  });

  it('exempts CoderTool.repeatable=true', () => {
    const dupCalls = fresh();
    const verdicts: DupVerdict[] = [];
    for (let i = 0; i < 5; i++) {
      verdicts.push(
        checkDupCall({
          name: 'streaming_query',
          input: { q: 'same' },
          isRepeatable: true,
          turn: i,
          useId: `u${i}`,
          dupCalls,
        }),
      );
    }
    expect(verdicts.every((v) => v.kind === 'allow')).toBe(true);
    expect(dupCalls.size).toBe(0);
  });

  it('treats reordered object keys as the same call (stable args)', () => {
    const dupCalls = fresh();
    const v1 = checkDupCall({
      name: 'read_file',
      input: { path: 'x.ts', line: 5 },
      isRepeatable: false,
      turn: 1,
      useId: 'u1',
      dupCalls,
    });
    const v2 = checkDupCall({
      name: 'read_file',
      input: { line: 5, path: 'x.ts' },
      isRepeatable: false,
      turn: 2,
      useId: 'u2',
      dupCalls,
    });
    expect(v1.kind).toBe('allow');
    expect(v2.kind).toBe('allow-with-reminder');
  });
});

describe('resetDupCalls', () => {
  it('clears all entries', () => {
    const dupCalls = fresh();
    checkDupCall({ name: 'x', input: {}, isRepeatable: false, turn: 1, useId: 'u1', dupCalls });
    checkDupCall({ name: 'y', input: {}, isRepeatable: false, turn: 1, useId: 'u2', dupCalls });
    expect(dupCalls.size).toBe(2);
    resetDupCalls(dupCalls);
    expect(dupCalls.size).toBe(0);
  });
});
