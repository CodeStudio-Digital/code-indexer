import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStageGate, type StageGateInput } from '../pipeline/gates.js';
import { createPipelineState } from '../pipeline/stages.js';
import { buildRoadmap, ROADMAP_PRIMITIVES } from '../pipeline/roadmap.js';

let dir: string | null = null;

function makeWorkspace(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'ds-gates-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function input(partial: Partial<StageGateInput> & Pick<StageGateInput, 'stage' | 'workspaceDir'>): StageGateInput {
  return {
    mode: 'creative',
    state: createPipelineState(buildRoadmap({ mode: 'creative' }), null),
    recorded: [],
    ...partial,
  };
}

const TOKENS_OK = Array.from({ length: 30 }, (_, i) => `  --token-${i}: ${i}px;`).join('\n');

describe('analysis gate', () => {
  it('fails without DESIGN_BRIEF.md and passes with a substantial one', () => {
    const ws = makeWorkspace({});
    expect(runStageGate(input({ stage: 'analysis', workspaceDir: ws })).ok).toBe(false);

    writeFileSync(join(ws, 'DESIGN_BRIEF.md'), 'x'.repeat(900), 'utf8');
    expect(runStageGate(input({ stage: 'analysis', workspaceDir: ws })).ok).toBe(true);
  });

  it('flags a too-thin brief', () => {
    const ws = makeWorkspace({ 'DESIGN_BRIEF.md': 'short' });
    const gate = runStageGate(input({ stage: 'analysis', workspaceDir: ws }));
    expect(gate.ok).toBe(false);
    expect(gate.issues[0]).toContain('800');
  });
});

describe('tokens gate', () => {
  it('requires tokens.css with enough variables and no raw hex in components', () => {
    const ws = makeWorkspace({
      'pkg/src/tokens.css': `:root{\n${TOKENS_OK}\n}`,
      'pkg/src/components/Button.tsx': 'export const B = () => <button style={{color: "#ff0000"}} />;',
    });
    const gate = runStageGate(input({ stage: 'tokens', workspaceDir: ws }));
    expect(gate.ok).toBe(false);
    expect(gate.issues.join('\n')).toContain('Button.tsx');
  });

  it('fidelity requires the digest top colors verbatim in tokens.css', () => {
    const digest = {
      digest_version: 1,
      generated_at: 'x',
      totals: { files: 1, pages: 1, stylesheets: 1, components: 0 },
      tokens: { colors: [{ hex: '#1a73e8', count: 9, roles: ['button'] }], fonts: [], font_sizes: [], font_weights: [], radii: [], shadows: [], spacing: { base_px: null, values: [] }, breakpoints: [], css_variables: {} },
      components: [],
      pages: [],
      dependencies: { css_frameworks: [], icon_fonts: [], js_libs: [], fonts: [] },
      warnings: [],
    };
    const ws = makeWorkspace({
      'pkg/src/tokens.css': `:root{\n${TOKENS_OK}\n}`,
      'import/_analysis/theme-digest.json': JSON.stringify(digest),
    });
    const fail = runStageGate(input({ stage: 'tokens', workspaceDir: ws, mode: 'fidelity' }));
    expect(fail.ok).toBe(false);
    expect(fail.issues.join('\n')).toContain('#1a73e8');

    writeFileSync(join(ws, 'pkg/src/tokens.css'), `:root{\n--color-primary: #1a73e8;\n${TOKENS_OK}\n}`, 'utf8');
    expect(runStageGate(input({ stage: 'tokens', workspaceDir: ws, mode: 'fidelity' })).ok).toBe(true);
  });
});

describe('tier coverage gates', () => {
  it('primitives require 90% of the tier recorded and name the missing ones', () => {
    const ws = makeWorkspace({});
    const most = ROADMAP_PRIMITIVES.slice(1).map((name) => ({ name, kind: 'atom' }));
    const gate = runStageGate(input({ stage: 'primitives', workspaceDir: ws, recorded: most }));
    expect(gate.ok).toBe(true); // 23/24 ≥ 90%

    const few = ROADMAP_PRIMITIVES.slice(0, 5).map((name) => ({ name, kind: 'atom' }));
    const fail = runStageGate(input({ stage: 'primitives', workspaceDir: ws, recorded: few }));
    expect(fail.ok).toBe(false);
    expect(fail.issues[0]).toContain('Missing');
  });
});

describe('docs gate', () => {
  it('every recorded component must be mentioned in docs.md', () => {
    const ws = makeWorkspace({ 'pkg/docs.md': '# Docs\n\n## Button\nBody.' });
    const recorded = [
      { name: 'Button', kind: 'atom' },
      { name: 'Card', kind: 'atom' },
    ];
    const gate = runStageGate(input({ stage: 'docs', workspaceDir: ws, recorded }));
    expect(gate.ok).toBe(false);
    expect(gate.issues[0]).toContain('Card');
  });
});

describe('publish gate', () => {
  it('has no own checks (delegated to audit/publish tools)', () => {
    const ws = makeWorkspace({});
    expect(runStageGate(input({ stage: 'publish', workspaceDir: ws })).ok).toBe(true);
  });
});
