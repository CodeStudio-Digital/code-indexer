/**
 * Left pane: collection switcher + the active collection's request list.
 * Each request shows a method chip, a verified badge (green check when the
 * regression runner has a confirmed expected_status) and its last status.
 */
import { useState } from 'react';
import { CheckCircle2, Circle, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';
import type { ApiCollection, ApiRequest } from './types.js';

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-emerald-500', POST: 'text-amber-500', PUT: 'text-blue-500',
  PATCH: 'text-violet-500', DELETE: 'text-red-500', HEAD: 'text-muted-foreground', OPTIONS: 'text-muted-foreground',
};

function statusColor(s: number | null): string {
  if (s == null) return 'text-muted-foreground';
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

interface Props {
  collections: ApiCollection[];
  requests: ApiRequest[];
  activeCollectionId: number | null;
  activeRequestId: number | null;
  onSelectCollection: (id: number) => void;
  onSelectRequest: (id: number) => void;
  onAddCollection: (name: string) => void;
  onRemoveCollection: (id: number) => void;
  onAddRequest: (name: string) => void;
  onRemoveRequest: (id: number) => void;
}

export function CollectionList(p: Props) {
  const [newCol, setNewCol] = useState('');
  const [newReq, setNewReq] = useState('');

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-2">
        <select
          className="w-full text-xs bg-background border rounded px-2 py-1"
          value={p.activeCollectionId ?? ''}
          onChange={(e) => p.onSelectCollection(Number(e.target.value))}
        >
          {p.collections.length === 0 && <option value="">No collections</option>}
          {p.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <form
          className="flex gap-1"
          onSubmit={(e) => { e.preventDefault(); if (newCol.trim()) { p.onAddCollection(newCol.trim()); setNewCol(''); } }}
        >
          <Input value={newCol} onChange={(e) => setNewCol(e.target.value)} placeholder="New collection…" className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="outline" className="h-7 px-2"><Plus className="h-3.5 w-3.5" /></Button>
          {p.activeCollectionId != null && (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground"
              title="Delete collection" onClick={() => p.onRemoveCollection(p.activeCollectionId!)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </form>
      </div>

      <div className="flex-1 overflow-auto">
        {p.requests.map((r) => (
          <div
            key={r.id}
            onClick={() => p.onSelectRequest(r.id)}
            className={cn(
              'group flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer border-b border-border/40',
              r.id === p.activeRequestId ? 'bg-muted' : 'hover:bg-muted/50',
            )}
          >
            {r.verified
              ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
              : <Circle className="h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0" />}
            <span className={cn('font-mono font-semibold w-12 flex-shrink-0', METHOD_COLOR[r.method] ?? '')}>{r.method}</span>
            <span className="truncate flex-1">{r.name}</span>
            {r.last_status != null && <span className={cn('font-mono', statusColor(r.last_status))}>{r.last_status}</span>}
            <button
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500"
              title="Delete request"
              onClick={(e) => { e.stopPropagation(); p.onRemoveRequest(r.id); }}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {p.activeCollectionId != null && (
        <form
          className="p-2 border-t flex gap-1"
          onSubmit={(e) => { e.preventDefault(); if (newReq.trim()) { p.onAddRequest(newReq.trim()); setNewReq(''); } }}
        >
          <Input value={newReq} onChange={(e) => setNewReq(e.target.value)} placeholder="New request…" className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="outline" className="h-7 px-2"><Plus className="h-3.5 w-3.5" /></Button>
        </form>
      )}
    </div>
  );
}
