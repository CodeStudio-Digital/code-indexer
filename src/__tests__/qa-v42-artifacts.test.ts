import { describe, it, expect } from 'vitest';
import {
  mimeForExtension,
  extensionOf,
} from '@mcp/services/qa/parsers/mime-for-extension.js';
import {
  rewriteUrl,
  rewritePlaywrightReportHtml,
  resolveRelative,
} from '@mcp/services/qa/parsers/rewrite-playwright-report.js';
import {
  isAllowedArtifactPath,
  isValidServiceId,
} from '@apps/http-api/server/routes/company/qa/artifacts.js';
import { enrichResultsWithUrls } from '@apps/http-api/server/routes/company/qa/runs.js';
import {
  buildArtifactUrl,
  buildPlaywrightReportUrl,
} from '@apps/dashboard/features/agents/tests/api/qa-api.js';
import {
  buildLocalTraceUrl,
  buildViewerUrl,
} from '@apps/dashboard/features/agents/tests/shared/TraceLinkButton.js';
import type { QaTestResult } from '@mcp/services/qa/types.js';

// ─── mimeForExtension ────────────────────────────────────────────

describe('mimeForExtension', () => {
  it('maps known extensions to specific mime types', () => {
    expect(mimeForExtension('a.zip')).toBe('application/zip');
    expect(mimeForExtension('a.png')).toBe('image/png');
    expect(mimeForExtension('a.jpg')).toBe('image/jpeg');
    expect(mimeForExtension('a.jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('a.webm')).toBe('video/webm');
    expect(mimeForExtension('a.mp4')).toBe('video/mp4');
    expect(mimeForExtension('a.html')).toBe('text/html; charset=utf-8');
    expect(mimeForExtension('a.css')).toBe('text/css; charset=utf-8');
    expect(mimeForExtension('a.js')).toBe('application/javascript; charset=utf-8');
    expect(mimeForExtension('a.json')).toBe('application/json; charset=utf-8');
    expect(mimeForExtension('a.svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeForExtension('a.ZIP')).toBe('application/zip');
    expect(mimeForExtension('Foo.PnG')).toBe('image/png');
  });

  it('falls back to octet-stream for unknown / missing', () => {
    expect(mimeForExtension('a.exe')).toBe('application/octet-stream');
    expect(mimeForExtension('noext')).toBe('application/octet-stream');
    expect(mimeForExtension('endswithdot.')).toBe('application/octet-stream');
    expect(mimeForExtension('')).toBe('application/octet-stream');
  });
});

describe('extensionOf', () => {
  it('returns the lowercased extension without dot', () => {
    expect(extensionOf('a.PNG')).toBe('png');
    expect(extensionOf('path/to/Trace.Zip')).toBe('zip');
  });
  it('returns empty for missing/trailing dot', () => {
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('foo.')).toBe('');
  });
});

// ─── isAllowedArtifactPath / isValidServiceId ────────────────────

describe('isAllowedArtifactPath', () => {
  it('accepts paths under the three whitelisted prefixes', () => {
    expect(isAllowedArtifactPath('tests/e2e/login.spec.ts')).toBe(true);
    expect(isAllowedArtifactPath('test-results/login-1/trace.zip')).toBe(true);
    expect(isAllowedArtifactPath('playwright-report/index.html')).toBe(true);
  });
  it('rejects empty / absolute / traversal / NUL', () => {
    expect(isAllowedArtifactPath('')).toBe(false);
    expect(isAllowedArtifactPath('/etc/passwd')).toBe(false);
    expect(isAllowedArtifactPath('test-results/../../etc/passwd')).toBe(false);
    expect(isAllowedArtifactPath('tests/./e2e/x.zip')).toBe(false);
    expect(isAllowedArtifactPath('test-results/x\u0000.zip')).toBe(false);
  });
  it('rejects paths outside the whitelist', () => {
    expect(isAllowedArtifactPath('src/index.ts')).toBe(false);
    expect(isAllowedArtifactPath('package.json')).toBe(false);
  });
});

describe('isValidServiceId', () => {
  it('accepts main and well-formed service ids', () => {
    expect(isValidServiceId('main')).toBe(true);
    expect(isValidServiceId('api')).toBe(true);
    expect(isValidServiceId('worker-1')).toBe(true);
  });
  it('rejects ids that violate the schema', () => {
    expect(isValidServiceId('')).toBe(false);
    expect(isValidServiceId('1abc')).toBe(false); // must start with letter
    expect(isValidServiceId('Has-Caps')).toBe(false);
    expect(isValidServiceId('with spaces')).toBe(false);
    expect(isValidServiceId(undefined)).toBe(false);
    expect(isValidServiceId(123)).toBe(false);
  });
});

// ─── enrichResultsWithUrls ───────────────────────────────────────

function mkResult(partial: Partial<QaTestResult> & { id: number; test_name: string }): QaTestResult {
  return {
    run_id: 1,
    spec_file: 'tests/e2e/login.spec.ts',
    status: 'failed',
    duration_ms: null,
    error: null,
    trace_path: null,
    screenshot_path: null,
    video_path: null,
    summary_md_path: null,
    kanban_card_id: null,
    created_at: '',
    ...partial,
  };
}

describe('enrichResultsWithUrls', () => {
  it('produces null URLs when there are no paths', () => {
    const out = enrichResultsWithUrls([mkResult({ id: 1, test_name: 'a' })], 7, 'main');
    expect(out[0].trace_url).toBeNull();
    expect(out[0].screenshot_url).toBeNull();
    expect(out[0].video_url).toBeNull();
  });

  it('builds artifact URLs with the run service_id', () => {
    const out = enrichResultsWithUrls(
      [
        mkResult({
          id: 2,
          test_name: 'a',
          trace_path: 'test-results/a/trace.zip',
          screenshot_path: 'test-results/a/test-failed-1.png',
          video_path: 'test-results/a/video.webm',
        }),
      ],
      42,
      'api',
    );
    const r = out[0];
    expect(r.trace_url).toContain('/api/company/sessions/42/qa/artifact');
    expect(r.trace_url).toContain('service=api');
    expect(r.trace_url).toContain(encodeURIComponent('test-results/a/trace.zip'));
    expect(r.screenshot_url).toContain(encodeURIComponent('test-results/a/test-failed-1.png'));
    expect(r.video_url).toContain('video.webm');
  });
});

// ─── client builders ────────────────────────────────────────────

describe('buildArtifactUrl / buildPlaywrightReportUrl', () => {
  it('defaults service to main when omitted', () => {
    expect(buildArtifactUrl({ sessionId: 1, path: 'tests/e2e/x.zip' })).toContain('service=main');
    expect(buildPlaywrightReportUrl({ sessionId: 1 })).toContain('service=main');
    expect(buildPlaywrightReportUrl({ sessionId: 1 })).toContain('file=index.html');
  });
  it('honours explicit service + file', () => {
    expect(buildArtifactUrl({ sessionId: 9, serviceId: 'api', path: 'tests/e2e/login.spec.ts' }))
      .toBe('/api/company/sessions/9/qa/artifact?service=api&path=tests%2Fe2e%2Flogin.spec.ts');
    expect(buildPlaywrightReportUrl({ sessionId: 9, serviceId: 'api', file: 'data/styles.css' }))
      .toBe('/api/company/sessions/9/qa/playwright-report?service=api&file=data%2Fstyles.css');
  });
});

describe('buildLocalTraceUrl', () => {
  it('uses /qa/artifact (not legacy /qa/trace)', () => {
    const url = buildLocalTraceUrl({ sessionId: 7, tracePath: 'test-results/x/trace.zip' });
    expect(url).toContain('/qa/artifact');
    expect(url).toContain('service=main');
    expect(url).toContain(encodeURIComponent('test-results/x/trace.zip'));
  });
  it('honours service override', () => {
    const url = buildLocalTraceUrl({
      sessionId: 7,
      tracePath: 'test-results/x/trace.zip',
      serviceId: 'api',
    });
    expect(url).toContain('service=api');
  });
});

describe('buildViewerUrl', () => {
  it('wraps the local URL into trace.playwright.dev', () => {
    const local = 'http://localhost/x';
    expect(buildViewerUrl(local)).toBe(
      `https://trace.playwright.dev/?trace=${encodeURIComponent(local)}`,
    );
  });
});

// ─── resolveRelative + rewriteUrl + rewritePlaywrightReportHtml ──

describe('resolveRelative', () => {
  it('joins simple segments', () => {
    expect(resolveRelative('playwright-report/', 'styles.css')).toBe('playwright-report/styles.css');
    expect(resolveRelative('playwright-report/data/', 'app.js')).toBe('playwright-report/data/app.js');
  });
  it('collapses .. and . segments', () => {
    expect(resolveRelative('playwright-report/data/', '../styles.css')).toBe('playwright-report/styles.css');
    expect(resolveRelative('playwright-report/data/sub/', '../../app.js')).toBe('playwright-report/app.js');
    expect(resolveRelative('playwright-report/', './styles.css')).toBe('playwright-report/styles.css');
  });
  it('handles empty rel as the base dir', () => {
    expect(resolveRelative('playwright-report/', '')).toBe('playwright-report');
  });
});

describe('rewriteUrl', () => {
  const opts = { sessionId: 7, serviceId: 'api', filePath: 'playwright-report/index.html' };

  it('rewrites simple relative URLs', () => {
    const url = rewriteUrl('styles.css', opts);
    expect(url).toContain('/api/company/sessions/7/qa/playwright-report');
    expect(url).toContain('service=api');
    expect(url).toContain(encodeURIComponent('playwright-report/styles.css'));
  });

  it('strips leading ./ before resolving', () => {
    const url = rewriteUrl('./app.js', opts);
    expect(url).toContain(encodeURIComponent('playwright-report/app.js'));
  });

  it('passes absolute http(s) URLs through unchanged', () => {
    expect(rewriteUrl('https://cdn.example.com/x.js', opts)).toBe('https://cdn.example.com/x.js');
    expect(rewriteUrl('//cdn.example.com/x.js', opts)).toBe('//cdn.example.com/x.js'); // protocol-relative — passes (// is valid)
  });

  it('passes data:, mailto:, blob:, javascript: through', () => {
    expect(rewriteUrl('data:text/plain;base64,AAAA', opts)).toBe('data:text/plain;base64,AAAA');
    expect(rewriteUrl('mailto:foo@bar.com', opts)).toBe('mailto:foo@bar.com');
    expect(rewriteUrl('blob:abc', opts)).toBe('blob:abc');
    expect(rewriteUrl('javascript:void(0)', opts)).toBe('javascript:void(0)');
  });

  it('passes hash-only URLs through', () => {
    expect(rewriteUrl('#anchor', opts)).toBe('#anchor');
  });
});

describe('rewritePlaywrightReportHtml', () => {
  it('rewrites href, src, and srcset', () => {
    const html = `
      <link href="styles.css" rel="stylesheet">
      <script src="app.js"></script>
      <img src="logo.png" srcset="logo@2x.png 2x, logo@3x.png 3x">
      <a href="https://external.test">absolute</a>
    `;
    const out = rewritePlaywrightReportHtml(html, {
      sessionId: 7,
      serviceId: 'api',
      filePath: 'playwright-report/index.html',
    });
    expect(out).toContain(`/qa/playwright-report?service=api&file=${encodeURIComponent('playwright-report/styles.css')}`);
    expect(out).toContain(encodeURIComponent('playwright-report/app.js'));
    expect(out).toContain(encodeURIComponent('playwright-report/logo.png'));
    // srcset preserves descriptors
    expect(out).toContain(' 2x');
    expect(out).toContain(' 3x');
    // absolute external untouched
    expect(out).toContain('href="https://external.test"');
  });

  it('handles single-quoted attributes', () => {
    const html = `<link href='nested/data.json'>`;
    const out = rewritePlaywrightReportHtml(html, {
      sessionId: 1,
      serviceId: 'main',
      filePath: 'playwright-report/index.html',
    });
    expect(out).toContain(encodeURIComponent('playwright-report/nested/data.json'));
  });

  it('respects the filePath base directory', () => {
    const html = `<link href="../styles.css">`;
    const out = rewritePlaywrightReportHtml(html, {
      sessionId: 1,
      serviceId: 'main',
      filePath: 'playwright-report/data/inner.html',
    });
    expect(out).toContain(encodeURIComponent('playwright-report/styles.css'));
  });
});
