import type { FsToolCallRecord } from './types.js';

const READ_TOOLS = new Set(['read_file', 'get_file_skeleton', 'view_image']);
const WRITE_TOOLS = new Set(['create_file', 'edit_file', 'multi_edit', 'write_file', 'apply_patch']);

function pathsFromArgs(call: FsToolCallRecord): string[] {
  const args = call.args as Record<string, unknown>;
  const direct = args.path ?? args.file_path;
  if (typeof direct === 'string' && direct) return [direct];
  const raw = typeof args._raw === 'string' ? args._raw : typeof args.input === 'string' ? args.input : '';
  return raw
    ? [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)].map(match => match[1].trim())
    : [];
}

function commandFromArgs(call: FsToolCallRecord): string {
  const args = call.args as Record<string, unknown>;
  const command = args.command ?? args.cmd ?? args.script;
  return typeof command === 'string' ? command.trim() : '';
}

/** Latest tool effects, with changed files taking precedence over reads. */
export function driveFileMap(calls: FsToolCallRecord[]): { read: string[]; changed: string[] } {
  const read = new Set<string>();
  const changed = new Set<string>();
  for (const call of calls.slice().reverse()) {
    const target = WRITE_TOOLS.has(call.tool_name) ? changed : READ_TOOLS.has(call.tool_name) ? read : null;
    if (!target) continue;
    for (const path of pathsFromArgs(call)) target.add(path);
  }
  for (const path of changed) read.delete(path);
  return { read: [...read].slice(0, 200), changed: [...changed].slice(0, 200) };
}

export function driveCommandTrail(
  calls: FsToolCallRecord[],
  limit: number,
): Array<{ command: string; isError: boolean }> {
  return calls
    .filter(call => call.tool_name === 'run_command' || call.tool_name === 'exec_command')
    .slice(-Math.max(0, limit))
    .map(call => ({ command: commandFromArgs(call), isError: call.is_error }))
    .filter(item => item.command.length > 0);
}
