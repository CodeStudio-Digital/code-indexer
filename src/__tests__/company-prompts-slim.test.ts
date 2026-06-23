/**
 * Phase F prompt-length caps.
 *
 * The master / subordinate company prompts used to balloon every time a
 * tool grew a new edge case — `system-prompts.ts` peaked at ~770 lines
 * with ~330 of those just describing what the tools already document.
 * Phase F slimmed both blocks to lean role descriptions; this test
 * pins the win so a future addition has to acknowledge the cost.
 *
 * Caps are deliberately generous: the slim master block is currently
 * ~5500 chars and the subordinate ~2500. We allow ~30% headroom so a
 * legitimate new section (e.g. a brand-new tool surface) can land
 * without breaking the suite — but doubling the prompt requires a
 * conscious cap bump, which is the prompt-bloat signal we want.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMasterCompanyBlock,
  buildSubordinateCompanyBlock,
} from '@mcp/company/system-prompts.js';
import { readOperationalRules } from '@mcp/company/services/master/config-loader.js';

const MASTER_CAP_CHARS = 8000;
const SUBORDINATE_CAP_CHARS = 4500;

describe('company prompt size caps (Phase F)', () => {
  it('master prompt stays under the slim-budget cap', () => {
    const block = buildMasterCompanyBlock({
      roster: [
        { role: 'master', provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'full' },
        { role: 'backend', provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'navigate' },
        { role: 'frontend', provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'navigate' },
      ],
      projects: [
        { id: 1, name: 'demo', rootPath: '/tmp/demo' },
      ],
    });
    expect(block.length).toBeLessThan(MASTER_CAP_CHARS);
    // Spot-check the prompt still teaches the invariants that matter:
    // orchestration role, board as voice, project-first delegation.
    expect(block).toMatch(/post_to_board/);
    expect(block).toMatch(/spawn_subordinate_agent/);
    expect(block).toMatch(/ask_user/);
  });

  it('subordinate prompt stays under the slim-budget cap', () => {
    const block = buildSubordinateCompanyBlock({
      role: 'backend',
      projects: [{ id: 1, name: 'demo', rootPath: '/tmp/demo' }],
    });
    expect(block.length).toBeLessThan(SUBORDINATE_CAP_CHARS);
    // Spot-check: deliverable mandate, master-directed tools surface.
    expect(block).toMatch(/post_to_board\(kind="deliverable"/);
    expect(block).toMatch(/ask_master/);
    expect(block).toMatch(/send_to_master/);
  });
});

describe('operational rules injection', () => {
  // A distinctive marker that would never appear in the base prompt, so a
  // match proves the operator's text reached the assembled block verbatim.
  const SENTINEL = 'NUNCA normalizar enum do backend — SENTINELA-OPS-7F3';

  it('injects the operational rules verbatim into the master prompt', () => {
    const block = buildMasterCompanyBlock({
      roster: [{ role: 'backend', provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'navigate' }],
      projects: [{ id: 1, name: 'demo', rootPath: '/tmp/demo' }],
      operationalRules: SENTINEL,
    });
    expect(block).toContain(SENTINEL);
    // The master is told to ENFORCE, not relay — the behavioral unlock that
    // stops the lossy re-transmission of rules into every delegated task.
    expect(block).toMatch(/OPERATIONAL RULES \(MANDATORY/);
    expect(block).toMatch(/do NOT copy them into the/i);
  });

  it('injects the SAME rules verbatim into every subordinate prompt', () => {
    const block = buildSubordinateCompanyBlock({
      role: 'backend',
      projects: [{ id: 1, name: 'demo', rootPath: '/tmp/demo' }],
      operationalRules: SENTINEL,
    });
    expect(block).toContain(SENTINEL);
    expect(block).toMatch(/OPERATIONAL RULES \(MANDATORY\)/);
  });

  it('renders no rules section when operationalRules is absent (legacy shape)', () => {
    const master = buildMasterCompanyBlock({
      roster: [{ role: 'backend', provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'navigate' }],
      projects: [{ id: 1, name: 'demo', rootPath: '/tmp/demo' }],
    });
    const sub = buildSubordinateCompanyBlock({
      role: 'backend',
      projects: [{ id: 1, name: 'demo', rootPath: '/tmp/demo' }],
    });
    expect(master).not.toMatch(/OPERATIONAL RULES/);
    expect(sub).not.toMatch(/OPERATIONAL RULES/);
  });
});

describe('readOperationalRules (config_json parse)', () => {
  it('returns the trimmed rules when present', () => {
    const cfg = JSON.stringify({ operational_rules: '  validate contracts  ', master_model: 'x' });
    expect(readOperationalRules(cfg)).toBe('validate contracts');
  });

  it('returns undefined for missing / blank / non-string / null / malformed', () => {
    expect(readOperationalRules(null)).toBeUndefined();
    expect(readOperationalRules(undefined)).toBeUndefined();
    expect(readOperationalRules('{}')).toBeUndefined();
    expect(readOperationalRules(JSON.stringify({ operational_rules: '   ' }))).toBeUndefined();
    expect(readOperationalRules(JSON.stringify({ operational_rules: 42 }))).toBeUndefined();
    expect(readOperationalRules('not json{')).toBeUndefined();
  });

  it('passes normal-size docs untouched but caps pathological payloads', () => {
    const normal = 'a'.repeat(8000); // ~the user's 8.8KB canonical doc
    expect(readOperationalRules(JSON.stringify({ operational_rules: normal }))).toBe(normal);

    const huge = 'b'.repeat(20000);
    const out = readOperationalRules(JSON.stringify({ operational_rules: huge }))!;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toMatch(/truncated/);
  });
});
