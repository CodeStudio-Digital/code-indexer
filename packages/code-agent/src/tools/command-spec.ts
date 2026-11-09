export type CommandSpec = { kind: 'argv'; executable: string; args: string[] }
  | { kind: 'shell'; script: string; shell: 'cmd' | 'powershell' | 'pwsh' | 'sh' | 'bash' };

export function commandSpec(raw: unknown, legacy: unknown): CommandSpec {
  if (raw !== undefined && legacy !== undefined) throw new Error('Provide command or cmd, not both');
  if (raw === undefined) {
    if (typeof legacy === 'string' && !legacy.trim()) throw new Error('cmd cannot be empty');
    if (typeof legacy !== 'string' || !legacy.trim()) throw new Error('cmd is required (or provide command with an argv/shell CommandSpec)');
    raw = { kind: 'shell', script: legacy, shell: process.platform === 'win32' ? 'cmd' : 'sh' };
  }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid CommandSpec');
  const c = raw as Record<string, unknown>;
  if (c.kind === 'argv' && typeof c.executable === 'string' && c.executable.trim()
    && c.executable.length <= 32768
    && Array.isArray(c.args) && c.args.length <= 1024 && c.args.every(a => typeof a === 'string' && a.length <= 65536 && !a.includes('\0'))
    && !c.executable.includes('\0') && Buffer.byteLength(JSON.stringify(c.args)) <= 1024 * 1024) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(c.executable)) throw new Error('Windows batch files require an explicit shell CommandSpec.');
    return { kind: 'argv', executable: c.executable, args: c.args as string[] };
  }
  if (c.kind === 'shell' && typeof c.script === 'string' && c.script.trim() && c.script.length <= 1024 * 1024 && !c.script.includes('\0')
    && ['cmd','powershell','pwsh','sh','bash'].includes(String(c.shell))) return c as CommandSpec;
  throw new Error('Invalid command: use argv {executable,args} or shell {script,shell}');
}
export function commandLaunch(spec: CommandSpec): { executable: string; args: string[] } {
  if (spec.kind === 'argv') return spec;
  if (spec.shell === 'cmd') return { executable: 'cmd.exe', args: ['/d','/s','/c',spec.script] };
  if (spec.shell === 'powershell' || spec.shell === 'pwsh') return { executable: spec.shell === 'powershell' ? 'powershell.exe' : 'pwsh', args: ['-NoLogo','-NoProfile','-NonInteractive','-Command',spec.script] };
  return { executable: spec.shell === 'sh' ? '/bin/sh' : 'bash', args: ['-c',spec.script] };
}
export function commandDisplay(spec: CommandSpec): string {
  return spec.kind === 'shell' ? spec.script : [JSON.stringify(spec.executable), ...spec.args.map(arg => JSON.stringify(arg))].join(' ');
}
