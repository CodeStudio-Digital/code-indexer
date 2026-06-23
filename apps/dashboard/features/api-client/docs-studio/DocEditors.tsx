/**
 * Collection-level doc editors for the Docs Studio: Overview (markdown),
 * Branding (name/accent/logo), and a Guide page editor (title + markdown). The
 * markdown surfaces reuse MarkdownEditor (edit/preview/split + toolbar); save on
 * blur via the studio hook.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownEditor } from './MarkdownEditor.js';
import type { ApiCollection, ApiDocPage } from '../types.js';
import type { CollectionDocPatch } from './docs-studio-api.js';

function EditorHeader({ title }: { title: string }) {
  return <div className="h-8 shrink-0 px-3 flex items-center border-b text-xs font-medium text-muted-foreground">{title}</div>;
}

export function OverviewEditor({ collection, onSave }: { collection: ApiCollection; onSave: (p: CollectionDocPatch) => void }) {
  const { t } = useTranslation('apiClient');
  const [v, setV] = useState(collection.overview_md ?? '');
  useEffect(() => { setV(collection.overview_md ?? ''); }, [collection.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="h-full flex flex-col">
      <EditorHeader title={t('docs.overviewTitle')} />
      <div className="flex-1 min-h-0 p-2"><MarkdownEditor value={v} editorId={`overview:${collection.id}`} placeholder={t('docs.overviewPlaceholder')} onChange={setV} onBlur={() => onSave({ overview_md: v })} /></div>
    </div>
  );
}

interface Branding { name?: string; accent?: string; logoDataUri?: string; links?: { label: string; url: string }[] }

export function BrandingEditor({ collection, onSave }: { collection: ApiCollection; onSave: (p: CollectionDocPatch) => void }) {
  const { t } = useTranslation('apiClient');
  const [b, setB] = useState<Branding>(() => parse(collection.branding_json));
  useEffect(() => { setB(parse(collection.branding_json)); }, [collection.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: Branding) => { setB(next); onSave({ branding_json: JSON.stringify(next) }); };
  const onLogo = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => commit({ ...b, logoDataUri: String(reader.result) });
    reader.readAsDataURL(file);
  };

  return (
    <div className="h-full flex flex-col">
      <EditorHeader title={t('docs.brandingTitle')} />
      <div className="p-4 space-y-3 text-xs overflow-auto">
        <label className="block">
          <span className="text-muted-foreground">{t('docs.brandName')}</span>
          <input value={b.name ?? ''} onChange={(e) => setB({ ...b, name: e.target.value })} onBlur={() => commit(b)}
            placeholder={collection.name} className="mt-1 w-full bg-background border rounded px-2 py-1" />
        </label>
        <label className="block">
          <span className="text-muted-foreground">{t('docs.accent')}</span>
          <input type="color" value={b.accent ?? '#6366f1'} onChange={(e) => commit({ ...b, accent: e.target.value })} className="mt-1 block h-7 w-16 bg-background border rounded" />
        </label>
        <div>
          <span className="text-muted-foreground">{t('docs.logo')}</span>
          <div className="mt-1 flex items-center gap-2">
            {b.logoDataUri && <img src={b.logoDataUri} alt="" className="h-8 w-8 rounded object-contain border" />}
            <input type="file" accept="image/*" onChange={(e) => onLogo(e.target.files?.[0])} className="text-[11px]" />
            {b.logoDataUri && <button type="button" className="text-muted-foreground hover:text-red-500" onClick={() => commit({ ...b, logoDataUri: undefined })}>{t('docs.removeLogo')}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function GuidePageEditor({ page, onSave }: { page: ApiDocPage; onSave: (pid: number, body: { title?: string; body_md?: string }) => void }) {
  const { t } = useTranslation('apiClient');
  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState(page.body_md);
  useEffect(() => { setTitle(page.title); setBody(page.body_md); }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 px-3 flex items-center border-b">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => onSave(page.id, { title })}
          placeholder={t('docs.guideTitlePlaceholder')} className="flex-1 bg-transparent text-xs font-medium focus:outline-none" />
      </div>
      <div className="flex-1 min-h-0 p-2"><MarkdownEditor value={body} editorId={`guide:${page.id}`} placeholder={t('docs.guideBodyPlaceholder')} onChange={setBody} onBlur={() => onSave(page.id, { body_md: body })} /></div>
    </div>
  );
}

function parse(json: string | null | undefined): Branding {
  if (!json) return {};
  try { return JSON.parse(json) as Branding; } catch { return {}; }
}
