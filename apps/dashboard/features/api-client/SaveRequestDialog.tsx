/**
 * Save-request modal — shown when saving an unsaved "Untitled" draft. Pick the
 * target collection + folder (Top level or an existing/new folder) and the name,
 * then it's persisted there.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { prompt } from '../../components/ui/prompt-dialog.js';
import * as api from './api.js';
import type { ApiCollection } from './types.js';
import { ApiClientSelect } from './ApiClientSelect.js';

interface Props {
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  collections: ApiCollection[];
  draftName: string;
  onSave: (collectionId: number, folder: string | null, name: string) => void | Promise<void>;
  onCreateCollection: (name: string) => Promise<number>;
}

export function SaveRequestDialog({ projectId, open, onOpenChange, collections, draftName, onSave, onCreateCollection }: Props) {
  const { t } = useTranslation('apiClient');
  const [name, setName] = useState(draftName);
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [folder, setFolder] = useState<string>(''); // '' = Top level
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setName(draftName || t('saveDialog.untitledRequest')); setCollectionId(collections[0]?.id ?? null); setFolder(''); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the chosen collection's effective folders (explicit + used by requests,
  // so OpenAPI-imported folders show up too).
  useEffect(() => {
    if (!open || collectionId == null) { setFolders([]); return; }
    let alive = true;
    api.listFolders(projectId, collectionId).then((f) => { if (alive) setFolders(f); }).catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, [open, collectionId, projectId]);

  const onCollectionChange = async (v: string) => {
    if (v === '__new__') {
      const n = await prompt({ title: t('saveDialog.newCollectionTitle'), placeholder: t('saveDialog.collectionNamePlaceholder') });
      if (n?.trim()) { const id = await onCreateCollection(n.trim()); setCollectionId(id); setFolder(''); }
      return;
    }
    setCollectionId(Number(v)); setFolder('');
  };
  const onFolderChange = async (v: string) => {
    if (v === '__newfolder__') {
      const n = await prompt({ title: t('saveDialog.newFolderTitle'), placeholder: t('saveDialog.folderNamePlaceholder') });
      const folderName = n?.trim();
      if (folderName) { setFolders((f) => (f.includes(folderName) ? f : [...f, folderName].sort((a, b) => a.localeCompare(b)))); setFolder(folderName); }
      return;
    }
    setFolder(v);
  };

  const save = async () => {
    if (!name.trim() || collectionId == null) return;
    setBusy(true);
    try { await onSave(collectionId, folder || null, name.trim()); onOpenChange(false); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Save className="h-4 w-4" /> {t('saveDialog.title')}</DialogTitle></DialogHeader>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('saveDialog.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('saveDialog.requestNamePlaceholder')} className="h-8 text-sm" autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('saveDialog.collection')}</span>
          <ApiClientSelect
            value={collectionId == null ? '' : String(collectionId)}
            onValueChange={(value) => void onCollectionChange(value)}
            options={[
              ...(collections.length === 0 ? [{ value: '', label: t('saveDialog.noCollections'), disabled: true }] : []),
              ...collections.map((collection) => ({ value: String(collection.id), label: collection.name })),
              { value: '__new__', label: t('saveDialog.newCollectionOption') },
            ]}
            ariaLabel={t('saveDialog.collection')}
            triggerClassName="h-8 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('saveDialog.folder')}</span>
          <ApiClientSelect
            value={folder}
            onValueChange={(value) => void onFolderChange(value)}
            options={[
              { value: '', label: t('saveDialog.topLevel') },
              ...folders.map((folderName) => ({ value: folderName, label: folderName })),
              { value: '__newfolder__', label: t('saveDialog.newFolderOption') },
            ]}
            disabled={collectionId == null}
            ariaLabel={t('saveDialog.folder')}
            triggerClassName="h-8 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('saveDialog.cancel')}</Button>
          <Button size="sm" disabled={busy || !name.trim() || collectionId == null} onClick={() => void save()}>{t('saveDialog.save')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
