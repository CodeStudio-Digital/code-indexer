/**
 * ProjectLinks — "Projetos vinculados" section inside CollectionDetail.
 *
 * Linking a collection to a project scopes agent retrieval: sessions on
 * that project get the `<indexed-docs>` hint and `rag_search_docs`
 * searches linked collections first. Links with origin 'auto' were
 * created by approving a doc-source suggestion for that project.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useNotify } from '../../components/ui/dialog-provider.js';
import {
  linkCollectionToProject,
  listCollectionProjectSuggestions,
  listCollectionProjects,
  unlinkCollectionFromProject,
  type DocProjectLink,
  type DocProjectSuggestion,
} from './docs-api.js';

interface ProjectOption {
  id: number;
  name: string;
}

interface Props {
  collectionId: number;
}

export function ProjectLinks({ collectionId }: Props) {
  const { t } = useTranslation('docs');
  const notify = useNotify();
  const [links, setLinks] = useState<DocProjectLink[] | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [pickedId, setPickedId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<DocProjectSuggestion[]>([]);

  async function reload() {
    try {
      setLinks(await listCollectionProjects(collectionId));
    } catch {
      setLinks([]);
    }
    try {
      setSuggestions(await listCollectionProjectSuggestions(collectionId));
    } catch {
      setSuggestions([]);
    }
  }

  useEffect(() => {
    void reload();
  }, [collectionId]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((body: ProjectOption[]) => {
        if (!cancelled) setProjects(body ?? []);
      })
      .catch(() => {
        /* projects API unavailable — picker stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onLink() {
    if (pickedId === '') return;
    setBusy(true);
    try {
      await linkCollectionToProject(collectionId, pickedId);
      setPickedId('');
      await reload();
    } catch (e) {
      void notify({
        title: t('projectLinks.linkFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(projectId: number) {
    setBusy(true);
    try {
      await unlinkCollectionFromProject(collectionId, projectId);
      await reload();
    } catch (e) {
      void notify({
        title: t('projectLinks.unlinkFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  async function onAcceptSuggestion(suggestion: DocProjectSuggestion) {
    setBusy(true);
    try {
      await linkCollectionToProject(collectionId, suggestion.project_id, 'auto');
      await reload();
    } catch (error) {
      void notify({ title: t('projectLinks.linkFailed'), description: (error as Error).message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }

  const linkedIds = new Set((links ?? []).map((l) => l.project_id));
  const available = projects.filter((p) => !linkedIds.has(p.id));

  return (
    <section className="overflow-hidden rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
      <div className="flex h-8 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-3 text-xs font-medium">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        {t('projectLinks.heading')}
      </div>
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">{t('projectLinks.description')}</p>

      {links === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : links.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('projectLinks.empty')}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {links.map((l) => (
            <span
              key={l.project_id}
              className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
            >
              {l.project_name}
              <span className="text-[10px] text-muted-foreground">
                {l.origin === 'auto' ? t('projectLinks.originAuto') : t('projectLinks.originManual')}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                title={t('projectLinks.unlink')}
                onClick={() => void onUnlink(l.project_id)}
                disabled={busy}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium"><Sparkles className="h-3 w-3" />{t('projectLinks.suggestions')}</div>
          {suggestions.map((suggestion) => (
            <div key={suggestion.project_id} className="flex items-center justify-between gap-2 text-xs">
              <span><strong>{suggestion.project_name}</strong> · {suggestion.reason}</span>
              <Button size="sm" variant="outline" className="h-6 text-xs" disabled={busy} onClick={() => void onAcceptSuggestion(suggestion)}>
                {t('projectLinks.confirmSuggestion')}
              </Button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={pickedId}
            onChange={(e) => setPickedId(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">{t('projectLinks.pickerPlaceholder')}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => void onLink()} disabled={busy || pickedId === ''}>
            {busy ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Link2 className="h-3 w-3 mr-1" />}
            {t('projectLinks.linkButton')}
          </Button>
        </div>
      )}
      </div>
    </section>
  );
}
