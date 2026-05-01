import { describe, it, expect } from 'vitest';
import {
  resolveEndpointBase,
  buildEndpointPath,
  normaliseTrigger,
  renderRunConfigFile,
  formatStartRunReply,
  type WorkspaceRestoreReport,
} from '../core/coder/tools/company/qa/qa-start-run.js';

describe('resolveEndpointBase', () => {
  it('uses MCP_PUBLIC_URL when set', () => {
    const r = resolveEndpointBase({ MCP_PUBLIC_URL: 'https://example.test' });
    expect(r.base).toBe('https://example.test');
    expect(r.fallback).toBe(false);
  });

  it('strips trailing slashes', () => {
    expect(resolveEndpointBase({ MCP_PUBLIC_URL: 'https://x/' }).base).toBe('https://x');
    expect(resolveEndpointBase({ MCP_PUBLIC_URL: 'https://x//' }).base).toBe('https://x');
  });

  it('falls back to MCP_DASHBOARD_URL', () => {
    const r = resolveEndpointBase({ MCP_DASHBOARD_URL: 'http://dash:5173' });
    expect(r.base).toBe('http://dash:5173');
    expect(r.fallback).toBe(false);
  });

  it('prefers MCP_PUBLIC_URL over MCP_DASHBOARD_URL', () => {
    const r = resolveEndpointBase({
      MCP_PUBLIC_URL: 'https://primary',
      MCP_DASHBOARD_URL: 'https://secondary',
    });
    expect(r.base).toBe('https://primary');
  });

  it('returns docker-internal fallback when neither URL nor runtime is set', () => {
    const r = resolveEndpointBase({});
    expect(r.base).toBe('http://host.docker.internal:3333');
    expect(r.fallback).toBe(true);
  });

  it('uses podman host alias when runtimeHint=podman', () => {
    const r = resolveEndpointBase({}, 'podman');
    expect(r.base).toBe('http://host.containers.internal:3333');
    expect(r.fallback).toBe(true);
  });

  it('uses podman alias via MCP_SANDBOX_RUNTIME=podman', () => {
    const r = resolveEndpointBase({ MCP_SANDBOX_RUNTIME: 'podman' });
    expect(r.base).toBe('http://host.containers.internal:3333');
  });

  it('runtimeHint takes precedence over env var', () => {
    const r = resolveEndpointBase({ MCP_SANDBOX_RUNTIME: 'docker' }, 'podman');
    expect(r.base).toBe('http://host.containers.internal:3333');
  });

  it('still uses docker alias when runtime=docker', () => {
    expect(resolveEndpointBase({}, 'docker').base).toBe('http://host.docker.internal:3333');
  });

  it('ignores unknown runtimes (falls back to docker)', () => {
    expect(resolveEndpointBase({}, 'k8s').base).toBe('http://host.docker.internal:3333');
  });

  it('treats whitespace-only env as unset', () => {
    const r = resolveEndpointBase({ MCP_PUBLIC_URL: '   ' });
    expect(r.fallback).toBe(true);
  });
});

describe('buildEndpointPath', () => {
  it('returns the canonical reporter endpoint path', () => {
    expect(buildEndpointPath(42)).toBe('/api/company/sessions/42/qa/test-event');
  });
});

describe('normaliseTrigger', () => {
  it('passes through valid triggers', () => {
    expect(normaliseTrigger('agent')).toBe('agent');
    expect(normaliseTrigger('human')).toBe('human');
    expect(normaliseTrigger('watcher')).toBe('watcher');
  });

  it('defaults to "agent" for unknown values', () => {
    expect(normaliseTrigger('robot')).toBe('agent');
    expect(normaliseTrigger(undefined)).toBe('agent');
    expect(normaliseTrigger(123)).toBe('agent');
    expect(normaliseTrigger(null)).toBe('agent');
  });
});

// ─── v4.4 ─────────────────────────────────────────────────────────

describe('renderRunConfigFile', () => {
  it('emits parseable JSON with the expected shape', () => {
    const out = renderRunConfigFile(42, 'http://example.test/api/x');
    const parsed = JSON.parse(out);
    expect(parsed.runId).toBe('42');
    expect(parsed.endpoint).toBe('http://example.test/api/x');
    expect(typeof parsed.startedAt).toBe('string');
    expect(() => new Date(parsed.startedAt)).not.toThrow();
  });

  it('coerces numeric runId to string', () => {
    const parsed = JSON.parse(renderRunConfigFile(7, 'x'));
    expect(parsed.runId).toBe('7');
  });
});

function emptyReport(): WorkspaceRestoreReport {
  return {
    runConfigWritten: false,
    reporterRestored: false,
    globalSetupRestored: false,
    configMissing: [],
    configRecommendations: [],
    configRecommendedWritten: false,
    prunedRunDirs: [],
    wipedSandboxDirs: [],
    warnings: [],
  };
}

describe('formatStartRunReply', () => {
  const run = { id: 12, suite: 'login', service_id: 'main' };
  const endpoint = 'http://host.containers.internal:3333/api/.../qa/test-event';

  it('omits the restore section on the happy path with no side-effects to report', () => {
    const out = formatStartRunReply(run, endpoint, emptyReport(), '');
    expect(out).toContain('Started qa_test_run id=12');
    expect(out).not.toContain('Workspace restore:');
    expect(out).toContain('npx playwright test');
    // Canonical command line itself must NOT carry --reporter (the
    // warning sentence elsewhere in the message DOES mention it).
    const lines = out.split('\n').map((l) => l.trim());
    const cmdLine = lines.find((l) => l.startsWith('npx playwright test'));
    expect(cmdLine).toBe('npx playwright test');
  });

  it('shows ✓ checks when files were restored', () => {
    const r = emptyReport();
    r.runConfigWritten = true;
    r.reporterRestored = true;
    r.globalSetupRestored = true;
    const out = formatStartRunReply(run, endpoint, r, '');
    expect(out).toContain('Workspace restore:');
    expect(out).toContain('✓ Wrote tests/e2e/.mcp-qa-run.json');
    expect(out).toContain('✓ Restored tests/e2e/reporter.ts');
    expect(out).toContain('✓ Restored tests/e2e/global-setup.ts');
  });

  it('shows ⚠ when playwright.config.ts is missing critical keys', () => {
    const r = emptyReport();
    r.configMissing = ['globalSetup (auth cookie)', "'html' reporter"];
    r.configRecommendedWritten = true;
    const out = formatStartRunReply(run, endpoint, r, '');
    expect(out).toContain('⚠ playwright.config.ts is MISSING');
    expect(out).toContain('globalSetup (auth cookie)');
    expect(out).toContain("'html' reporter");
    expect(out).toContain('playwright.config.recommended.ts');
  });

  it('lists per-step warnings when restoration fails', () => {
    const r = emptyReport();
    r.warnings = ['Failed to write tests/e2e/.mcp-qa-run.json: ENOENT'];
    const out = formatStartRunReply(run, endpoint, r, '');
    expect(out).toContain('⚠ Failed to write tests/e2e/.mcp-qa-run.json');
  });

  it('appends fallback note about MCP_PUBLIC_URL when provided', () => {
    const out = formatStartRunReply(
      run,
      endpoint,
      emptyReport(),
      '\n\nNote: MCP_PUBLIC_URL was not set on the host…',
    );
    expect(out).toContain('Note: MCP_PUBLIC_URL was not set');
  });

  it('always tells the agent NOT to pass --reporter on the CLI', () => {
    const out = formatStartRunReply(run, endpoint, emptyReport(), '');
    expect(out).toContain('do NOT pass --reporter on the CLI');
  });
});
