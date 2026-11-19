/**
 * Dynamic shell descriptor injected into the system prompt (the `{{os}}`
 * line) and referenced by run_command's param docs.
 *
 * WHY: telemetry showed run_command failing ~69% of the time on Windows —
 * the model kept emitting Unix idioms (`head`, `grep`, `cat`, `| tail`,
 * `which`) because the prompt only said "OS: win32" with no shell and no
 * constraints. The shells actually used are:
 *   - run_command  → cmd.exe on Windows, /bin/bash on POSIX (ports/shell-port.ts:133-135)
 *   - exec_command → cmd.exe on Windows, /bin/sh  on POSIX (tools/exec-command.ts:237)
 * So we derive the real shell from `process.platform` at call time and tell
 * the model exactly what it has + what NOT to reach for. Pure + deterministic;
 * the platform is injectable so tests cover both branches.
 */

/** One-line shell label for the run_command param hint. */
export function shellLabel(platform: string = process.platform): string {
  return platform === 'win32' ? 'cmd.exe (Windows)' : '/bin/bash (POSIX)';
}

/**
 * Rich shell descriptor for the system prompt's `- OS:` bullet. Starts with
 * the raw platform (so the line stays accurate) then the shell + the concrete
 * do/don't list that actually trips models up.
 */
export function describeShell(platform: string = process.platform): string {
  if (platform === 'win32') {
    return (
      'win32 (Windows). Default shell: cmd.exe. Use cmd syntax (%VAR%, findstr, no `| head`) or select powershell/pwsh explicitly for PowerShell syntax. ' +
      'For exec_command, launch executables with argv. Windows .cmd and .bat launchers require command:{kind:"shell",shell:"cmd",script:"..."}.'
    );
  }
  const name = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  return (
    `${name}. The shell for run_command is /bin/bash (exec_command uses /bin/sh) — ` +
    'standard POSIX tools (grep, head, tail, sed, awk, find) are available.'
  );
}
