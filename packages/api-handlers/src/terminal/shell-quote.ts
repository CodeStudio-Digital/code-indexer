export type ShellFamily = 'posix' | 'powershell' | 'cmd';

export function shellFamilyForExecutable(shellFile: string, wsl = false): ShellFamily {
  if (wsl || /wsl(?:\.exe)?$/i.test(shellFile)) return 'posix';
  if (/(?:powershell|pwsh)(?:\.exe)?$/i.test(shellFile)) return 'powershell';
  if (/cmd(?:\.exe)?$/i.test(shellFile)) return 'cmd';
  return 'posix';
}

/** Single-quote a value for a POSIX shell (handles embedded quotes). */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Expand only our literal `$HOME/…` prefix; quote every remaining byte. */
export function shValue(value: string): string {
  return value.startsWith('$HOME/')
    ? `"$HOME"${shSingleQuote(value.slice('$HOME'.length))}`
    : shSingleQuote(value);
}

/** PowerShell single-quoted literals escape an embedded quote by doubling it. */
export function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * cmd.exe has no lossless literal syntax for `%` expansion in a `/c` command.
 * Reject those rare names instead of silently turning repository data into
 * shell syntax. Other metacharacters are inert inside double quotes.
 */
export function cmdDoubleQuote(value: string): string {
  if (/["%!\r\n]/.test(value)) {
    throw new Error('argument cannot be represented safely for Command Prompt');
  }
  return `"${value}"`;
}

export function quoteShellArgument(value: string, family: ShellFamily): string {
  if (family === 'posix') return shSingleQuote(value);
  if (family === 'powershell') return powershellSingleQuote(value);
  return cmdDoubleQuote(value);
}
