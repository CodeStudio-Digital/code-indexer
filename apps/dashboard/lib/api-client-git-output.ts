

interface GitExecutionResult {
  command?: string;
  args?: string[];
  ok?: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  sha?: string;
  durationMs?: number;
  results?: GitExecutionResult[];
  aborted?: boolean;
}

export function gitOperationLabel(path: string): string {
  const method = path.slice('projectGit.'.length);
  const words = method.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `Git · ${words}`;
}

export function gitCommand(path: string, result?: unknown): string {
  const value = result && typeof result === 'object' ? result as GitExecutionResult : undefined;
  if (value?.command) return [value.command, ...(value.args ?? [])].join(' ');
  return path;
}

export function withTerminalEol(value: string): string {
  if (!value) return '';
  const normalized = value.replace(/\r?\n/g, '\r\n');
  return normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
}

export function formatGitExecution(path: string, result: unknown): {
  command: string;
  status: 'succeeded' | 'failed';
  output: string;
} {
  const value = result && typeof result === 'object' ? result as GitExecutionResult : undefined;
  const command = gitCommand(path, result);
  const nestedFailed = value?.results?.some((entry) => entry.ok === false || (entry.code != null && entry.code !== 0));
  const failed = value?.ok === false
    || (typeof value?.code === 'number' && value.code !== 0)
    || value?.aborted === true
    || nestedFailed === true;
  let output = `$ ${command}\r\n`;
  if (value?.results?.length) {
    for (const entry of value.results) {
      const nestedCommand = gitCommand(path, entry);
      output += `\r\n$ ${nestedCommand}\r\n`;
      if (entry.stdout) output += withTerminalEol(entry.stdout);
      if (entry.stderr) {
        if (entry.stdout) output += '\r\n[stderr]\r\n';
        output += withTerminalEol(entry.stderr);
      }
      if (!entry.stdout && !entry.stderr && entry.code != null) {
        output += `[process exited code=${entry.code}]\r\n`;
      }
    }
    if (value.aborted) output += '\r\n[operation aborted]\r\n';
  }
  if (value?.stdout) output += withTerminalEol(value.stdout);
  if (value?.stderr) {
    if (value.stdout) output += '\r\n[stderr]\r\n';
    output += withTerminalEol(value.stderr);
  }
  if (!value?.results?.length && !value?.stdout && !value?.stderr) {
    if (value?.sha) output += `commit ${value.sha}\r\n`;
    else if (typeof value?.code === 'number') output += `[process exited code=${value.code}]\r\n`;
    else output += '[completed successfully]\r\n';
  }
  if (value?.durationMs != null) output += `[duration ${value.durationMs} ms]\r\n`;
  return { command, status: failed ? 'failed' : 'succeeded', output };
}
