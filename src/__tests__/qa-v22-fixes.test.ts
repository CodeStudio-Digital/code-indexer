import { describe, it, expect } from 'vitest';
import { hasQaPlaywrightSkill } from '@mcp/company/services/SandboxService.js';
import {
  resolveIncludeE2e,
  getScaffolder,
} from '@mcp/services/sandbox/scaffolders/registry.js';

// ─── hasQaPlaywrightSkill ────────────────────────────────────────

describe('hasQaPlaywrightSkill', () => {
  it('returns false for empty / null / malformed input', () => {
    expect(hasQaPlaywrightSkill('')).toBe(false);
    expect(hasQaPlaywrightSkill('not json')).toBe(false);
    expect(hasQaPlaywrightSkill('null')).toBe(false);
    expect(hasQaPlaywrightSkill('"a string"')).toBe(false);
    expect(hasQaPlaywrightSkill('[]')).toBe(false);
  });

  it('returns false when role_assignments is absent or wrong type', () => {
    expect(hasQaPlaywrightSkill('{}')).toBe(false);
    expect(hasQaPlaywrightSkill('{"role_assignments":null}')).toBe(false);
    expect(hasQaPlaywrightSkill('{"role_assignments":"qa"}')).toBe(false);
    expect(hasQaPlaywrightSkill('{"role_assignments":{}}')).toBe(false);
  });

  it('returns false when no role has the skill', () => {
    const cfg = JSON.stringify({
      role_assignments: [
        { role: 'frontend', skills: ['react', 'typescript'] },
        { role: 'backend', skills: [] },
        { role: 'devops', skills: null },
        { role: 'orphan' },
      ],
    });
    expect(hasQaPlaywrightSkill(cfg)).toBe(false);
  });

  it('returns true when one role has qa-playwright', () => {
    const cfg = JSON.stringify({
      role_assignments: [
        { role: 'frontend', skills: ['react'] },
        { role: 'qa', skills: ['qa-playwright'] },
      ],
    });
    expect(hasQaPlaywrightSkill(cfg)).toBe(true);
  });

  it('returns true even when skill is mixed with others', () => {
    const cfg = JSON.stringify({
      role_assignments: [{ role: 'qa', skills: ['something-else', 'qa-playwright', 'extra'] }],
    });
    expect(hasQaPlaywrightSkill(cfg)).toBe(true);
  });

  it('ignores non-string skill entries', () => {
    const cfg = JSON.stringify({
      role_assignments: [{ role: 'qa', skills: [123, true, null, 'qa-playwright'] }],
    });
    expect(hasQaPlaywrightSkill(cfg)).toBe(true);
  });

  it('rejects look-alike skill ids', () => {
    expect(
      hasQaPlaywrightSkill(
        JSON.stringify({ role_assignments: [{ skills: ['qa-playwright-pro'] }] }),
      ),
    ).toBe(false);
    expect(
      hasQaPlaywrightSkill(
        JSON.stringify({ role_assignments: [{ skills: ['qa_playwright'] }] }),
      ),
    ).toBe(false);
  });
});

// ─── resolveIncludeE2e + getScaffolder opts ──────────────────────

describe('resolveIncludeE2e', () => {
  it('honours explicit opts over env', () => {
    expect(resolveIncludeE2e({ includeE2e: true }, { MCP_SANDBOX_INCLUDE_E2E: '0' })).toBe(true);
    expect(resolveIncludeE2e({ includeE2e: false }, { MCP_SANDBOX_INCLUDE_E2E: '1' })).toBe(false);
  });

  it('falls back to env when opts is undefined', () => {
    expect(resolveIncludeE2e(undefined, { MCP_SANDBOX_INCLUDE_E2E: '1' })).toBe(true);
    expect(resolveIncludeE2e({}, { MCP_SANDBOX_INCLUDE_E2E: '1' })).toBe(true);
  });

  it('defaults to false when neither set', () => {
    expect(resolveIncludeE2e({}, {})).toBe(false);
    expect(resolveIncludeE2e(undefined, {})).toBe(false);
  });

  it('only treats exactly "1" as true', () => {
    expect(resolveIncludeE2e({}, { MCP_SANDBOX_INCLUDE_E2E: 'true' })).toBe(false);
    expect(resolveIncludeE2e({}, { MCP_SANDBOX_INCLUDE_E2E: 'yes' })).toBe(false);
    expect(resolveIncludeE2e({}, { MCP_SANDBOX_INCLUDE_E2E: '' })).toBe(false);
  });
});

describe('getScaffolder (per-session opts)', () => {
  it('returns a scaffolder for known stacks', () => {
    expect(getScaffolder('react-ts').stack).toBe('react-ts');
    expect(getScaffolder('vue-ts').stack).toBe('vue-ts');
    expect(getScaffolder('angular').stack).toBe('angular');
    expect(getScaffolder('vite-api').stack).toBe('vite-api');
    expect(getScaffolder('cf-worker').stack).toBe('cf-worker');
  });

  it('throws on local-process (defensive — has no scaffolder)', () => {
    expect(() => getScaffolder('local-process')).toThrow(/has no scaffolder/);
  });

  it('returns separate instances per call (no stale shared state)', () => {
    const a = getScaffolder('react-ts', { includeE2e: true });
    const b = getScaffolder('react-ts', { includeE2e: false });
    expect(a).not.toBe(b);
  });
});

// `classifyChromiumStartupError` was removed in v3.0 — Chromium now
// runs in a separate sidecar container, so the project container
// never tries to start a browser locally. Sidecar-side errors are
// surfaced via `qa_get_browser_endpoint` instead, with their own
// pure helpers tested in `qa-sidecar.test.ts`.
