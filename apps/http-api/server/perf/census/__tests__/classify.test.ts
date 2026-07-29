import { describe, it, expect } from 'vitest';
import { classifyProcess } from '../classify.js';

describe('classifyProcess', () => {
  it('recognises our own census collector before any other shell', () => {
    expect(classifyProcess('powershell.exe', 'powershell.exe -NoLogo -NoProfile -EncodedCommand JABlAA=='))
      .toEqual({ kind: 'helper', label: 'Process collector' });
  });

  it('labels terminal helper processes', () => {
    expect(classifyProcess('winpty-agent.exe', 'C:\\x\\winpty-agent.exe 80 24'))
      .toMatchObject({ kind: 'helper', label: 'Terminal helper' });
    expect(classifyProcess('conhost.exe', '\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4'))
      .toMatchObject({ kind: 'helper' });
  });

  it('extracts the git subcommand', () => {
    expect(classifyProcess('git.exe', 'git fsmonitor--daemon run --detach'))
      .toEqual({ kind: 'git', label: 'git fsmonitor--daemon' });
    expect(classifyProcess('git.exe', '"C:\\Program Files\\Git\\bin\\git.exe" status --porcelain'))
      .toEqual({ kind: 'git', label: 'git status' });
    expect(classifyProcess('git.exe', 'git --no-pager log -1'))
      .toEqual({ kind: 'git', label: 'git log' });
  });

  it('identifies language servers by binary name and by --stdio', () => {
    expect(classifyProcess('node.exe', 'node intelephense/lib/intelephense.js --stdio'))
      .toEqual({ kind: 'lsp', label: 'LSP: intelephense' });
    expect(classifyProcess('node.exe', 'node typescript-language-server --stdio'))
      .toMatchObject({ kind: 'lsp' });
    expect(classifyProcess('rust-analyzer', 'rust-analyzer'))
      .toEqual({ kind: 'lsp', label: 'LSP: rust-analyzer' });
    // Bare --stdio with no recognisable binary still lands as an LSP server.
    expect(classifyProcess('mystery.exe', 'mystery.exe --stdio'))
      .toEqual({ kind: 'lsp', label: 'LSP: mystery.exe' });
  });

  it('identifies dev servers and build helpers', () => {
    expect(classifyProcess('node.exe', 'node node_modules/.bin/vite --host'))
      .toEqual({ kind: 'devserver', label: 'Vite dev server' });
    expect(classifyProcess('node.exe', 'node next dev -p 3000'))
      .toEqual({ kind: 'devserver', label: 'Next dev server' });
    expect(classifyProcess('esbuild.exe', 'esbuild --service=0.20.0'))
      .toEqual({ kind: 'helper', label: 'Build helper: esbuild' });
  });

  it('identifies container CLIs and package scripts', () => {
    expect(classifyProcess('podman.exe', 'podman ps --format json'))
      .toMatchObject({ kind: 'sandbox' });
    expect(classifyProcess('npm.cmd', 'npm run dev'))
      .toEqual({ kind: 'runner', label: 'Script: dev' });
    expect(classifyProcess('pnpm.cmd', 'pnpm run build:electron'))
      .toEqual({ kind: 'runner', label: 'Script: build:electron' });
  });

  it('returns null for anything it cannot place', () => {
    expect(classifyProcess('svchost.exe', 'C:\\WINDOWS\\system32\\svchost.exe -k netsvcs')).toBeNull();
    expect(classifyProcess('', undefined)).toBeNull();
  });

  it('falls back to the executable when no command line was captured', () => {
    expect(classifyProcess('winpty-agent.exe', undefined)).toMatchObject({ kind: 'helper' });
  });
});
