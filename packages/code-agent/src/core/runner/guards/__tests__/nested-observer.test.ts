/**
 * Nested-call loop guards (code_exec). Before this observer, calls made
 * inside a code_exec script bypassed tuple-hash dedup AND failure-streak —
 * a script varied by one character could redo identical failing work
 * forever (real case: `task_complete` hammered from inside a script).
 *
 * Contract under test:
 *   - stable reads are never refused by historical/shared counters;
 *   - unsafe local repeats warn on #2 and block #3 in hybrid mode;
 *   - a tool whose failure streak already crossed the refuse threshold is
 *     refused on the FIRST nested attempt (pre-check);
 *   - a nested success clears the shared streak;
 *   - duplicate state is local while failure/no-progress state is shared;
 *   - observer methods never throw (telemetry sink failures are swallowed).
 */
import { describe, it, expect } from 'vitest';
import type { DupCallEntry } from '../../machine/types.js';
import type { FailureStreakState } from '../failure-streak.js';
import { NoProgressTracker } from '../no-progress.js';
import { ToolCallLedger } from '../../../tool-call-ledger.js';
import { nestedToolCallUseId } from '../../../tool.js';
import { buildNestedToolObserver, nestedGuardsEnabled } from '../nested-observer.js';

function deps(over?: Partial<Parameters<typeof buildNestedToolObserver>[0]>) {
  return {
    dupCalls: new Map<string, DupCallEntry>(),
    failureStreaks: { streaks: new Map() } as FailureStreakState,
    turn: 7,
    parentToolUseId: 'ce_parent_1',
    ...over,
  };
}

const afterArgs = (name: string, isError: boolean, preview = isError ? 'err' : 'ok') => ({
  invocationId: `ce_parent_1#fixture-${name}`,
  name,
  args: { x: 1 },
  isError,
  durationMs: 3,
  resultChars: preview.length,
  resultPreview: preview,
});

describe('nested invocation-local dedup', () => {
  it('never blocks stable reads, even when the legacy shared table is populated', () => {
    const d = deps({
      dupCalls: new Map([['read_file|legacy', { count: 99, firstTurn: 1, lastUseId: 'old' }]]),
    });
    const obs = buildNestedToolObserver(d);

    for (let i = 0; i < 5; i++) {
      expect(obs.beforeNestedCall('read_file', { path: 'a.ts' }, {
        repeatPolicy: 'stable', executionClass: 'read', stateEpoch: 0,
      })).toBeNull();
    }
    expect(d.dupCalls.get('read_file|legacy')?.count).toBe(99);
  });

  it('records repeated mutations as observations with a child attempt id', () => {
    const obs = buildNestedToolObserver(deps());
    const opts = { repeatPolicy: 'mutating' as const, executionClass: 'write' as const, stateEpoch: 0 };

    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)).toBeNull();
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)).toMatchObject({
      action: 'shadow', count: 2, shouldReflect: false,
    });
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)).toMatchObject({
      action: 'shadow', count: 3, originToolUseId: 'ce_parent_1#3', shouldReflect: false,
    });
  });

  it('uses the physical code_exec attempt id when earlier denials skipped guard accounting', () => {
    const obs = buildNestedToolObserver(deps());
    const base = { repeatPolicy: 'mutating' as const, executionClass: 'write' as const };

    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, {
      ...base, originToolUseId: 'ce_parent_1#2',
    })).toBeNull();
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, {
      ...base, originToolUseId: 'ce_parent_1#3',
    })?.action).toBe('shadow');
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, {
      ...base, originToolUseId: 'ce_parent_1#4',
    })).toMatchObject({ action: 'shadow', originToolUseId: 'ce_parent_1#4' });
  });

  it('different args never trip the dedup', () => {
    const obs = buildNestedToolObserver(deps());
    for (let i = 0; i < 5; i++) {
      expect(obs.beforeNestedCall('edit_file', { path: `f${i}.ts` }, {
        repeatPolicy: 'mutating', executionClass: 'write',
      })).toBeNull();
    }
  });

  it('pollable and volatile tools always execute', () => {
    const obs = buildNestedToolObserver(deps());
    for (let i = 0; i < 5; i++) {
      expect(obs.beforeNestedCall('check_status', { id: 1 }, {
        repeatPolicy: 'pollable', executionClass: 'read',
      })).toBeNull();
      expect(obs.beforeNestedCall('run_command', { command: 'status' }, {
        repeatPolicy: 'volatile', executionClass: 'execute',
      })).toBeNull();
    }
  });

  it('force_reread bypasses both duplicate and failure-streak pre-checks', () => {
    const obs = buildNestedToolObserver(deps({
      failureStreaks: {
        streaks: new Map([['read_file', {
          consecutive: 9, firstFailureTurn: 1, lastFailureTurn: 6, lastError: 'ENOENT',
        }]]),
      },
    }));
    expect(obs.beforeNestedCall('read_file', { path: 'a.ts', force_reread: true }, {
      repeatPolicy: 'stable', executionClass: 'read', forceReread: true,
    })).toBeNull();
  });

  it('a successful different mutation resets an earlier mutation counter', () => {
    const obs = buildNestedToolObserver(deps());
    const opts = { repeatPolicy: 'mutating' as const, executionClass: 'write' as const };
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)).toBeNull();
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)?.action).toBe('shadow');
    expect(obs.beforeNestedCall('write_file', { path: 'b.ts' }, opts)).toBeNull();
    obs.afterNestedCall({
      ...afterArgs('write_file', false), args: { path: 'b.ts' },
      repeatPolicy: 'mutating', executionClass: 'write',
    });
    expect(obs.beforeNestedCall('edit_file', { path: 'a.ts' }, opts)).toBeNull();
  });

});

describe('nested failure-streak (shared state, pre-check enforcement)', () => {
  it('observes an earlier failure streak without refusing a fresh attempt', () => {
    const d = deps({
      failureStreaks: {
        streaks: new Map([
          ['write_stdin', { consecutive: 5, firstFailureTurn: 2, lastFailureTurn: 6, lastError: 'EPIPE' }],
        ]),
      },
    });
    const obs = buildNestedToolObserver(d);
    const verdict = obs.beforeNestedCall('write_stdin', { data: 'x' });
    expect(verdict).not.toBeNull();
    expect(verdict).toMatchObject({ action: 'shadow', reason: 'failure-streak', shouldReflect: false });
  });

  it('nested failures feed the shared streak; one success clears it', () => {
    const d = deps();
    const obs = buildNestedToolObserver(d);

    obs.afterNestedCall(afterArgs('run_command', true));
    obs.afterNestedCall(afterArgs('run_command', true));
    expect(d.failureStreaks.streaks.get('run_command')?.consecutive).toBe(2);

    obs.afterNestedCall(afterArgs('run_command', false));
    expect(d.failureStreaks.streaks.has('run_command')).toBe(false);
  });

  it('below the threshold, attempts are allowed (enforcement is next-attempt)', () => {
    const d = deps();
    const obs = buildNestedToolObserver(d);
    obs.afterNestedCall(afterArgs('run_command', true));
    expect(obs.beforeNestedCall('run_command', { command: 'ls' })).toBeNull();
  });
});

describe('observer robustness + telemetry sink', () => {
  it('feeds settled nested results into the shared ledger guard', () => {
    const ledger = new ToolCallLedger();
    const obs = buildNestedToolObserver(deps({ toolCallLedger: ledger }));
    const opts = { repeatPolicy: 'stable' as const, executionClass: 'read' as const };
    for (let i = 0; i < 4; i++) {
      expect(obs.beforeNestedCall('search', { query: 'same' }, opts)).toBeNull();
      obs.afterNestedCall({
        ...afterArgs('search', false, 'unchanged'),
        args: { query: 'same' },
        ...opts,
      });
    }
    expect(obs.beforeNestedCall('search', { query: 'same' }, opts)).toMatchObject({
      action: 'shadow',
      reason: 'cross-turn-no-progress',
    });
  });

  it('does not double-record a nested result that already has ledger identity', () => {
    const ledger = new ToolCallLedger();
    const first = ledger.record({
      name: 'read_file',
      args: { path: 'src/a.ts' },
      content: 'source',
      isError: false,
    });
    const seen: Array<{ logicalOperationId?: string }> = [];
    const obs = buildNestedToolObserver(deps({
      toolCallLedger: ledger,
      onNestedCall: (entry) => seen.push(entry),
    }));

    obs.afterNestedCall({
      ...afterArgs('read_file', false, 'source'),
      args: { path: 'src/a.ts' },
      logicalOperationId: first.logicalOperationId,
      productive: first.productive,
      resultNovel: first.resultNovel,
      coverageNovel: first.coverageNovel,
    });

    expect(ledger.snapshot()).toHaveLength(1);
    expect(seen[0]?.logicalOperationId).toBe(first.logicalOperationId);
  });

  it('advances shared no-progress epoch only after a successful write/execute', () => {
    const tracker = new NoProgressTracker();
    const obs = buildNestedToolObserver(deps({ noProgressTracker: tracker }));
    obs.afterNestedCall({
      ...afterArgs('edit_file', true),
      repeatPolicy: 'mutating', executionClass: 'write',
    });
    expect(tracker.stateEpoch).toBe(0);
    obs.afterNestedCall({
      ...afterArgs('edit_file', false),
      repeatPolicy: 'mutating', executionClass: 'write',
    });
    expect(tracker.stateEpoch).toBe(1);
  });

  it('records every settled call with parent linkage and 1-based seq', () => {
    const seen: Array<{ seq: number; name: string; parentToolUseId: string; refusalKind?: string }> = [];
    const obs = buildNestedToolObserver(deps({ onNestedCall: (e) => seen.push(e) }));
    obs.afterNestedCall(afterArgs('read_file', false));
    obs.afterNestedCall(afterArgs('glob', true));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ seq: 1, name: 'read_file', parentToolUseId: 'ce_parent_1' });
    expect(seen[1]).toMatchObject({ seq: 2, name: 'glob' });
  });

  it('keeps invocation ids unique when a blocked sibling finishes first', () => {
    const seen: Parameters<typeof nestedToolCallUseId>[0][] = [];
    const obs = buildNestedToolObserver(deps({ onNestedCall: (e) => seen.push(e) }));

    obs.afterNestedCall({
      ...afterArgs('run_command', true, 'blocked'),
      invocationId: 'ce_parent_1#2',
      refusalKind: 'dedup',
      guardVerdict: {
        action: 'block',
        reason: 'cross-turn-no-progress',
        refusalKind: 'dedup',
        shouldReflect: true,
        affectsFailureStreak: false,
        originToolUseId: 'ce_parent_1#2',
      },
    });
    obs.afterNestedCall({
      ...afterArgs('run_command', true, 'slow failure'),
      invocationId: 'ce_parent_1#1',
    });

    const ids = seen.map(nestedToolCallUseId);
    expect(ids).toEqual(['ce_parent_1#2', 'ce_parent_1#1']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('caps the telemetry preview at 2000 chars', () => {
    const seen: Array<{ resultPreview: string }> = [];
    const obs = buildNestedToolObserver(deps({ onNestedCall: (e) => seen.push(e) }));
    obs.afterNestedCall(afterArgs('read_file', false, 'x'.repeat(10_000)));
    expect(seen[0].resultPreview).toHaveLength(2000);
  });

  it('a throwing telemetry sink never escapes into the caller', () => {
    const obs = buildNestedToolObserver(deps({
      onNestedCall: () => { throw new Error('sink exploded'); },
    }));
    expect(() => obs.afterNestedCall(afterArgs('read_file', false))).not.toThrow();
  });
});

describe('mandatory nested guards', () => {
  it('ignores the retired kill switch', () => {
    const prev = process.env.CODER_NESTED_GUARDS_DISABLE;
    try {
      delete process.env.CODER_NESTED_GUARDS_DISABLE;
      expect(nestedGuardsEnabled()).toBe(true);
      process.env.CODER_NESTED_GUARDS_DISABLE = '1';
      expect(nestedGuardsEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODER_NESTED_GUARDS_DISABLE;
      else process.env.CODER_NESTED_GUARDS_DISABLE = prev;
    }
  });
});
