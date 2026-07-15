/**
 * Pure WSL path helpers — deterministic managed bin dir (no distro probe at
 * spawn) and the Windows→/mnt translation used to hand a downloaded archive to
 * the distro's tar.
 */
import { describe, expect, it } from 'vitest';
import { interactiveInvocation, posixExportPrefix } from '../../terminal/pty-manager.js';
import { toWslMntPath, wslBinDirForId, wslManagedBinDir, wslManagedDir } from '../wsl-paths.js';

describe('wsl-paths', () => {
  it('builds the managed dir + bin dir with a literal $HOME', () => {
    expect(wslManagedDir('node', '20.11.0')).toBe('$HOME/.mcp/runtimes/node/20.11.0');
    expect(wslManagedBinDir('python', '3.12.3')).toBe('$HOME/.mcp/runtimes/python/3.12.3/bin');
    expect(wslManagedBinDir('dotnet', '10.0.301')).toBe('$HOME/.mcp/runtimes/dotnet/10.0.301');
  });

  it('resolves a managed:<version> id to its bin dir, else null', () => {
    expect(wslBinDirForId('node', 'managed:20.11.0')).toBe('$HOME/.mcp/runtimes/node/20.11.0/bin');
    expect(wslBinDirForId('node', 'system')).toBeNull();
    expect(wslBinDirForId('node', null)).toBeNull();
    expect(wslBinDirForId('node', undefined)).toBeNull();
    expect(wslBinDirForId('node', 'homebrew:20')).toBeNull(); // non-managed → distro default
  });

  it('translates a Windows temp path to /mnt for the distro', () => {
    expect(toWslMntPath('C:\\Users\\me\\AppData\\Local\\Temp\\x.tar.gz')).toBe('/mnt/c/Users/me/AppData/Local/Temp/x.tar.gz');
    expect(toWslMntPath('D:/data/y.tgz')).toBe('/mnt/d/data/y.tgz');
    expect(toWslMntPath('/already/posix')).toBe('/already/posix');
  });
});

describe('posixExportPrefix', () => {
  it('is empty with no injection', () => {
    expect(posixExportPrefix([], {})).toBe('');
  });

  it('prepends the managed bin dirs to PATH inside double quotes ($HOME expands)', () => {
    expect(posixExportPrefix(['$HOME/.mcp/runtimes/node/20.11.0/bin'], {})).toBe(
      `export PATH="$HOME"'/.mcp/runtimes/node/20.11.0/bin':"$PATH"; `,
    );
  });

  it('exports extra env (single-quoted) before PATH', () => {
    expect(posixExportPrefix(['/a/bin'], { FOO: 'bar' })).toBe(`export FOO='bar'; export PATH='/a/bin':"$PATH"; `);
  });

  it('expands HOME only for the managed prefix and quotes shell syntax elsewhere', () => {
    expect(posixExportPrefix([], { JAVA_HOME: '$HOME/.mcp/runtimes/java/21.0.7', VALUE: '$(touch nope)' })).toBe(
      `export JAVA_HOME="$HOME"'/.mcp/runtimes/java/21.0.7'; export VALUE='$(touch nope)'; `,
    );
  });

  it('injects the runtime environment into interactive WSL terminals', () => {
    const got = interactiveInvocation('wsl.exe', ['-d', 'Ubuntu'], {
      prepend: ['$HOME/.mcp/runtimes/dotnet/10.0.301'],
      env: { DOTNET_ROOT: '$HOME/.mcp/runtimes/dotnet/10.0.301' },
    });
    expect(got.file).toBe('wsl.exe');
    expect(got.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc']);
    expect(got.args[5]).toContain('export DOTNET_ROOT="$HOME"');
    expect(got.args[5]).toContain('exec "${SHELL:-/bin/bash}" -il');
  });
});
