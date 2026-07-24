/**
 * Onda 1 (Codex-parity): the permissions/execution-boundary block and the
 * `# Project instructions (AGENTS.md)` block. Contract:
 *   - both render ABOVE SYSTEM_PROMPT_DYNAMIC_BOUNDARY (session-fixed →
 *     cache-stable)
 *   - both absent when their input is omitted/empty (byte-identical prefix)
 *   - loadAgentsMd walks root→cwd, prefers AGENTS.override.md per directory
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type PromptContext } from '../system-prompt.js';
import { permissionsSection } from '../permissions-prompt.js';
import { loadAgentsMd } from '../agents-md.js';

function baseCtx(overrides?: Partial<PromptContext>): PromptContext {
  return { projectName: 'demo', projectRoot: 'D:/demo', os: 'win32', providerFamily: 'zai', profile: 'full', ...overrides };
}

describe('permissionsSection', () => {
  it('renders the writable root and approval mode', () => {
    const out = permissionsSection({ writableRoots: ['D:/proj'], approvalMode: 'ask' });
    expect(out).toContain('# Permissions & execution boundary');
    expect(out).toContain('Writable root: `D:/proj`');
    expect(out).toContain('Tool approval mode: **ask**');
    expect(out).toContain('PAUSE for');
  });

  it('varies the guidance per mode and pluralizes multiple roots', () => {
    expect(permissionsSection({ writableRoots: ['a'], approvalMode: 'auto' })).toContain('without prompting');
    expect(permissionsSection({ writableRoots: ['a'], approvalMode: 'unrestricted' })).toContain('No approval prompts');
    expect(permissionsSection({ writableRoots: ['a', 'b'], approvalMode: 'ask' })).toContain('Writable roots: `a`, `b`');
  });

  it('lists read-only external roots separately from writable roots', () => {
    const out = permissionsSection({
      writableRoots: ['D:/project', 'D:/editable'],
      readableRoots: ['C:/reference'],
      canRequestExternalRoots: true,
      approvalMode: 'auto',
    });
    expect(out).toContain('Writable roots: `D:/project`, `D:/editable`');
    expect(out).toContain('Additional read-only roots/files: `C:/reference`');
    expect(out).toContain('use native filesystem tools for external roots');
    expect(out).toContain('filesystem_access:{path,access}');
  });

  it('is empty when no policy or no roots', () => {
    expect(permissionsSection(undefined)).toBe('');
    expect(permissionsSection({ writableRoots: [], approvalMode: 'auto' })).toBe('');
  });
});

describe('system prompt — permissions + AGENTS.md placement', () => {
  it('renders both blocks above the dynamic boundary', () => {
    const prompt = buildSystemPrompt(baseCtx({
      permissions: { writableRoots: ['D:/demo'], approvalMode: 'ask' },
      agentsMd: 'Always run pnpm lint before committing.',
    }));
    const [prefix] = prompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    expect(prefix).toContain('# Permissions & execution boundary');
    expect(prefix).toContain('# Project instructions (AGENTS.md)');
    expect(prefix).toContain('Always run pnpm lint before committing.');
  });

  it('omits both when not supplied (prefix stays clean)', () => {
    const prompt = buildSystemPrompt(baseCtx());
    expect(prompt).not.toContain('# Permissions & execution boundary');
    expect(prompt).not.toContain('# Project instructions (AGENTS.md)');
  });
});

describe('loadAgentsMd', () => {
  it('reads the root-level AGENTS.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), 'root rules');
      expect(loadAgentsMd(root)).toBe('root rules');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers AGENTS.override.md over AGENTS.md in the same directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), 'base');
      writeFileSync(join(root, 'AGENTS.override.md'), 'override');
      expect(loadAgentsMd(root)).toBe('override');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('concatenates root→cwd in order', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
    try {
      const sub = join(root, 'pkg', 'app');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(root, 'AGENTS.md'), 'ROOT');
      writeFileSync(join(sub, 'AGENTS.md'), 'DEEP');
      expect(loadAgentsMd(root, sub)).toBe('ROOT\n\nDEEP');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty string when no AGENTS.md exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentsmd-'));
    try {
      expect(loadAgentsMd(root)).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
