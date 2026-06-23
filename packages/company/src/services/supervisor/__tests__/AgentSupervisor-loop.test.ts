/**
 * Insistent-loop backstop — `recordLoopEnforced` (fed by the runner's
 * `tool_loop_intervention { kind: 'loop-enforced' }` event) must surface a
 * `loop_enforced` incident every time, and abort the agent once the in-band
 * reminders clearly aren't landing (>= LOOP_ENFORCEMENT_ABORT_AFTER = 2).
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentSupervisor, type AgentSupervisorDeps } from '../index.js';
import { CompanyEventBus } from '../../CompanyEventBus.js';
import { SubordinateCompletionBus } from '../../subordinate/completion-events.js';

interface Incident {
  kind: string;
  agentRunId: number | null;
  detail: string;
}

function setup() {
  const incidents: Incident[] = [];
  const abort = vi.fn((_agentRunId: number, _reason?: string) => Promise.resolve());
  const resume = vi.fn((_agentRunId: number, _message?: string) => Promise.resolve());
  const deps: AgentSupervisorDeps = {
    companyEventBus: new CompanyEventBus(),
    completionBus: new SubordinateCompletionBus(),
    tickIntervalMs: 60_000,
    emitIncident: (i) => incidents.push(i as Incident),
    recoveryContext: { subordinates: { resume, abort } },
  };
  const sup = new AgentSupervisor(deps);
  sup.registerSubordinate({ agentRunId: 7, companySessionId: 100, role: 'backend' });
  return { sup, incidents, abort };
}

describe('AgentSupervisor — loop enforcement backstop', () => {
  it('emits a loop_enforced incident on the first enforcement, without aborting', () => {
    const { sup, incidents, abort } = setup();
    sup.recordLoopEnforced(7, 'update_todo');
    const loopIncidents = incidents.filter((i) => i.kind === 'loop_enforced');
    expect(loopIncidents).toHaveLength(1);
    expect(loopIncidents[0].agentRunId).toBe(7);
    expect(loopIncidents[0].detail).toContain('update_todo');
    expect(loopIncidents[0].detail).toContain('backend');
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts the agent once enforcement reminders survive the threshold', () => {
    const { sup, incidents, abort } = setup();
    sup.recordLoopEnforced(7, 'update_todo'); // #1 — no abort
    sup.recordLoopEnforced(7, 'update_todo'); // #2 — backstop fires
    expect(incidents.filter((i) => i.kind === 'loop_enforced')).toHaveLength(2);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0][0]).toBe(7);
  });

  it('counts per-agent (a different agent does not trip the backstop)', () => {
    const { sup, abort } = setup();
    sup.registerSubordinate({ agentRunId: 8, companySessionId: 100, role: 'frontend' });
    sup.recordLoopEnforced(7, 'update_todo');
    sup.recordLoopEnforced(8, 'read_file');
    expect(abort).not.toHaveBeenCalled();
  });
});
