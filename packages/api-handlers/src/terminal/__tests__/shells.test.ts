import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { detectShells, resolveShellById, targetForShell } from '../shells.js';

// Mock the WSL enumeration so tests never spawn a real `wsl.exe`.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const originalPlatform = process.platform;
const originalShell = process.env.SHELL;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.mocked(execFile).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

describe('detectShells', () => {
  it('always offers Windows PowerShell and Command Prompt on win32', async () => {
    setPlatform('win32');
    vi.mocked(execFile).mockImplementation((_file, _args, _options, done: any) => done(new Error('wsl not installed')));

    const shells = await detectShells();
    const ids = shells.map((s) => s.id);
    expect(ids).toContain('powershell');
    expect(ids).toContain('cmd');
    // PowerShell launches with -NoLogo to suppress the banner.
    expect(shells.find((s) => s.id === 'powershell')?.args).toEqual(['-NoLogo']);
  });

  it('resolves a native runner shell without enumerating WSL', async () => {
    setPlatform('win32');
    expect(await resolveShellById('cmd')).toMatchObject({ id: 'cmd' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('parses UTF-16LE WSL distro output into per-distro entries', async () => {
    setPlatform('win32');
    // `wsl --list --quiet` emits UTF-16LE — the decode is the tricky bit.
    vi.mocked(execFile).mockImplementation((_file, _args, _options, done: any) => done(null, Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le')));

    const shells = await detectShells();
    const ubuntu = shells.find((s) => s.id === 'wsl:Ubuntu');
    const debian = shells.find((s) => s.id === 'wsl:Debian');
    expect(ubuntu).toMatchObject({ file: 'wsl.exe', args: ['-d', 'Ubuntu'] });
    expect(debian).toMatchObject({ file: 'wsl.exe', args: ['-d', 'Debian'] });
  });

  it('uses $SHELL on unix', async () => {
    setPlatform('linux');
    process.env.SHELL = '/usr/bin/zsh';

    const shells = await detectShells();
    const zsh = shells.find((s) => s.file === '/usr/bin/zsh');
    expect(zsh).toBeDefined();
    expect(zsh?.args).toEqual(['-l']);
  });

  it('never returns an empty list (falls back to a default shell)', async () => {
    setPlatform('linux');
    delete process.env.SHELL;
    const shells = await detectShells();
    expect(shells.length).toBeGreaterThan(0);
  });
});

describe('targetForShell', () => {
  it('maps a wsl.exe shell to its distro target', async () => {
    expect(targetForShell({ file: 'wsl.exe', args: ['-d', 'Ubuntu'] })).toEqual({ kind: 'wsl', distro: 'Ubuntu' });
    expect(targetForShell({ file: 'C:\\Windows\\System32\\wsl.exe', args: ['--distribution', 'Debian'] })).toEqual({
      kind: 'wsl',
      distro: 'Debian',
    });
  });

  it('treats Git Bash / PowerShell / cmd / null as the host (uses Windows runtimes)', async () => {
    expect(targetForShell({ file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-i', '-l'] })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'powershell.exe', args: ['-NoLogo'] })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'cmd.exe' })).toEqual({ kind: 'host' });
    expect(targetForShell(null)).toEqual({ kind: 'host' });
    expect(targetForShell(undefined)).toEqual({ kind: 'host' });
  });

  it('falls back to host when wsl.exe carries no distro', async () => {
    expect(targetForShell({ file: 'wsl.exe' })).toEqual({ kind: 'host' });
    expect(targetForShell({ file: 'wsl.exe', args: [] })).toEqual({ kind: 'host' });
  });
});
