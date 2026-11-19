/** Plain documentation is reviewed as prose; it does not invalidate code checks.
 * Embedded docs, prompts, MDX, config and unknown paths stay conservative. */
export function isPlainDocumentationPath(value: string): boolean {
  const path = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || /[:\x00-\x1f]/.test(path)) return false;
  const parts = path.toLowerCase().split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  if (parts.some(p => /^(?:src|source|app|apps|packages|lib|test|tests|fixtures|prompts)$/.test(p))) return false;
  if (/^(?:agents|skill)\.md$/i.test(parts.at(-1)!)) return false;
  if (parts.length === 1) return /\.(?:md|rst)$/.test(path.toLowerCase());
  return /^(?:docs?|documentation|reports?|notes)$/.test(parts[0]) && /\.(?:md|rst|txt)$/.test(parts.at(-1)!);
}

export function isDocumentationOnlyWrite(name: string, args: Record<string, unknown>): boolean {
  let paths: unknown[];
  if (name === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : typeof args._raw === 'string' ? args._raw : '';
    paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map(m => m[1].trim());
  } else if (['write_file', 'create_file', 'edit_file', 'multi_edit'].includes(name)) {
    paths = [args.path ?? args.file_path];
  } else return false;
  return paths.length > 0 && paths.every(p => typeof p === 'string' && isPlainDocumentationPath(p));
}

/** Explicit documentation checks must be rerun after documentation changes. */
export function validationTargetsDocumentation(command: string): boolean {
  return /(?:^|[\s:/_\\-])(?:docs?|documentation|markdownlint)(?:$|[\s:/_\\-])|\.(?:md|rst|mdx)(?:[\s"']|$)|\(documentation\)/i.test(command);
}
