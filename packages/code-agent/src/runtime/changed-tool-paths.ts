import { parseApplyPatch } from '../tools/apply-patch.js';

/** Index/preview hints only; paths must still pass the workspace resolver. */
export function changedToolPaths(name: string, args: Readonly<Record<string, unknown>>): string[] {
  if (name === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : typeof args._raw === 'string' ? args._raw : '';
    try {
      return [...new Set(parseApplyPatch(patch).actions.flatMap(action =>
        action.kind === 'update' && action.movePath ? [action.path, action.movePath] : [action.path]))];
    } catch { return []; }
  }
  if (!['write_file', 'create_file', 'edit_file', 'multi_edit', 'manage_path'].includes(name)) return [];
  const paths = [args.path ?? args.file_path];
  if (name === 'manage_path') paths.push(args.from_path, args.to_path);
  return [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0))];
}
