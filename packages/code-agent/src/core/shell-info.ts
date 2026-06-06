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
      'win32 (Windows). The shell for run_command / exec_command is **cmd.exe**, ' +
      'NOT bash. Use Windows commands: `dir` (not ls), `type` (not cat), ' +
      '`findstr` (not grep), `where` (not which). Unix pipes like `| head` / ' +
      '`| tail` DO NOT EXIST in cmd — the tool already truncates output, so omit ' +
      'them. `&&` chaining and `cmd1 & cmd2` work. For anything beyond a simple ' +
      'command (loops, redirects, env logic), call PowerShell explicitly: ' +
      '`powershell -NoProfile -Command "..."`. Feed multi-line scripts via the ' +
      '`stdin` param instead of inline quoting.'
    );
  }
  const name = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
  return (
    `${name}. The shell for run_command is /bin/bash (exec_command uses /bin/sh) — ` +
    'standard POSIX tools (grep, head, tail, sed, awk, find) are available.'
  );
}
