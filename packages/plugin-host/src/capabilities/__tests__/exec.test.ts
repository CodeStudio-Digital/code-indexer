import { describe, expect, it } from 'vitest';
import { handleExec, isExecAllowed } from '../exec.js';

describe('isExecAllowed', () => {
  const allow = ['npx', 'wrangler'];

  it('allows `npx <pkg>` when both are allowlisted', () => {
    expect(isExecAllowed('npx', ['wrangler', 'deploy'], allow)).toBe(true);
  });
  it('denies `npx <pkg>` when the package is not allowlisted', () => {
    expect(isExecAllowed('npx', ['rimraf', '-rf', '.'], allow)).toBe(false);
  });
  it('denies a binary outside the allowlist', () => {
    expect(isExecAllowed('rm', ['-rf', '/'], allow)).toBe(false);
  });
  it('denies when the allowlist is empty/undefined', () => {
    expect(isExecAllowed('node', [], [])).toBe(false);
    expect(isExecAllowed('node', [], undefined)).toBe(false);
  });
  it('matches on basename incl. a .cmd shim', () => {
    expect(isExecAllowed('npx.cmd', ['wrangler'], allow)).toBe(true);
  });
});

describe('handleExec', () => {
  it('runs an allowlisted command, capturing stdout + exit code', async () => {
    const r = await handleExec(
      { cmd: process.execPath, args: ['-e', 'process.stdout.write("hi")'] },
      process.cwd(),
      { allow: ['node'] },
    );
    expect(r.stdout).toContain('hi');
    expect(r.code).toBe(0);
  });

  it('rejects a non-allowlisted command before spawning', async () => {
    await expect(
      handleExec({ cmd: 'rm', args: ['-rf', '/'] }, process.cwd(), { allow: ['node'] }),
    ).rejects.toThrow(/permission_denied/);
  });
});
