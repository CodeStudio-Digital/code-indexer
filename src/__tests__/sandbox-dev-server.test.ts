import { describe, it, expect } from 'vitest';
import {
  buildDevServerCommand,
  devServerLogLooksReady,
} from '@mcp/services/sandbox/manager/dev-server.js';

describe('buildDevServerCommand', () => {
  it('default stack (react-ts) uses `npm run dev` with port flag', () => {
    const cmd = buildDevServerCommand('react-ts', 5173);
    expect(cmd).toContain('npm run dev');
    expect(cmd).toContain('--host 0.0.0.0');
    expect(cmd).toContain('--port 5173');
    expect(cmd).toContain('/tmp/dev-server.log');
  });

  it('cf-worker stack uses wrangler with --local and silent flag', () => {
    const cmd = buildDevServerCommand('cf-worker', 5173);
    expect(cmd).toContain('npx wrangler dev');
    expect(cmd).toContain('--ip 0.0.0.0');
    expect(cmd).toContain('--port 5173');
    expect(cmd).toContain('--local');
    expect(cmd).toContain('--show-interactive-dev-session=false');
  });

  it('respects the supplied port for both stacks', () => {
    expect(buildDevServerCommand('react-ts', 4173)).toContain('--port 4173');
    expect(buildDevServerCommand('cf-worker', 8788)).toContain('--port 8788');
  });

  it('wraps the command in nohup + background so the manager`s exec returns quickly', () => {
    expect(buildDevServerCommand('react-ts', 5173)).toMatch(/^nohup .* &$/);
    expect(buildDevServerCommand('cf-worker', 5173)).toMatch(/^nohup .* &$/);
  });

  it('redirects both stdout and stderr to the log file', () => {
    const cmd = buildDevServerCommand('react-ts', 5173);
    expect(cmd).toContain('2>&1');
  });
});

describe('devServerLogLooksReady', () => {
  it('matches Vite Local banner', () => {
    expect(devServerLogLooksReady('  ➜  Local:   http://localhost:5173/')).toBe(true);
  });

  it('matches Vite Network banner', () => {
    expect(devServerLogLooksReady('  ➜  Network: http://172.17.0.2:5173/')).toBe(true);
  });

  it('matches Vite ready timing line', () => {
    expect(devServerLogLooksReady('VITE v5.4.0  ready in 432 ms')).toBe(true);
  });

  it('matches Wrangler watch banner', () => {
    expect(devServerLogLooksReady('⎔ Watch mode enabled. Hit CTRL-C to exit.')).toBe(true);
  });

  it('matches Angular bundle complete banner', () => {
    expect(
      devServerLogLooksReady('√ Application bundle generation complete. [1.234 seconds]'),
    ).toBe(true);
  });

  it('returns false for unrelated chatter', () => {
    expect(devServerLogLooksReady('npm WARN deprecated foo@1.0.0')).toBe(false);
    expect(devServerLogLooksReady('added 213 packages in 4s')).toBe(false);
  });

  it('returns false for the empty string (dev server still spinning up)', () => {
    expect(devServerLogLooksReady('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(devServerLogLooksReady('LOCAL: http://...')).toBe(true);
    expect(devServerLogLooksReady('network: http://...')).toBe(true);
  });

  it('does not match http without the expected prefix word', () => {
    // Without "Local:" / "Network:" the URL alone should not signal ready
    expect(devServerLogLooksReady('http://localhost:5173/ is live')).toBe(false);
  });
});
