/**
 * Host process safety for agent-authored shell commands.
 *
 * Shell tools are project-scoped by cwd, but the OS process namespace is not.
 * A command such as `Get-Process node | Stop-Process -Force` therefore escapes
 * the project boundary and can terminate the dashboard's Vite process, the
 * Electron launcher, and unrelated user workloads.  Agents may still stop a
 * process they started by its captured PID; only name/query based bulk process
 * termination is refused here.
 */

export interface UnsafeProcessCommand {
  kind: 'broad-process-kill';
  reason: string;
}

function broadKill(reason: string): UnsafeProcessCommand {
  return { kind: 'broad-process-kill', reason };
}

/** Return a refusal reason for process-name/query based termination. */
export function classifyUnsafeProcessCommand(command: string): UnsafeProcessCommand | null {
  const source = command.trim();
  if (!source) return null;

  // PowerShell: `Get-Process node | Stop-Process`, including aliases and a
  // ForEach-Object block between the query and the terminating cmdlet.
  if (/\b(?:get-process|gps)\b[^|\r\n]*\|[^;\r\n]*\b(?:stop-process|spps|kill)\b/i.test(source)) {
    return broadKill('PowerShell process-query pipeline terminates every matching process');
  }

  // PowerShell direct name selection: `Stop-Process -Name node`.  `-Id` is
  // deliberately not matched and remains the supported cleanup path.
  if (/\bstop-process\b(?:(?![;\r\n]).)*\s-(?:name|processname)\b/i.test(source)) {
    return broadKill('PowerShell Stop-Process selects processes by name');
  }

  // Other PowerShell/.NET query forms that terminate a whole name-selected
  // result set rather than one captured child PID.
  if (/\bgetprocessesbyname\s*\(/i.test(source)) {
    return broadKill('.NET GetProcessesByName selects processes outside the project boundary');
  }
  if (/\b(?:get-process|gps)\b(?:(?![;\r\n]).)*\.\s*kill\s*\(/i.test(source)) {
    return broadKill('PowerShell process query invokes Kill() on matching processes');
  }

  // Windows native name/image termination. `/PID` remains allowed.
  if (/\btaskkill(?:\.exe)?\b(?:(?![&;\r\n]).)*\/(?:im|image)\b/i.test(source)) {
    return broadKill('taskkill selects processes by image name');
  }
  if (/\bwmic\b(?:(?![&;\r\n]).)*\bprocess\b(?:(?![&;\r\n]).)*\bdelete\b/i.test(source)) {
    return broadKill('WMIC deletes a process query result set');
  }

  // POSIX name/pattern based termination. Numeric `kill <pid>` remains
  // allowed, as does terminating the exact PID returned by the spawned child.
  if (/(?:^|[;&|]\s*|\b(?:sudo|env)\s+)\b(?:pkill|killall)\b/i.test(source)) {
    return broadKill('processes are selected globally by name or pattern');
  }
  if (/\bkill\b\s+[^;\r\n]*\$\(\s*pgrep\b/i.test(source)) {
    return broadKill('kill consumes a global pgrep result set');
  }

  return null;
}

export function unsafeProcessCommandRefusal(command: string): string | null {
  const verdict = classifyUnsafeProcessCommand(command);
  if (!verdict) return null;
  return (
    `Broad process termination blocked: ${verdict.reason}. ` +
    'The shell working directory does not isolate the OS process namespace, so this could stop ' +
    'CodeStudio/Vite or unrelated user jobs. Capture the child PID and terminate only that PID ' +
    '(for example, Stop-Process -Id $child.Id or taskkill /PID <pid> /T /F).'
  );
}
