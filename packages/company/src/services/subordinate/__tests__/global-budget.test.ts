/**
 * C2 — global subordinate budget semantics (pure module used by spawn.ts).
 * The COUNT is global cross-session; the CAP is the calling session's own
 * (resolved via `resolveAutonomy`): default 8, session int>0 overrides,
 * env '0' = uncapped, session null = back to default policy.
 */
import { describe, expect, it, vi } from 'vitest';
import { checkGlobalSubordinateBudget } from '../global-budget.js';
import { resolveAutonomy } from '../../autonomy/autonomy-config.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;
const sessionJson = (autonomy: Record<string, unknown>) => JSON.stringify({ autonomy });

describe('checkGlobalSubordinateBudget', () => {
  it('default cap is 8: refuses at 8 active, allows at 7', () => {
    const cap = resolveAutonomy(null, EMPTY_ENV).maxSubordinates;
    expect(cap).toBe(8);
    expect(checkGlobalSubordinateBudget({ cap, countActive: () => 7 }).ok).toBe(true);
    const refused = checkGlobalSubordinateBudget({ cap, countActive: () => 8 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toMatch(/8\/8 active across all company sessions/);
  });

  it('session override: each spawn checks the GLOBAL count against ITS OWN session cap', () => {
    // 8 agents active machine-wide. A default-cap session is refused...
    const defaultCap = resolveAutonomy(null, EMPTY_ENV).maxSubordinates;
    expect(checkGlobalSubordinateBudget({ cap: defaultCap, countActive: () => 8 }).ok).toBe(false);
    // ...while a session that raised its own cap to 12 may keep spawning.
    const raised = resolveAutonomy(sessionJson({ maxSubordinates: 12 }), EMPTY_ENV).maxSubordinates;
    expect(raised).toBe(12);
    expect(checkGlobalSubordinateBudget({ cap: raised, countActive: () => 8 }).ok).toBe(true);
    // A session may also LOWER its cap below the default.
    const lowered = resolveAutonomy(sessionJson({ maxSubordinates: 2 }), EMPTY_ENV).maxSubordinates;
    expect(checkGlobalSubordinateBudget({ cap: lowered, countActive: () => 2 }).ok).toBe(false);
  });

  it("env '0' = uncapped: always ok and the count is never even read", () => {
    const cap = resolveAutonomy(null, { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '0' }).maxSubordinates;
    expect(cap).toBeNull();
    const countActive = vi.fn(() => 1_000);
    expect(checkGlobalSubordinateBudget({ cap, countActive }).ok).toBe(true);
    expect(countActive).not.toHaveBeenCalled();
  });

  it('session null = back to default policy (8), NOT uncapped', () => {
    const cap = resolveAutonomy(sessionJson({ maxSubordinates: null }), EMPTY_ENV).maxSubordinates;
    expect(cap).toBe(8);
    expect(checkGlobalSubordinateBudget({ cap, countActive: () => 8 }).ok).toBe(false);
  });

  it('env int>0 overrides the default; session int overrides the env', () => {
    const envOnly = resolveAutonomy(null, { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '4' });
    expect(envOnly.maxSubordinates).toBe(4);
    expect(checkGlobalSubordinateBudget({ cap: envOnly.maxSubordinates, countActive: () => 4 }).ok)
      .toBe(false);
    const both = resolveAutonomy(
      sessionJson({ maxSubordinates: 6 }),
      { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '4' },
    );
    expect(both.maxSubordinates).toBe(6);
    expect(checkGlobalSubordinateBudget({ cap: both.maxSubordinates, countActive: () => 4 }).ok)
      .toBe(true);
  });
});
