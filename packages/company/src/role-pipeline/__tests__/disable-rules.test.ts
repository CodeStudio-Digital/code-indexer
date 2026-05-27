/**
 * Tests for C2 — SubordinateDisableRule + DisableRulesFilter.
 *
 * Locks in:
 *   - Pre-built rule semantics (skipIfRolesSkipped/Failed/AlreadyRunning)
 *   - evaluateDisableRules short-circuits on first match
 *   - DisableRulesFilter integration with the role pipeline
 *   - Backward compat: roles without disableRules behave as before
 */
import { describe, expect, it } from 'vitest';
import {
  DisableRulesFilter,
  emptyDisableContext,
  evaluateDisableRules,
  skipIfAnyRoleFailed,
  skipIfRoleAlreadyRunning,
  skipIfRolesSkipped,
  type RoleCandidate,
  type RoleDescriptor,
  type RolePipelineQuery,
  type SubordinateDisableContext,
} from '../index.js';

function role(name: string, rules?: ReturnType<typeof skipIfRolesSkipped>[]): RoleDescriptor {
  return { role: name, description: `${name} role`, disableRules: rules };
}

function spawnCandidate(role: RoleDescriptor): RoleCandidate {
  return {
    candidateId: `spawn::${role.role}`,
    kind: 'spawn',
    role,
    signals: {},
    score: 0,
  };
}

function makeQuery(
  roles: RoleDescriptor[],
  partial: Partial<SubordinateDisableContext> = {},
): RolePipelineQuery {
  return {
    queryId: 'q1',
    taskText: 'some task',
    availableRoles: roles,
    disableContext: { ...emptyDisableContext('some task'), ...partial },
  };
}

describe('skipIfRolesSkipped', () => {
  it('does not disable when no upstream was skipped', () => {
    const rule = skipIfRolesSkipped(['frontend']);
    const ctx = emptyDisableContext();
    expect(rule.shouldDisable(ctx)).toBe(false);
  });

  it('disables when a named upstream was skipped', () => {
    const rule = skipIfRolesSkipped(['frontend']);
    const ctx: SubordinateDisableContext = {
      ...emptyDisableContext(),
      skippedRoles: new Set(['frontend']),
    };
    expect(rule.shouldDisable(ctx)).toBe(true);
    expect(rule.reason(ctx)).toContain('frontend');
  });

  it('matches if ANY upstream role from the list was skipped', () => {
    const rule = skipIfRolesSkipped(['frontend', 'backend']);
    const ctx: SubordinateDisableContext = {
      ...emptyDisableContext(),
      skippedRoles: new Set(['backend']),
    };
    expect(rule.shouldDisable(ctx)).toBe(true);
  });
});

describe('skipIfAnyRoleFailed', () => {
  it('disables on failed upstream', () => {
    const rule = skipIfAnyRoleFailed(['build']);
    const ctx: SubordinateDisableContext = {
      ...emptyDisableContext(),
      failedRoles: new Set(['build']),
    };
    expect(rule.shouldDisable(ctx)).toBe(true);
  });

  it('does not disable when failedRoles is empty', () => {
    const rule = skipIfAnyRoleFailed(['build']);
    expect(rule.shouldDisable(emptyDisableContext())).toBe(false);
  });
});

describe('skipIfRoleAlreadyRunning', () => {
  it('disables when the role is already running', () => {
    const rule = skipIfRoleAlreadyRunning('architect');
    const ctx: SubordinateDisableContext = {
      ...emptyDisableContext(),
      runningRoles: new Set(['architect']),
    };
    expect(rule.shouldDisable(ctx)).toBe(true);
  });

  it('passes when the role is not running', () => {
    const rule = skipIfRoleAlreadyRunning('architect');
    expect(rule.shouldDisable(emptyDisableContext())).toBe(false);
  });
});

describe('evaluateDisableRules', () => {
  it('returns { disabled: false } when no rules', () => {
    expect(evaluateDisableRules(undefined, emptyDisableContext())).toEqual({ disabled: false });
    expect(evaluateDisableRules([], emptyDisableContext())).toEqual({ disabled: false });
  });

  it('short-circuits on the first matching rule', () => {
    const first = skipIfRolesSkipped(['a']);
    const second = skipIfRolesSkipped(['b']);
    const ctx: SubordinateDisableContext = {
      ...emptyDisableContext(),
      skippedRoles: new Set(['a', 'b']),
    };
    const result = evaluateDisableRules([first, second], ctx);
    expect(result.disabled).toBe(true);
    expect(result.ruleName).toBe(first.name);
  });

  it('falls through when no rule matches', () => {
    const rule = skipIfRolesSkipped(['unrelated']);
    const result = evaluateDisableRules([rule], emptyDisableContext());
    expect(result.disabled).toBe(false);
  });
});

describe('DisableRulesFilter', () => {
  const filter = new DisableRulesFilter();

  it('enable() is false when no role declares rules — pure backward compat', () => {
    const query = makeQuery([role('a'), role('b')]);
    expect(filter.enable(query)).toBe(false);
  });

  it('enable() is true when at least one role declares rules', () => {
    const query = makeQuery([role('a'), role('b', [skipIfRolesSkipped(['x'])])]);
    expect(filter.enable(query)).toBe(true);
  });

  it('drops candidates whose rules match', () => {
    const qa = role('qa', [skipIfRolesSkipped(['frontend'])]);
    const backend = role('backend');
    const query = makeQuery([qa, backend], { skippedRoles: new Set(['frontend']) });
    const candidates = [spawnCandidate(qa), spawnCandidate(backend)];
    const result = filter.filter(query, candidates);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].role.role).toBe('backend');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].role.role).toBe('qa');
    // Diagnostic surfaces on the dropped candidate.
    expect(result.removed[0].signals.disabledByRule).toBe(1);
    expect(result.removed[0].signals.disableRuleName).toContain('skipIfRolesSkipped');
    expect(result.removed[0].signals.disableReason).toContain('frontend');
  });

  it('keeps a role whose rules do not match (matching context absent)', () => {
    const qa = role('qa', [skipIfRolesSkipped(['frontend'])]);
    const query = makeQuery([qa]); // no skippedRoles
    const result = filter.filter(query, [spawnCandidate(qa)]);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
  });

  it('treats missing disableContext as empty (no rule fires)', () => {
    const qa = role('qa', [skipIfRolesSkipped(['frontend'])]);
    const query: RolePipelineQuery = {
      queryId: 'q1',
      taskText: 'task',
      availableRoles: [qa],
      // disableContext intentionally omitted
    };
    const result = filter.filter(query, [spawnCandidate(qa)]);
    expect(result.kept).toHaveLength(1);
    expect(result.removed).toHaveLength(0);
  });

  it('multiple rules — first match wins', () => {
    const rules = [
      skipIfRolesSkipped(['frontend']),
      skipIfAnyRoleFailed(['build']),
    ];
    const r = role('qa', rules);
    const query = makeQuery([r], {
      skippedRoles: new Set(['frontend']),
      failedRoles: new Set(['build']),
    });
    const result = filter.filter(query, [spawnCandidate(r)]);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].signals.disableRuleName).toContain('skipIfRolesSkipped');
    // skipIfAnyRoleFailed was never asked because skipIfRolesSkipped won.
  });
});
