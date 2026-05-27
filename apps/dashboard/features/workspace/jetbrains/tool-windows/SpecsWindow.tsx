/**
 * Specs tool window — lists every `.mcp/specs/*.md` of the active project.
 *
 * Each spec row shows: name (derived from filename), status badge
 * (draft/approved/implemented from `<!-- sdd:status=... -->` header), and
 * the timestamp parsed from the slug-<unix>.md filename. Click opens the
 * spec in the editor pane via `onOpen`.
 *
 * No write surface here — specs are authored by the agent (`submit_spec`)
 * and approved via the SpecPromptView card in the chat. This window is
 * read-only discovery + opening for review.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';
import { cn } from '../../../../lib/utils.js';

interface SpecsWindowProps {
  projectId: number;
  onOpen: (path: string) => void;
  onClose?: () => void;
}

type SpecStatus = 'draft' | 'approved' | 'implemented';

interface SpecEntry {
  path: string;          // repo-relative — '.mcp/specs/<slug>-<unix>.md'
  filename: string;      // '<slug>-<unix>.md'
  displayName: string;   // slug humanized
  unix: number | null;   // timestamp parsed from filename, null when not present
  status: SpecStatus;
}

interface TreeNode {
  path: string;
  name?: string;
  isDir?: boolean;
  children?: TreeNode[];
}

const STATUS_BADGE: Record<SpecStatus, { label: string; cn: string }> = {
  draft: { label: 'draft', cn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  approved: { label: 'approved', cn: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  implemented: { label: 'shipped', cn: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
};

const STATUS_HEADER = /<!--\s*sdd:status=(draft|approved|implemented)\s*-->/i;
const FILENAME_PARTS = /^(.+)-(\d{8,12})\.md$/;

function parseFilename(filename: string): { displayName: string; unix: number | null } {
  const m = FILENAME_PARTS.exec(filename);
  if (!m) {
    return { displayName: filename.replace(/\.md$/, ''), unix: null };
  }
  const slug = m[1];
  const unix = Number(m[2]);
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { displayName, unix: Number.isFinite(unix) ? unix : null };
}

async function loadSpecs(projectId: number): Promise<SpecEntry[]> {
  let tree: TreeNode;
  try {
    tree = await apiCall<TreeNode>('files.tree', { projectId, root: '.mcp/specs' });
  } catch {
    // Directory doesn't exist yet — equivalent to "no specs".
    return [];
  }
  const children = Array.isArray(tree?.children) ? tree.children : [];
  const mdNodes = children.filter((n) => !n.isDir && n.path.toLowerCase().endsWith('.md'));

  const out: SpecEntry[] = await Promise.all(
    mdNodes.map(async (node) => {
      const filename = node.name ?? node.path.split('/').pop() ?? node.path;
      const { displayName, unix } = parseFilename(filename);
      let status: SpecStatus = 'draft';
      try {
        const file = await apiCall<{ content: string }>('files.read', {
          projectId,
          path: node.path,
        });
        const header = file?.content?.slice(0, 500) ?? '';
        const match = STATUS_HEADER.exec(header);
        if (match) status = match[1].toLowerCase() as SpecStatus;
      } catch {
        // Treat unreadable specs as draft — surfaces them anyway so the user can debug.
      }
      return { path: node.path, filename, displayName, unix, status };
    }),
  );

  // Newest first by unix timestamp; specs without a timestamp fall to the bottom.
  return out.sort((a, b) => (b.unix ?? -1) - (a.unix ?? -1));
}

function formatRelative(unix: number | null): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return d.toLocaleString();
}

export function SpecsWindow({ projectId, onOpen, onClose }: SpecsWindowProps) {
  const [items, setItems] = useState<SpecEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const list = await loadSpecs(projectId);
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <ToolWindowFrame title="Specs" onClose={onClose}>
      <div className="h-full overflow-y-auto">
        {items === null && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">Loading…</div>
        )}
        {error && <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>}
        {items?.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground space-y-2">
            <ScrollText className="h-5 w-5 mx-auto text-muted-foreground/50" />
            <p>No specs yet.</p>
            <p className="text-[10px]">
              Start a chat in <span className="font-medium text-foreground">Spec</span> mode and the
              agent will write one to <code className="font-mono">.mcp/specs/</code>.
            </p>
          </div>
        )}
        {items?.map((spec) => {
          const badge = STATUS_BADGE[spec.status];
          return (
            <button
              key={spec.path}
              type="button"
              onClick={() => onOpen(spec.path)}
              className={cn(
                'w-full text-left px-2.5 py-1.5 border-b last:border-b-0',
                'hover:bg-muted/40 transition-colors flex flex-col gap-0.5',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-foreground font-medium truncate flex-1">
                  {spec.displayName}
                </span>
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
                    badge.cn,
                  )}
                >
                  {badge.label}
                </span>
              </div>
              <span className="text-[10.5px] text-muted-foreground truncate font-mono">
                {spec.path}
                {spec.unix ? ` · ${formatRelative(spec.unix)}` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </ToolWindowFrame>
  );
}
