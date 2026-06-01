/**
 * Regression — `wait_for_subordinates` must (a) never report a *false* failure
 * when its own internal deadline elapses while subordinates still run, and
 * (b) call out failed subordinates with their recovery action so they don't
 * hide inside a flat status list.
 *
 * The root bug was orthogonal (the runner's 5-min NORMAL timeout killed the
 * wait — fixed via `repeatable: true`, covered by dispatch-timeout.test.ts).
 * This file pins the tool's OWN return-shape contract.
 */
import { describe, it, expect } from 'vitest';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { buildMasterTools, summarizeSubordinates } from '@mcp/company/tools/master-tools.js';

type SubInfo = { agentRunId: number; role: string; status: string };

/** Minimal orchestrator stub: a Proxy so `buildMasterTools` can construct every
 *  sibling tool, while we control only the three methods the wait handler uses. */
function fakeOrchestrator(overrides: Partial<Record<string, unknown>>): CompanyOrchestrator {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop];
        return () => undefined;
      },
    },
  ) as unknown as CompanyOrchestrator;
}

function waitTool(orch: CompanyOrchestrator) {
  const tool = buildMasterTools(orch).find((t) => t.name === 'wait_for_subordinates');
  if (!tool) throw new Error('wait_for_subordinates not built');
  return tool;
}

describe('wait_for_subordinates — return-shape contract', () => {
  it('is exempt from the runner timeout (repeatable)', () => {
    expect(waitTool(fakeOrchestrator({})).repeatable).toBe(true);
  });

  it('returns a soft continuation (NOT an error) when its own deadline elapses', async () => {
    const orch = fakeOrchestrator({
      hasRunningSubordinates: () => true,
      listSubordinates: (): SubInfo[] => [{ agentRunId: 1, role: 'backend', status: 'running' }],
      // Never fires — forces the internal setTimeout path to win.
      onSubordinateAttention: () => () => undefined,
    });
    // timeout_minutes is a fraction → internal deadline elapses in ~milliseconds.
    const res = await waitTool(orch).handler({ timeout_minutes: 0.001 }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('not a failure');
    expect(res.content).toContain('backend');
  });

  it('early-returns cleanly when nothing is running', async () => {
    const res = await waitTool(fakeOrchestrator({ hasRunningSubordinates: () => false })).handler(
      {},
      {} as never,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('all done');
  });
});

describe('summarizeSubordinates — failed runs surface a recovery hint', () => {
  it('flags failed statuses with resume/abort guidance and counts them', () => {
    const orch = fakeOrchestrator({
      listSubordinates: (): SubInfo[] => [
        { agentRunId: 1, role: 'frontend', status: 'completed' },
        { agentRunId: 2, role: 'backend', status: 'error' },
        { agentRunId: 3, role: 'qa', status: 'aborted' },
      ],
    });
    const out = summarizeSubordinates(orch);
    expect(out).toContain('2 subordinate(s) ended in a failed state');
    expect(out).toContain('resume_subordinate');
    expect(out).toContain('abort_subordinate_agent');
    // Clean runs carry no hint.
    expect(out).toMatch(/frontend \(run=1\): completed$/m);
  });

  it('uses the all-done header when every run is clean', () => {
    const orch = fakeOrchestrator({
      listSubordinates: (): SubInfo[] => [{ agentRunId: 1, role: 'frontend', status: 'completed' }],
    });
    expect(summarizeSubordinates(orch)).toContain('All subordinates finished:');
  });
});
