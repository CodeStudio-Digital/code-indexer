import type { OpenTab } from '../../../state/workspace.js';

function isRegularCodeFile(file: OpenTab): boolean {
  if (file.kind && file.kind !== 'file') return false;
  return !/\.(?:md|markdown|mdx|drawio)$/i.test(file.path);
}

/**
 * Monaco owns the live text after the initial load. Once both snapshots are
 * loaded, changing only `content` must not rerender the whole React editor tree
 * on every keystroke. Metadata transitions still render immediately.
 */
export function activeFileRenderEqual(a: OpenTab | null, b: OpenTab | null): boolean {
  if (a === b) return true;
  if (!a || !b || !isRegularCodeFile(a) || !isRegularCodeFile(b)) return false;
  return a.projectId === b.projectId
    && a.path === b.path
    && a.kind === b.kind
    && (a.content === null) === (b.content === null)
    && a.dirty === b.dirty
    && a.lastModified === b.lastModified
    && a.externallyChanged === b.externallyChanged;
}

/** Tab chrome needs identity/dirty metadata, never the full buffer per key. */
export function tabBarFileEqual(a: OpenTab, b: OpenTab): boolean {
  if (a === b) return true;
  if (a.projectId !== b.projectId || a.path !== b.path || a.kind !== b.kind) return false;
  if ((!a.kind || a.kind === 'file') && (!b.kind || b.kind === 'file')) {
    return (a.content === null) === (b.content === null)
      && a.dirty === b.dirty
      && a.lastModified === b.lastModified
      && a.externallyChanged === b.externallyChanged;
  }
  if (a.kind === 'sftp' && b.kind === 'sftp') {
    return a.dirty === b.dirty
      && a.remotePath === b.remotePath
      && a.hostLabel === b.hostLabel;
  }
  return false;
}
