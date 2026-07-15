import { describe, expect, it } from 'vitest';
import { cmdDoubleQuote, powershellSingleQuote, quoteShellArgument, shellFamilyForExecutable, shSingleQuote } from '../shell-quote.js';

describe('shell argument quoting', () => {
  it('keeps command substitution literal in POSIX shells', () => {
    expect(shSingleQuote("src/app$(touch pwned)'s.csproj"))
      .toBe("'src/app$(touch pwned)'\\''s.csproj'");
  });

  it('keeps PowerShell subexpressions literal and doubles apostrophes', () => {
    expect(powershellSingleQuote("src/app$(calc)'s.csproj"))
      .toBe("'src/app$(calc)''s.csproj'");
  });

  it('quotes cmd metacharacters and rejects expansion-only forms', () => {
    expect(cmdDoubleQuote('src/app$(calc)&safe.csproj')).toBe('"src/app$(calc)&safe.csproj"');
    expect(() => cmdDoubleQuote('src/%PATH%.csproj')).toThrow(/cannot be represented safely/);
    expect(() => cmdDoubleQuote('src/!PATH!.csproj')).toThrow(/cannot be represented safely/);
  });

  it('dispatches by the actual shell family', () => {
    expect(quoteShellArgument("a'b", 'posix')).toBe("'a'\\''b'");
    expect(quoteShellArgument("a'b", 'powershell')).toBe("'a''b'");
    expect(quoteShellArgument("a'b", 'cmd')).toBe('"a\'b"');
  });

  it('classifies configured host and WSL shells', () => {
    expect(shellFamilyForExecutable('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell');
    expect(shellFamilyForExecutable('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellFamilyForExecutable('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(shellFamilyForExecutable('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix');
    expect(shellFamilyForExecutable('wsl.exe', true)).toBe('posix');
  });
});
