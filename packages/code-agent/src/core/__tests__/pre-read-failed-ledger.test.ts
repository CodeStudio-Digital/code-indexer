/**
 * Pre-read ledger honesty for the authoritative observation-only policy.
 * Failed reads must disappear from the ledger; successful and repeated reads
 * remain observable, but historical presence never becomes a refusal.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { CoderRunner } from '../runner.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = CoderRunner.prototype as any;

interface FakeRunner {
  opts: { agentLoopV2: boolean; toolContext: { cwd: string } };
  recentReadKeys: Map<string, Array<{ turn: number; useId: string }>>;
  recentWrites: Map<string, number>;
  pendingDiffRereads: Map<string, unknown>;
  messages: AgentMessage[];
  setTransition: (transition: string) => void;
  dropFailedReadFromLedger: (
    name: string,
    input: Record<string, unknown>,
    useId: string,
  ) => void;
}

function fakeRunner(messages: AgentMessage[] = []): FakeRunner {
  return {
    opts: { agentLoopV2: true, toolContext: { cwd: process.cwd() } },
    recentReadKeys: new Map(),
    recentWrites: new Map(),
    pendingDiffRereads: new Map(),
    messages,
    setTransition: () => {},
    dropFailedReadFromLedger: proto.dropFailedReadFromLedger,
  };
}

function enforce(runner: FakeRunner, useId: string, turn: number): unknown {
  return proto.enforcePreReadForBridge.call(
    runner,
    'read_file',
    { path: 'docs/a.md' },
    turn,
    useId,
  );
}

function postProcess(runner: FakeRunner, useId: string, isError: boolean): unknown {
  const content = isError ? 'path is required and cannot be empty' : 'line1\nline2';
  return proto.postProcessToolResultForBridge.call(runner, {
    toolUseId: useId,
    name: 'read_file',
    input: { path: 'docs/a.md' },
    rawContent: content,
    content,
    isError,
    turn: 0,
  });
}

function ledger(runner: FakeRunner): Array<{ turn: number; useId: string }> {
  return [...runner.recentReadKeys.values()].flat();
}

describe('pre-read observation ledger', () => {
  it('drops a failed read so the retry is the first effective read', () => {
    const runner = fakeRunner();
    expect(enforce(runner, 'use1', 1)).toBeNull();
    expect(ledger(runner).map((entry) => entry.useId)).toEqual(['use1']);

    postProcess(runner, 'use1', true);
    expect(ledger(runner)).toEqual([]);
    expect(enforce(runner, 'use2', 2)).toBeNull();
  });

  it('keeps successful and repeated reads without refusing them', () => {
    const runner = fakeRunner();
    expect(enforce(runner, 'use1', 1)).toBeNull();
    postProcess(runner, 'use1', false);
    expect(enforce(runner, 'use2', 2)).toBeNull();
    expect(enforce(runner, 'use3', 3)).toBeNull();
    expect(ledger(runner).map((entry) => entry.useId)).toEqual([
      'use1',
      'use2',
      'use3',
    ]);
  });
});
