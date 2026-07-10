/**
 * Local database discovery for App Studio workspaces.
 *
 * D1 local state is owned by Wrangler/Miniflare under
 * `.wrangler/state/v3/d1/**.sqlite`. The preview and the App Studio data tab
 * read this same file.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function findLocalD1File(workspaceDir: string): string | null {
  const base = join(workspaceDir, '.wrangler', 'state', 'v3', 'd1');
  if (!existsSync(base)) return null;
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.name.endsWith('.sqlite')) return abs;
    }
  }
  return null;
}
