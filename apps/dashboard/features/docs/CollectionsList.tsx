/**
 * CollectionsList — left rail of the Documentação page.
 *
 * Renders each collection as a click-to-select card with chip counts, plus
 * a "Nova coleção" affordance that opens a small inline form. Delete lives
 * inside `CollectionDetail` so this list stays purely navigational.
 */
import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/utils.js';
import { createCollection, type DocCollection } from './docs-api.js';

interface Props {
  collections: DocCollection[] | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChanged: () => void | Promise<void>;
}

export function CollectionsList({ collections, selectedId, onSelect, onChanged }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createCollection({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      setShowForm(false);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Coleções
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setShowForm((v) => !v)}>
          <Plus className="h-3 w-3 mr-1" /> Nova
        </Button>
      </div>

      {showForm && (
        <Card>
          <form className="p-3 space-y-2" onSubmit={onCreate}>
            <Input
              autoFocus
              placeholder="Nome (ex: unity-docs)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
            <Textarea
              placeholder="Descrição (opcional)"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {error && <div className="text-xs text-destructive">{error}</div>}
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowForm(false);
                  setError(null);
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" size="sm" disabled={creating || !name.trim()}>
                {creating ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                Criar
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-1.5">
        {collections === null && (
          <div className="text-xs text-muted-foreground italic px-2">Carregando…</div>
        )}
        {collections?.length === 0 && (
          <div className="text-xs text-muted-foreground italic px-2">
            Nenhuma coleção ainda. Crie a primeira para começar a indexar PDFs ou URLs.
          </div>
        )}
        {collections?.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={cn(
              'w-full text-left rounded-md border px-3 py-2 transition-colors',
              selectedId === c.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-sm truncate">{c.name}</div>
              <StatusBadge status={c.status} />
            </div>
            {c.description && (
              <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{c.description}</div>
            )}
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-1">
              <span>{c.source_count} sources</span>
              <span>{c.chunk_count} chunks</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function StatusBadge({ status }: { status: DocCollection['status'] }) {
  if (status === 'indexing') {
    return (
      <Badge variant="outline" className="text-[10px]">
        <Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />
        indexing
      </Badge>
    );
  }
  if (status === 'error') {
    return (
      <Badge variant="outline" className="text-[10px] border-destructive text-destructive">
        error
      </Badge>
    );
  }
  return null;
}
