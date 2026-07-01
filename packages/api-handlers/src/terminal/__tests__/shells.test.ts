import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { detectShells, targetForShell } from '../shells.js';

// Mock the WSL enumeration so tests never spawn a real `wsl.exe`.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const originalPlatform = process.platform;
const originalShell = process.env.SHELL;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

describe('detectShells', () => {
  it('always offers Windows PowerShell and Command Prompt on win32', () => {
    setPlatform('win32');
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('wsl not installed');
    });

    const shells = detectShells();
    const ids = shells.map((s) => s.id);
    expect(ids).toContain('powershell');
    expect(ids).toContain('cmd');
    // PowerShell launches with -NoLogo to suppress the banner.
    expect(shells.find((s) => s.id === 'powershell')?.args).toEqual(['-NoLogo']);
  });

  it('parses UTF-16LE WSL distro output into per-distro entries', () => {
    setPlatform('win32');
    // `wsl --list --quiet` emits UTF-16LE — the decode is the tricky bit.
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le'));

    const shells = detectShells();
    const ubuntu = shells.find((s) => s.id === 'wsl:Ubuntu');
    const debian = shells.find((s) => s.id === 'wsl:Debian');
    expect(ubuntu).toMatchObject({ file: 'wsl.exe', args: ['-d', 'Ubuntu'] });
    expect(debian).toMatchObject({ file: 'wsl.exe', args: ['-d', 'Debian'] });
  });

  it('uses $SHELL on unix', () => {
    setPlatform('linux');
    process.env.SHELL = '/usr/bin/zsh';

    const shells = detectShells();
    const zsh = shells.find((s) => s.file === '/usr/bin/zsh');
    expect(zsh).toBeDefined();
    expect(zsh?.args).toEqual(['-l']);
  });

  it('never returns an empty list (falls back to a default shell)', () => {
    setPlatform('linux');
    delete process.env.SHELL;
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
  });
});

describe('targetForShell', () => {
  it('maps a wsl.exe shell to its distro target', () => {
    expect(targetForShell({ file: 'wsl.exe', args: ['-d', 'Ubuntu'] })).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
    expect(targetForShell({ file: 'C:\\Windows\\System32\\wsl.exe', args: ['--distribution', 'Debian'] })).toEqual({
      kind: 'wsl',
      distro: 'Debian',
    });
  });

  it('treats Git Bash / PowerShell / cmd / null as the host (uses Windows runtimes)', () => {
    expect(targetForShell({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-i', '-l'] })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'powershell.exe', args: ['-NoLogo'] })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'cmd.exe' })).toEqual({ kind: 'host' });
    expect(targetForShell(null)).toEqual({ kind: 'host' });
    expect(targetForShell(undefined)).toEqual({ kind: 'host' });
  });

  it('falls back to host when wsl.exe carries no distro', () => {
    expect(targetForShell({ file: 'wsl.exe' })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'wsl.exe', args: [] })).toEqual({ kind: 'host' });
  });
});
