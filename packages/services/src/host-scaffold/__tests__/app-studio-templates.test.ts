import { describe, expect, it } from 'vitest';
import { APP_STUDIO_DEV_DEPS } from '../app-studio/scaffold-app-studio.js';
import { buildConfigFiles } from '../app-studio/templates-config.js';

const files = new Map(
  buildConfigFiles({ slug: 'sample', appSlug: 'sample', appName: 'Sample', port: 4173 })
    .map((file) => [file.path, file.contents]),
);

describe('App Studio architecture/TDD scaffold', () => {
  it('pins the centrally reviewed Workers compatibility profile', () => {
    expect(files.get('wrangler.jsonc')).toContain('"compatibility_date": "2026-07-03"');
  });

  it('uses the current Cloudflare Vitest plugin and Playwright project URL', () => {
    expect(files.get('vitest.config.ts')).toContain('cloudflareTest');
    expect(files.get('vitest.config.ts')).toContain('readD1Migrations');
    expect(files.get('playwright.config.ts')).toContain('http://127.0.0.1:4173');
  });

  it('installs and exposes the required test runners', () => {
    expect(APP_STUDIO_DEV_DEPS).toEqual(expect.arrayContaining(['vitest', '@cloudflare/vitest-pool-workers', '@playwright/test']));
    const pkg = JSON.parse(files.get('package.json')!) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:worker']).toContain('vitest run');
    expect(pkg.scripts['test:e2e']).toContain('playwright test');
  });
});
