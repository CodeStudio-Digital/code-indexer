/**
 * Pre-read guard honesty (telemetry case, sessão 09-10/jun):
 *
 *   1. read_file failed twice ("path is required") and the guard then
 *      REFUSED the working retry claiming "Content is already in your
 *      context above" — but the content never arrived. Failed reads must
 *      not count as prior reads.
 *   2. Refused attempts themselves were ledgered as reads, so refusals
 *      compounded.
 *   3. The refusal asserted "in your context" even when the prior read's
 *      tool_result had been elided/compacted away.
 *
 * The bridge methods are private on CoderRunner; we invoke them off the
 * prototype with a minimal fake `this` (the same surface the methods read).
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { CoderRunner } from '../runner.js';
import { buildRichRefusal } from '../compaction/refusal.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = CoderRunner.prototype as any;

interface FakeRunner {
  opts: { agentLoopV2: boolean; toolContext: { cwd: string } };
  recentReadKeys: Map<string, Array<{ turn: number; useId: string }>>;
  recentWrites: Map<string, number>;
  pendingDiffRereads: Map<string, unknown>;
  messages: AgentMessage[];
  setTransition: (t: string) => void;
  dropFailedReadFromLedger: (name: string, input: Record<string, unknown>, useId: string) => void;
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

const enforce = (r: FakeRunner, useId: string, turn: number, path = 'docs/a.md'): unknown =>
  proto.enforcePreReadForBridge.call(r, 'read_file', { path }, turn, useId);

const postProcess = (r: FakeRunner, useId: string, isError: boolean, path = 'docs/a.md'): unknown =>
  proto.postProcessToolResultForBridge.call(r, {
    toolUseId: useId,
    name: 'read_file',
    input: { path },
    rawContent: isError ? 'path is required and cannot be empty' : 'line1\nline2',
    content: isError ? 'path is required and cannot be empty' : 'line1\nline2',
    isError,
    turn: 0,
  });

const toolResultMsg = (useId: string, content = 'line1\nline2\nline3'): AgentMessage =>
  ({
    role: 'tool',
    content: [{ type: 'tool_result', tool_use_id: useId, content }],
  }) as unknown as AgentMessage;

const ledger = (r: FakeRunner): Array<{ turn: number; useId: string }> =>
  [...r.recentReadKeys.values()].flat();

describe('failed reads are dropped from the pre-read ledger', () => {
  it('a FAILED read does not count toward the re-read threshold', () => {
    const r = fakeRunner();
    expect(enforce(r, 'use1', 1)).toBeNull(); // optimistically ledgered
    expect(ledger(r).map((e) => e.useId)).toEqual(['use1']);

    postProcess(r, 'use1', true); // the read FAILED → entry removed
    expect(ledger(r)).toEqual([]);

    // The retry is the FIRST real read — must be allowed, not refused.
    expect(enforce(r, 'use2', 2)).toBeNull();
  });

  it('successful reads keep their entry (threshold still enforces)', () => {
    const r = fakeRunner([toolResultMsg('use1')]);
    expect(enforce(r, 'use1', 1)).toBeNull();
    postProcess(r, 'use1', false); // success → entry stays
    const second = enforce(r, 'use2', 2);
    expect(typeof second).toBe('string'); // default threshold 2 → refuse
    expect(String(second)).toContain('Refused:');
  });
});

describe('refused attempts do not compound in the ledger', () => {
  it('back-to-back refusals keep reporting the SAME prior-read count', () => {
    const r = fakeRunner([toolResultMsg('use1')]);
    expect(enforce(r, 'use1', 1)).toBeNull();

    const first = String(enforce(r, 'use2', 2));
    expect(first).toContain('called 1 time for');
    expect(ledger(r).map((e) => e.useId)).toEqual(['use1']); // use2 was popped

    const second = String(enforce(r, 'use3', 3));
    expect(second).toContain('called 1 time for'); // NOT "2 times"
    expect(ledger(r).map((e) => e.useId)).toEqual(['use1']);
  });
});

describe('refusal wording is honest about what is still in context', () => {
  it('claims "in your context" only when the prior tool_result is present', () => {
    const r = fakeRunner([toolResultMsg('use1')]);
    enforce(r, 'use1', 1);
    const refusal = String(enforce(r, 'use2', 2));
    expect(refusal).toContain('Content is already in your context above');
  });

  it('falls back to the force_reread pointer when the FIRST prior read was elided', () => {
    const prev = process.env.CODER_READ_DUP_THRESHOLD;
    try {
      process.env.CODER_READ_DUP_THRESHOLD = '3';
      // use2's result is still in context; use1's was compacted away. The
      // all-elided escape hatch doesn't apply (use2 is present), but the
      // preview comes from the FIRST prior (use1) — absent → honest wording.
      const r = fakeRunner([toolResultMsg('use2')]);
      enforce(r, 'use1', 1);
      enforce(r, 'use2', 2);
      const refusal = String(enforce(r, 'use3', 3));
      expect(refusal).toContain('Refused:');
      expect(refusal).not.toContain('Content is already in your context above');
      expect(refusal).toContain('may have been compacted out of your context');
    } finally {
      if (prev === undefined) delete process.env.CODER_READ_DUP_THRESHOLD;
      else process.env.CODER_READ_DUP_THRESHOLD = prev;
    }
  });
});

describe('buildRichRefusal — pure wording contract (prefix-cache stable)', () => {
  const base = {
    toolName: 'read_file',
    path: 'src/a.ts',
    prior: [{ turn: 3, useId: 'u1' }],
    windowTurns: 20,
  };

  it('renders the in-context wording when a preview exists', () => {
    const s = buildRichRefusal({
      ...base,
      contextPreview: { headLines: ['a'], tailLines: ['b'], totalLines: 10 },
    });
    expect(s).toBe(
      'Refused: `read_file` called 1 time for `src/a.ts` in last 20 turns (turn 3). ' +
        'Content is already in your context above — quote it and act on it, ' +
        'or pass `force_reread: true` if the file genuinely changed since the first read.',
    );
  });

  it('renders the compacted wording when no preview exists', () => {
    const s = buildRichRefusal(base);
    expect(s).toBe(
      'Refused: `read_file` called 1 time for `src/a.ts` in last 20 turns (turn 3). ' +
        'The prior read may have been compacted out of your context — if you genuinely ' +
        'need the content again, pass `force_reread: true`; otherwise act on what you have.',
    );
  });
});
