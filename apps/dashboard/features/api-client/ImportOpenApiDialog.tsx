/**
 * Import an OpenAPI/Swagger spec into a collection. Leaving the path empty
 * auto-detects conventional locations (openapi.yaml, docs/openapi.json, …)
 * under the project root. Re-import is idempotent and preserves verified
 * requests.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import * as api from './api.js';
import type { ImportResult } from './types.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: (collectionId: number) => void;
}

export function ImportOpenApiDialog({ projectId, open, onOpenChange, onImported }: Props) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.importOpenApi(projectId, path);
      setResult(r);
      onImported(r.collectionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Import OpenAPI</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Leave blank to auto-detect (openapi.yaml / docs/openapi.json / swagger.json …) under the project root.
        </p>
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="path/to/openapi.yaml (optional)" className="h-8 text-sm font-mono" />
        {error && <div className="text-xs text-red-500">{error}</div>}
        {result && (
          <div className="text-xs text-emerald-600">
            Imported {result.requestCount} operations — {result.created} new, {result.updated} updated.
            {result.specChanged && <span className="text-amber-500"> (spec changed since last import — verified requests kept)</span>}
            {!!result.stale && <span className="text-amber-500"> · {result.stale} removed endpoint(s) dropped from the regression battery</span>}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          <Button size="sm" disabled={busy} onClick={run} className="gap-1">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Import
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
