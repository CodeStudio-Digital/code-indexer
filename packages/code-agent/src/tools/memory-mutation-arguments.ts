import type { MemoryMutationTool } from '../ports/memory-mutation-port.js';
import { parseProjectMemoryInput } from '@mcp/shared/memory-write.js';

export const MEMORY_TYPES = ['preference', 'convention', 'procedure', 'architecture', 'gotcha', 'external_pointer', 'pattern', 'decision', 'note'] as const;
const categories: Record<string, string> = { decision: 'decision', convention: 'convention', procedure: 'procedure',
  architecture: 'architecture', gotcha: 'gotcha', pattern: 'pattern', note: 'note', preference: 'feedback', external_pointer: 'note' };
export function memoryMutationArguments(tool: MemoryMutationTool, args: Record<string, unknown>) {
  if (tool === 'mcp__save_memory') return { scope: 'project' as const, entry: parseProjectMemoryInput(args) };
  if (args.scope !== undefined && args.scope !== 'project' && args.scope !== 'user') throw new Error('Memory scope must be project or user');
  const scope = args.scope === 'user' ? 'user' as const : 'project' as const;
  if (tool === 'forget_memory') {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    if (!target || target.length > 512) throw new Error('forget_memory: target must contain 1-512 characters');
    return { scope, target };
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!title || title.length > 512 || !content || content.length > 64_000) throw new Error('remember: title must contain 1-512 and content 1-64000 characters');
  if (args.type !== undefined && !MEMORY_TYPES.includes(args.type as typeof MEMORY_TYPES[number])) throw new Error('remember: invalid memory type');
  return { scope, entry: { title, content, category: scope === 'user' ? 'feedback' : categories[args.type as string ?? 'note'] } };
}
