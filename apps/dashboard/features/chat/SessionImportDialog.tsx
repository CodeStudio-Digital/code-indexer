import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentPreset } from '@mcp/api-bus';
import { AlertTriangle, CheckCircle2, FileInput, Loader2, Search } from 'lucide-react';
import { formatDateTime } from '../../lib/datetime.js';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { apiPost } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import type { ProviderOption } from './types.js';

type Source = 'claude-code' | 'codex';
interface Reference { source: Source; source_path: string; external_id: string; fingerprint?: string }
type PreviewReference = Omit<Reference, 'source'> & { source?: Source };
interface Candidate {
  source: Source; external_id: string; title: string; cwd: string | null; updated_at: string | null;
  source_model: string | null; source_path: string; size_bytes: number; reference: Reference;
  matches_project?: boolean; already_imported_session_id?: string | null;
}
interface Preview extends Candidate {
  fingerprint: string; has_source_summary: boolean; reference: Reference & { fingerprint: string };
  stats: { message_count: number; user_count: number; assistant_count: number; tool_call_count: number; tool_result_count: number };
  warnings: Array<{ code: string; message: string; count?: number }>;
}
interface ImportResult { session_id: string; used_fallback_summary: boolean }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  projectName: string;
  worktreePath?: string | null;
  provider: string;
  model: string;
  agent: AgentPreset;
  providerOptions: ProviderOption[];
  onImported: (sessionId: string) => void;
}

function displayDate(value: string | null): string {
  if (!value) return '—';
  return formatDateTime(value, undefined, undefined, value);
}

function errorText(error: unknown): string {
  const body = (error as { body?: { message?: unknown; error?: unknown } })?.body;
  if (typeof body?.message === 'string') return body.message;
  if (typeof body?.error === 'string') return body.error;
  return error instanceof Error ? error.message : String(error);
}

export function SessionImportDialog(props: Props) {
  const { t } = useTranslation(['chat', 'common']);
  const [source, setSource] = useState<'all' | Source>('all');
  const [query, setQuery] = useState('');
  const [currentFolderOnly, setCurrentFolderOnly] = useState(false);
  const [items, setItems] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [targetProvider, setTargetProvider] = useState(props.provider);
  const [targetModel, setTargetModel] = useState(props.model);
  const [targetAgent, setTargetAgent] = useState<AgentPreset>(props.agent);
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setTargetProvider(props.provider);
    setTargetModel(props.model);
    setTargetAgent(props.agent);
  }, [props.agent, props.model, props.open, props.provider]);

  useEffect(() => {
    if (!props.open) setPreviewing(false);
    return () => previewRequest.current?.abort();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ project_id: String(props.projectId), limit: '100' });
      if (source !== 'all') params.set('source', source);
      if (query.trim()) params.set('q', query.trim());
      if (props.worktreePath) params.set('worktree_path', props.worktreePath);
      if (currentFolderOnly) params.set('cwd_match', 'match');
      fetch(`/api/coder/session-imports/discover?${params}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{ items: Candidate[] }>;
        })
        .then((result) => { if (!controller.signal.aborted) setItems(result.items); })
        .catch((reason) => { if (!controller.signal.aborted) setError(errorText(reason)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [currentFolderOnly, props.open, props.projectId, props.worktreePath, query, source]);

  const models = useMemo(
    () => props.providerOptions.find((option) => option.id === targetProvider)?.models ?? [],
    [props.providerOptions, targetProvider],
  );
  const mismatch = Boolean(preview?.cwd && preview.matches_project === false);

  async function loadPreview(reference: PreviewReference): Promise<void> {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewing(true); setError(null); setPreview(null); setConfirmMismatch(false);
    try {
      const result = await apiPost<Preview>('/coder/session-imports/preview', {
        ...reference, project_id: props.projectId, worktree_path: props.worktreePath,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(result);
      setTitle(result.title);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorText(reason));
    } finally {
      if (!controller.signal.aborted) setPreviewing(false);
    }
  }

  async function chooseFile(): Promise<void> {
    const paths = await window.electronAPI?.openFiles?.() ?? [];
    const path = paths.find((value) => value.toLowerCase().endsWith('.jsonl'));
    if (!path) return;
    await loadPreview({ ...(source === 'all' ? {} : { source }), source_path: path, external_id: '' });
  }

  async function importSession(): Promise<void> {
    if (!preview || !targetProvider || !targetModel || (mismatch && !confirmMismatch)) return;
    setImporting(true); setError(null);
    try {
      const result = await apiPost<ImportResult>('/coder/session-imports/import', {
        project_id: props.projectId,
        worktree_path: props.worktreePath,
        ...preview.reference,
        title: title.trim() || preview.title,
        provider: targetProvider,
        model: targetModel,
        agent: targetAgent,
        allow_project_mismatch: confirmMismatch,
      });
      props.onOpenChange(false);
      props.onImported(result.session_id);
    } catch (reason) { setError(errorText(reason)); }
    finally { setImporting(false); }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('chat:sessionImport.title')}</DialogTitle>
          <DialogDescription>{t('chat:sessionImport.description', { project: props.projectName })}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <section className="min-h-0 flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Select value={source} onValueChange={(value) => setSource(value as typeof source)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('chat:sessionImport.allSources')}</SelectItem>
                  <SelectItem value="claude-code">{t('chat:sessionImport.claudeCode')}</SelectItem>
                  <SelectItem value="codex">{t('chat:sessionImport.codex')}</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative min-w-40 flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" placeholder={t('chat:sessionImport.search')} />
              </div>
              <Button variant="outline" onClick={() => void chooseFile()} disabled={!window.electronAPI?.openFiles}>
                <FileInput className="mr-2 h-4 w-4" />{t('chat:sessionImport.file')}
              </Button>
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm" title={props.worktreePath ?? undefined}>
              <input
                type="checkbox" className="size-4 accent-primary"
                checked={currentFolderOnly} onChange={(event) => setCurrentFolderOnly(event.target.checked)}
              />
              {t('chat:sessionImport.currentFolderOnly')}
            </label>
            <div className="min-h-[300px] flex-1 overflow-y-auto rounded-md border">
              {loading && <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>}
              {!loading && items.length === 0 && <div className="p-8 text-center text-sm text-muted-foreground">{t(currentFolderOnly ? 'chat:sessionImport.emptyCurrentFolder' : 'chat:sessionImport.empty')}</div>}
              {!loading && items.map((item) => (
                <div key={`${item.source}:${item.external_id}`} className="flex items-center gap-3 border-b p-3 last:border-b-0">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void loadPreview(item.reference)}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" title={item.title}>{item.title}</span>
                      <Badge variant="outline" className="shrink-0 text-[10px]">{item.source === 'claude-code' ? 'Claude' : 'Codex'}</Badge>
                      {item.matches_project && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={item.cwd ?? undefined}>{item.cwd ?? t('chat:sessionImport.unknownFolder')}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{displayDate(item.updated_at)} · {t('chat:sessionImport.kilobytes', { count: Math.ceil(item.size_bytes / 1024).toLocaleString() })}</div>
                  </button>
                  {item.already_imported_session_id ? (
                    <Button size="sm" variant="outline" onClick={() => { props.onOpenChange(false); props.onImported(item.already_imported_session_id!); }}>
                      {t('chat:sessionImport.open')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto rounded-md border p-4">
            {previewing && <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>}
            {!previewing && !preview && <div className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">{t('chat:sessionImport.select')}</div>}
            {preview && !previewing && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2"><Badge>{preview.source === 'claude-code' ? t('chat:sessionImport.claudeCode') : t('chat:sessionImport.codex')}</Badge>{preview.has_source_summary && <Badge variant="outline">{t('chat:sessionImport.handoff')}</Badge>}</div>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{preview.cwd ?? t('chat:sessionImport.unknownFolder')}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <Stat value={preview.stats.message_count} label={t('chat:sessionImport.messages')} />
                  <Stat value={preview.stats.tool_call_count} label={t('chat:sessionImport.tools')} />
                  <Stat value={preview.warnings.length} label={t('chat:sessionImport.warnings')} />
                </div>
                {preview.warnings.map((warning) => <Alert key={warning.code} variant="warning"><AlertTriangle /><AlertDescription>{warning.message}</AlertDescription></Alert>)}
                {mismatch && <Alert variant="warning"><AlertTriangle /><AlertTitle>{t('chat:sessionImport.mismatchTitle')}</AlertTitle><AlertDescription>{t('chat:sessionImport.mismatch', { project: props.worktreePath ?? props.projectName })}</AlertDescription></Alert>}
                <Field label={t('chat:sessionImport.sessionTitle')}><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} /></Field>
                <Field label={t('chat:sessionImport.provider')}>
                  <Select value={targetProvider} onValueChange={(value) => { setTargetProvider(value); const first = props.providerOptions.find((option) => option.id === value)?.models[0]; setTargetModel(first ? `${first.id}${first.mode ? `::${first.mode}` : ''}` : ''); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{props.providerOptions.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field label={t('chat:sessionImport.model')}>
                  {models.length ? <Select value={targetModel} onValueChange={setTargetModel}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{models.map((item) => { const value = `${item.id}${item.mode ? `::${item.mode}` : ''}`; return <SelectItem key={value} value={value}>{item.name || item.id}</SelectItem>; })}</SelectContent></Select> : <Input value={targetModel} onChange={(event) => setTargetModel(event.target.value)} />}
                </Field>
                <Field label={t('chat:sessionImport.agent')}>
                  <Select value={targetAgent} onValueChange={(value) => setTargetAgent(value as AgentPreset)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['explore', 'plan', 'build', 'admin'] as AgentPreset[]).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                </Field>
                {mismatch && <label className="flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={confirmMismatch} onChange={(event) => setConfirmMismatch(event.target.checked)} /><span>{t('chat:sessionImport.confirmMismatch')}</span></label>}
              </div>
            )}
          </section>
        </div>
        {error && <Alert variant="destructive"><AlertTriangle /><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>{t('common:actions.cancel')}</Button>
          <Button onClick={() => void importSession()} disabled={!preview || !targetModel || importing || (mismatch && !confirmMismatch)}>
            {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('chat:sessionImport.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="text-xs font-medium text-muted-foreground">{label}</span>{children}</label>;
}

function Stat({ value, label }: { value: number; label: string }) {
  return <div className={cn('rounded-md bg-muted/50 p-2')}><div className="font-mono text-sm font-semibold">{value}</div><div className="text-[10px] text-muted-foreground">{label}</div></div>;
}
