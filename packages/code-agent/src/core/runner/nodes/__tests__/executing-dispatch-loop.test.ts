/**
 * Insistent-loop enforcement — the tuple-hash guard refuses the 3rd identical
 * call, but the Planning node resets `dupCalls`, so a passive refusal alone
 * never breaks a loop that keeps coming back. The cross-cycle `loopRefusals`
 * counter (NOT reset by Planning) escalates to `loopEnforcement` after enough
 * refused cycles, which the Executing node turns into an active reminder.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { DupCallEntry } from '../../machine/types.js';
import { resetDupCalls } from '../../guards/tuple-hash-dedup.js';
import { dispatchTools, type DispatchArgs } from '../executing-dispatch.js';

function registryWith(name: string): ToolRegistry {
  const r = new ToolRegistry();
  const tool: CoderTool = {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
  };
  r.register(tool);
  return r;
}

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

/** One dispatch batch of `n` identical calls → drives dedup allow→reminder→refuse. */
function batch(
  registry: ToolRegistry,
  name: string,
  n: number,
  turn: number,
  dupCalls: Map<string, DupCallEntry>,
  loopRefusals: Map<string, number>,
): DispatchArgs {
  return {
    toolUses: Array.from({ length: n }, (_, i) => ({ id: `t${turn}-${i}`, name, input: { x: 1 } })),
    registry,
    toolContext,
    turn,
    dupCalls,
    loopRefusals,
  };
}

describe('dispatchTools — insistent-loop enforcement', () => {
  it('escalates to loopEnforcement after the 2nd refused planning cycle', async () => {
    const registry = registryWith('update_todo');
    const loopRefusals = new Map<string, number>();

    // Cycle 1: fresh dupCalls, 3 identical → 3rd refused → loopRefusals=1, no enforce yet.
    let dupCalls = new Map<string, DupCallEntry>();
    const r1 = await dispatchTools(batch(registry, 'update_todo', 3, 1, dupCalls, loopRefusals));
    expect(r1.toolLoopDetected).toBe(true);
    expect(r1.loopEnforcement).toBeUndefined();
    // A1 — the refusal carries the offending tool + count for Planning's reminder.
    expect(r1.loopDetail).toEqual({ toolName: 'update_todo', count: 3 });

    // Planning resets the dedup table — but NOT loopRefusals.
    resetDupCalls(dupCalls);
    expect(loopRefusals.get('update_todo|{"x":1}')).toBe(1);

    // Cycle 2: clean slate again, 3 identical → refused → loopRefusals=2 → ENFORCE.
    dupCalls = new Map<string, DupCallEntry>();
    const r2 = await dispatchTools(batch(registry, 'update_todo', 3, 2, dupCalls, loopRefusals));
    expect(r2.toolLoopDetected).toBe(true);
    expect(r2.loopEnforcement).toEqual({ toolName: 'update_todo', count: 2 });
  });

  it('does NOT enforce on a single refused cycle (legit retry)', async () => {
    const registry = registryWith('write_file');
    const loopRefusals = new Map<string, number>();
    const dupCalls = new Map<string, DupCallEntry>();
    const r = await dispatchTools(batch(registry, 'write_file', 3, 1, dupCalls, loopRefusals));
    expect(r.toolLoopDetected).toBe(true);
    expect(r.loopEnforcement).toBeUndefined();
  });
});
