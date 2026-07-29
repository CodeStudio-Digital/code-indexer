import { describe, it, expect } from 'vitest';
import { isAllowedArtifactPath as isAllowedTracePath } from '@apps/http-api/server/routes/company/qa/artifacts.js';
import {
  buildLocalTraceUrl,
  buildViewerUrl,
} from '@apps/dashboard/features/agents/tests/shared/TraceLinkButton.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';

describe('isAllowedTracePath', () => {
  it('accepts paths under tests/e2e/', () => {
    expect(isAllowedTracePath('tests/e2e/login-trace.zip')).toBe(true);
    expect(isAllowedTracePath('tests/e2e/sub/dir/trace.zip')).toBe(true);
  });

  it('accepts paths under test-results/', () => {
    expect(isAllowedTracePath('test-results/login-1/trace.zip')).toBe(true);
  });

  it('accepts paths under playwright-report/', () => {
    expect(isAllowedTracePath('playwright-report/data/trace.zip')).toBe(true);
  });

  it('rejects empty / whitespace paths', () => {
    expect(isAllowedTracePath('')).toBe(false);
    expect(isAllowedTracePath('   ')).toBe(false);
  });

  it('rejects absolute paths', () => {
    expect(isAllowedTracePath('/tests/e2e/x.zip')).toBe(false);
    expect(isAllowedTracePath('/etc/passwd')).toBe(false);
  });

  it('rejects path traversal segments', () => {
    expect(isAllowedTracePath('tests/e2e/../../../etc/passwd')).toBe(false);
    expect(isAllowedTracePath('tests/./e2e/x.zip')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isAllowedTracePath('tests/e2e/x\u0000.zip')).toBe(false);
  });

  it('rejects paths outside the whitelist', () => {
    expect(isAllowedTracePath('src/index.ts')).toBe(false);
    expect(isAllowedTracePath('node_modules/.cache')).toBe(false);
    expect(isAllowedTracePath('package.json')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isAllowedTracePath(123 as unknown as string)).toBe(false);
    expect(isAllowedTracePath(null as unknown as string)).toBe(false);
  });
});

describe('TraceLinkButton URL builders', () => {
  it('encodes path correctly in local URL (v4.2: /qa/artifact + service)', () => {
    const url = buildLocalTraceUrl({ sessionId: SESSION_ID, tracePath: 'tests/e2e/login-trace.zip' });
    expect(url).toContain(`/api/company/sessions/${SESSION_ID}/qa/artifact`);
    expect(url).toContain('service=main');
    expect(url).toContain(encodeURIComponent('tests/e2e/login-trace.zip'));
  });

  it('handles paths with spaces and slashes', () => {
    const url = buildLocalTraceUrl({
      sessionId: SESSION_ID,
      tracePath: 'test-results/my run/trace.zip',
    });
    // URLSearchParams encodes spaces as `+` (form-urlencoded). The
    // server's `c.req.query()` decodes both `+` and `%20` so this is
    // safe; the test asserts the actual encoding shape.
    // URLSearchParams encodes space as `+` (form-urlencoded variant).
    expect(url).toContain('test-results%2Fmy+run%2Ftrace.zip');
  });

  it('wraps the local URL into the viewer link', () => {
    const local =
      `http://localhost:3333/api/company/sessions/${SESSION_ID}/qa/trace?path=x`;
    const viewer = buildViewerUrl(local);
    expect(viewer).toBe(
      `https://trace.playwright.dev/?trace=${encodeURIComponent(local)}`,
    );
  });
});
