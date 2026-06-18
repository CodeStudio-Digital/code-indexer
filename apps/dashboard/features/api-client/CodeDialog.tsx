/**
 * "Code" dialog — generate a request as curl/powershell/httpie/js/python. The
 * "Resolve variables" toggle (off by default) substitutes env vars server-side;
 * an amber warning shows when the resolved snippet contains a secret.
 */
import { useEffect, useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { LazyMonaco } from './LazyMonaco.js';
import * as api from './api.js';

const TARGETS: Array<{ value: string; label: string }> = [
  { value: 'curl-bash', label: 'cURL (bash)' },
  { value: 'curl-cmd', label: 'cURL (cmd)' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'httpie', label: 'HTTPie' },
  { value: 'js-fetch', label: 'JavaScript (fetch)' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python (requests)' },
];

interface Props {
  projectId: number;
  requestId: number | null;
  envId?: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CodeDialog({ projectId, requestId, envId, open, onOpenChange }: Props) {
  const [target, setTarget] = useState('curl-bash');
  const [resolve, setResolve] = useState(false);
  const [result, setResult] = useState<api.CodegenResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || requestId == null) return;
    let cancelled = false;
    setBusy(true); setError(null);
    api.generateCode(projectId, requestId, target, resolve, envId ?? undefined)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, requestId, target, resolve, envId, projectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Generate code</DialogTitle></DialogHeader>
        <div className="flex items-center gap-3 text-xs">
          <select className="text-xs bg-background border rounded px-2 py-1" value={target} onChange={(e) => setTarget(e.target.value)}>
            {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} className="h-3.5 w-3.5" />
            Resolve variables
          </label>
          <Button size="sm" variant="ghost" className="h-6 gap-1 ml-auto" disabled={!result} onClick={() => result && navigator.clipboard?.writeText(result.code)}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </Button>
        </div>
        {result?.containsSecrets && <div className="text-[11px] text-amber-500">⚠ This snippet contains resolved secret values — don&apos;t share it.</div>}
        {error && <div className="text-xs text-red-500">{error}</div>}
        <div className="h-80 border rounded overflow-hidden relative">
          {busy && <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10"><Loader2 className="h-4 w-4 animate-spin" /></div>}
          <LazyMonaco value={result?.code ?? ''} language={result?.language ?? 'shell'} readOnly />
        </div>
      </DialogContent>
    </Dialog>
  );
}
