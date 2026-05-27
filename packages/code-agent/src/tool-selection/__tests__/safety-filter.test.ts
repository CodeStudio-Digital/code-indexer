/**
 * Tests for A2 — Safety filter on tool selection.
 *
 * Locks in:
 *   - Secret-shaped content drops leaky tools (PowerShell, Bash, code_exec)
 *   - Plan-mode drops mutating tools
 *   - Offline-only drops network tools
 *   - No-flag context keeps all tools (backward compat)
 *   - Removed items carry reasons for diagnostics
 */
import { describe, expect, it } from 'vitest';
import { applyToolSelectionSafety } from '../safety-filter.js';
import type { ThinTool } from '../index.js';

function tool(name: string): ThinTool {
  return {
    name,
    description: `${name} tool description`,
    parameters: { type: 'object', properties: {} },
  };
}

const ALL_TOOLS: ThinTool[] = [
  tool('Read'),
  tool('Grep'),
  tool('Glob'),
  tool('PowerShell'),
  tool('Bash'),
  tool('write_file'),
  tool('edit_file'),
  tool('create_file'),
  tool('apply_patch'),
  tool('WebFetch'),
  tool('ext_github__create_issue'),
  tool('Read_file'), // capital prefix — should NOT match write_ prefix
];

describe('applyToolSelectionSafety', () => {
  it('with empty context keeps every tool', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {});
    expect(out.kept).toHaveLength(ALL_TOOLS.length);
    expect(out.removed).toHaveLength(0);
  });

  it('plan-mode drops mutating tools', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, { planMode: true });
    const droppedNames = out.removed.map((r) => r.tool.name);
    expect(droppedNames).toEqual(
      expect.arrayContaining(['write_file', 'edit_file', 'create_file', 'apply_patch']),
    );
    // Non-mutating tools survive
    expect(out.kept.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Read', 'Grep', 'Glob', 'PowerShell', 'Bash', 'WebFetch']),
    );
    // Diagnostic reason present
    for (const r of out.removed) {
      expect(r.reason).toContain('plan-mode');
    }
  });

  it('detects API-key-like patterns in recent file content', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      recentFileContents: [
        { path: 'config.ts', content: `const apiKey = "abcdefghij1234567890_XYZ"` },
      ],
    });
    const dropped = out.removed.map((r) => r.tool.name);
    expect(dropped).toEqual(expect.arrayContaining(['PowerShell', 'Bash']));
  });

  it('detects PEM private keys', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      recentFileContents: [
        { path: 'keys.pem', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIB...' },
      ],
    });
    const dropped = out.removed.map((r) => r.tool.name);
    expect(dropped).toContain('PowerShell');
  });

  it('detects bearer tokens', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      recentFileContents: [
        { path: 'curl.sh', content: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz"' },
      ],
    });
    expect(out.removed.some((r) => r.tool.name === 'Bash')).toBe(true);
  });

  it('OpenAI-style tokens are flagged', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      recentFileContents: [
        { path: '.env', content: 'OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      ],
    });
    expect(out.removed.some((r) => r.reason.includes('secret-shaped'))).toBe(true);
  });

  it('offline-only drops network tools', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, { offlineOnly: true });
    const droppedNames = out.removed.map((r) => r.tool.name);
    expect(droppedNames).toEqual(
      expect.arrayContaining(['WebFetch', 'ext_github__create_issue']),
    );
  });

  it('combines multiple signals: plan-mode + secrets visible', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      planMode: true,
      recentFileContents: [
        { path: '.env', content: 'apikey="abcdefghij1234567890XYZ"' },
      ],
    });
    const dropped = new Set(out.removed.map((r) => r.tool.name));
    // Plan-mode drops mutating; secrets drop leaky.
    expect(dropped.has('edit_file')).toBe(true);
    expect(dropped.has('PowerShell')).toBe(true);
  });

  it('does NOT match safe content', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, {
      recentFileContents: [
        { path: 'main.ts', content: `function add(a, b) { return a + b; }` },
      ],
    });
    expect(out.removed).toHaveLength(0);
  });

  it('removed items preserve the original tool reference (for diagnostics)', () => {
    const out = applyToolSelectionSafety(ALL_TOOLS, { planMode: true });
    const r = out.removed[0];
    expect(r.tool).toBe(ALL_TOOLS.find((t) => t.name === r.tool.name));
  });
});
