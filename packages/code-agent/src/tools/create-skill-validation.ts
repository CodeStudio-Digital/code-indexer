export function validateSkillInput(args: Record<string, unknown>): void {
  for (const [name, limit] of [['id', 64], ['name', 256], ['description', 2000], ['prompt_body', 64000], ['slash_command', 64], ['version', 128]] as const) {
    if (args[name] !== undefined && (typeof args[name] !== 'string' || args[name].length > limit)) throw new Error(`create_skill: ${name} must be a string of at most ${limit} characters.`);
  }
  for (const name of ['trigger_paths', 'trigger_roles', 'trigger_tags', 'allowed_tools', 'tags']) {
    const value = args[name];
    const maximum = name === 'allowed_tools' ? 128 : 16;
    if (value !== undefined && (!Array.isArray(value) || value.length > maximum || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 512))) {
      throw new Error(`create_skill: ${name} must contain at most ${maximum} nonempty strings of at most 512 characters.`);
    }
  }
  if (args.scope !== undefined && args.scope !== 'global' && args.scope !== 'project') throw new Error('create_skill: invalid scope.');
  if (args.context_mode !== undefined && !['auto', 'tool', 'both'].includes(args.context_mode as string)) throw new Error('create_skill: invalid context_mode.');
  if (args.dry_run !== undefined && typeof args.dry_run !== 'boolean') throw new Error('create_skill: dry_run must be boolean.');
  if (args.sort_order !== undefined && (!Number.isSafeInteger(args.sort_order) || Math.abs(Number(args.sort_order)) > 10000)) throw new Error('create_skill: sort_order must be an integer between -10000 and 10000.');
}
