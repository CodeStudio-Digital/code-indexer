import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
import { MEMORY_TYPES, type CuratedMemory } from './agent-memory-types.js';

export function AgentMemoryForm({ projectId, memoryId, onClose, onSaved, onOpenRelated }: {
  projectId: number; memoryId: number | null; onClose: () => void; onSaved: () => void; onOpenRelated?: (id: number) => void;
}) {
  const { t } = useTranslation('projects');
  const { data, loading, error, refetch } = useApi<CuratedMemory & { content: string }>(memoryId == null ? '' : `/agent-memory/${memoryId}`);
  const [draft, setDraft] = useState<Partial<{ name: string; description: string; type: string; content: string }>>({});
  const name = draft.name ?? data?.name ?? '', description = draft.description ?? data?.description ?? '';
  const type = draft.type ?? data?.type ?? 'note', content = draft.content ?? data?.content ?? '';
  const setName = (name: string) => setDraft(current => ({ ...current, name }));
  const setDescription = (description: string) => setDraft(current => ({ ...current, description }));
  const setType = (type: string) => setDraft(current => ({ ...current, type }));
  const setContent = (content: string) => setDraft(current => ({ ...current, content }));
  const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState<string | null>(null);
  const readOnly = data?.archived_at != null;
  const pending = memoryId != null && (loading || !data);
  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), type, content: content.trim() };
      if (memoryId == null) await apiPost(`/projects/${projectId}/agent-memory`, body);
      else await apiPut(`/agent-memory/${memoryId}`, body);
      onSaved(); onClose();
    } catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  const field = 'w-full rounded border bg-background px-2 py-1.5 text-xs';
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t(memoryId == null ? 'memory.curation.create' : 'memory.curation.edit')}</DialogTitle><DialogDescription>{t('memory.curation.formHint')}</DialogDescription></DialogHeader>
      {(error || saveError) && <p role="alert" className="text-xs text-destructive">{error || saveError}{error && <button type="button" onClick={refetch} className="ml-2 underline">{t('memory.curation.retry')}</button>}</p>}
      {pending && !error ? <p className="text-xs">{t('memory.curation.loading')}</p> : <div className="space-y-3">
        {readOnly && <p className="text-xs text-muted-foreground">{t('memory.curation.readOnly')}</p>}
        {readOnly && data?.superseded_by_id && onOpenRelated && <Button size="sm" variant="outline" onClick={() => onOpenRelated(data.superseded_by_id!)}>{t('memory.archive.current')}</Button>}
        <label className="block text-xs space-y-1">{t('memory.curation.name')}<input aria-label={t('memory.curation.name')} className={field} value={name} maxLength={240} disabled={readOnly || saving} onChange={event => setName(event.target.value)} /></label>
        <label className="block text-xs space-y-1">{t('memory.curation.description')}<input aria-label={t('memory.curation.description')} className={field} value={description} maxLength={500} disabled={readOnly || saving} onChange={event => setDescription(event.target.value)} /></label>
        <label className="block text-xs space-y-1">{t('memory.curation.type')}<select aria-label={t('memory.curation.type')} className={field} value={type} disabled={readOnly || saving} onChange={event => setType(event.target.value)}>{MEMORY_TYPES.map(value => <option key={value} value={value}>{t(`memory.category.${value}`, value)}</option>)}</select></label>
        <label className="block text-xs space-y-1">{t('memory.curation.content')}<textarea aria-label={t('memory.curation.content')} className={`${field} min-h-48 whitespace-pre-wrap`} rows={12} value={content} maxLength={100_000} disabled={readOnly || saving} onChange={event => setContent(event.target.value)} /></label>
        {data?.source_snapshot_id != null && <p className="text-xs text-muted-foreground">{t('memory.curation.legacySource', { id: data.source_snapshot_id })}</p>}
      </div>}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={saving}>{t('memory.curation.close')}</Button>{!readOnly && <Button onClick={save} disabled={saving || pending || !!error || !name.trim() || !content.trim()}>{t(saving ? 'memory.curation.saving' : 'memory.curation.save')}</Button>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
