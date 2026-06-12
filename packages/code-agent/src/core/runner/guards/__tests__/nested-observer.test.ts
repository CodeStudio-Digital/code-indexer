/**
 * Nested-call loop guards (code_exec). Before this observer, calls made
 * inside a code_exec script bypassed tuple-hash dedup AND failure-streak —
 * a script varied by one character could redo identical failing work
 * forever (real case: `task_complete` hammered from inside a script).
 *
 * Contract under test:
 *   - 3rd identical nested call → dedup refuse (catchable, kind='dedup');
 *   - 'allow-with-reminder' (2nd call) → plain allow (scripts parse output);
 *   - a tool whose failure streak already crossed the refuse threshold is
 *     refused on the FIRST nested attempt (pre-check);
 *   - a nested success clears the shared streak;
 *   - guard state is SHARED maps — what nested calls do is visible to
 *     top-level dispatch and vice-versa;
 *   - observer methods never throw (telemetry sink failures are swallowed).
 */
import { describe, it, expect } from 'vitest';
import type { DupCallEntry } from '../../machine/types.js';
import type { FailureStreakState } from '../failure-streak.js';
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
  name,
  args: { x: 1 },
  isError,
  durationMs: 3,
  resultChars: preview.length,
  resultPreview: preview,
});

describe('nested dedup (tuple-hash over the shared table)', () => {
  it('allows twice (reminder suppressed), refuses the 3rd identical call', () => {
    const d = deps();
    const obs = buildNestedToolObserver(d);

    expect(obs.beforeNestedCall('read_file', { path: 'a.ts' })).toBeNull();
    // 2nd identical → top level would prepend a reminder; nested treats it
    // as a plain allow because scripts parse the raw output.
    expect(obs.beforeNestedCall('read_file', { path: 'a.ts' })).toBeNull();

    const third = obs.beforeNestedCall('read_file', { path: 'a.ts' });
    expect(third).not.toBeNull();
    expect(third!.kind).toBe('dedup');
    expect(third!.refusalText).toContain('[loop-refused');
  });

  it('different args never trip the dedup', () => {
    const obs = buildNestedToolObserver(deps());
    for (let i = 0; i < 5; i++) {
      expect(obs.beforeNestedCall('read_file', { path: `f${i}.ts` })).toBeNull();
    }
  });

  it('repeatable tools are exempt', () => {
    const obs = buildNestedToolObserver(deps());
    for (let i = 0; i < 5; i++) {
      expect(obs.beforeNestedCall('check_status', { id: 1 }, { repeatable: true })).toBeNull();
    }
  });
});

describe('nested failure-streak (shared state, pre-check enforcement)', () => {
  it('refuses the FIRST nested attempt when the streak already crossed the threshold', () => {
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
    expect(verdict!.kind).toBe('failure-streak');
    expect(verdict!.refusalText).toContain('[failure-streak REFUSED');
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
  it('records every settled call with parent linkage and 1-based seq', () => {
    const seen: Array<{ seq: number; name: string; parentToolUseId: string; refusalKind?: string }> = [];
    const obs = buildNestedToolObserver(deps({ onNestedCall: (e) => seen.push(e) }));
    obs.afterNestedCall(afterArgs('read_file', false));
    obs.afterNestedCall(afterArgs('glob', true));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ seq: 1, name: 'read_file', parentToolUseId: 'ce_parent_1' });
    expect(seen[1]).toMatchObject({ seq: 2, name: 'glob' });
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

describe('kill switch', () => {
  it('CODER_NESTED_GUARDS_DISABLE=1 turns the factory gate off', () => {
    const prev = process.env.CODER_NESTED_GUARDS_DISABLE;
    try {
      delete process.env.CODER_NESTED_GUARDS_DISABLE;
      expect(nestedGuardsEnabled()).toBe(true);
      process.env.CODER_NESTED_GUARDS_DISABLE = '1';
      expect(nestedGuardsEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODER_NESTED_GUARDS_DISABLE;
      else process.env.CODER_NESTED_GUARDS_DISABLE = prev;
    }
  });
});
