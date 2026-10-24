import type { SnapshotCategory } from './types.js';

export interface LiteralMemoryEntry {
  title: string;
  content: string;
  category: string;
  importance?: number;
  referencedFiles?: string[];
}
export const PROJECT_MEMORY_CATEGORIES = ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure'] as const;

/** Shared validation for the public MCP call and its owned native adapter. */
export function parseProjectMemoryInput(args: Record<string, unknown>): LiteralMemoryEntry & { category: SnapshotCategory } {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title || title.length > 512 || !content || content.length > 64_000) throw new Error('save_memory: title must contain 1-512 and content 1-64000 characters');
  if (!PROJECT_MEMORY_CATEGORIES.includes(args.category as typeof PROJECT_MEMORY_CATEGORIES[number])) throw new Error('save_memory: invalid project memory category');
  if (args.importance !== undefined && (typeof args.importance !== 'number' || !Number.isFinite(args.importance)
    || args.importance < 0 || args.importance > 1)) throw new Error('save_memory: importance must be between 0 and 1');
  if (args.referenced_files !== undefined && (!Array.isArray(args.referenced_files) || args.referenced_files.length > 256
    || args.referenced_files.some(path => typeof path !== 'string' || !path.trim() || path.length > 1024
      || /[\u0000-\u001f]/.test(path) || /^(?:[a-z]:|[\\/])/i.test(path.trim())
      || path.trim().replaceAll('\\', '/').split('/').includes('..')))) throw new Error('save_memory: referenced_files must contain at most 256 project-relative paths');
  return { title, content, category: args.category as SnapshotCategory,
    importance: args.importance as number | undefined,
    referencedFiles: args.referenced_files === undefined ? undefined
      : [...new Set((args.referenced_files as string[]).map(path => path.trim().replaceAll('\\', '/')))],
  };
}
