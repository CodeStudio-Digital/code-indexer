import { describe, expect, it } from 'vitest';
import { commandInvocation } from '../pty-manager.js';

describe('runner shell command invocation', () => {
  it('passes the cmd.exe command line verbatim so quotes are not literal argv bytes', () => {
    expect(commandInvocation('cmd.exe', undefined, 'php "teste.php"')).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c php "teste.php"',
    });
    expect(commandInvocation('C:\\Windows\\System32\\cmd.exe', undefined, 'python "folder with spaces\\app.py"'))
      .toEqual({
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: '/d /s /c python "folder with spaces\\app.py"',
      });
  });

  it('keeps commands as one argv entry for PowerShell and POSIX shells', () => {
    expect(commandInvocation('powershell.exe', undefined, "php 'teste.php'")).toEqual({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-Command', "php 'teste.php'"],
    });
    expect(commandInvocation('/bin/bash', undefined, "python 'app.py'")).toEqual({
      file: '/bin/bash',
      args: ['-lc', "python 'app.py'"],
    });
  });

  it('keeps WSL distro selection and the complete bash command', () => {
    expect(commandInvocation('wsl.exe', ['-d', 'Ubuntu'], "node 'app.js'", {
      prepend: ['$HOME/.mcp/bin'],
      env: {},
    })).toEqual({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--', 'bash', '-lc', 'export PATH="$HOME"\'/.mcp/bin\':"$PATH"; node \'app.js\''],
    });
  });
});
