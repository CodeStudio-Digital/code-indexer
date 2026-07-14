/**
 * Snippets panel — saved commands you can run on a host. Runs over a PTY-backed
 * `exec` and surfaces the output as a terminal tab (via `onRun`, which connects
 * with the host-key trust flow and switches to the Terminals view).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Play, Pencil, Trash2, Loader2, KeyRound } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { findHostByKey, listSnippets, createSnippet, patchSnippet, deleteSnippet, listSecrets, sshHostKey } from '../api.js';
import { SecretsManager } from './SecretsManager.js';
import type { SshHost, SshSnippet, SshSecret } from '../types.js';

interface SnippetsPanelProps {
  projectId: number;
  hosts: SshHost[];
  /** Run `snippet` on `host` — owner wires the trust flow + opens a terminal tab. */
  onRun: (host: SshHost, snippet: SshSnippet) => void;
}

export function SnippetsPanel({ projectId, hosts, onRun }: SnippetsPanelProps) {
  const { t } = useTranslation('ssh');
  const [snippets, setSnippets] = useState<SshSnippet[]>([]);
  const [hostId, setHostId] = useState('');
  const [showForm, setShowForm] = useState(false);
  /** id of the snippet being edited, or null when creating a new one. */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [secrets, setSecrets] = useState<SshSecret[]>([]);
  const [showSecrets, setShowSecrets] = useState(false);
  const commandRef = useRef<HTMLTextAreaElement>(null);

  const reload = useCallback(() => {
    void listSnippets(projectId).then(setSnippets).catch(() => undefined);
  }, [projectId]);

  const reloadSecrets = useCallback(() => {
    void listSecrets(projectId).then(setSecrets).catch(() => undefined);
  }, [projectId]);

  useEffect(() => reload(), [reload]);
  useEffect(() => reloadSecrets(), [reloadSecrets]);

  /** Insert `${secret:NAME}` at the caret (or append) in the command editor. */
  const insertSecret = useCallback((secretName: string) => {
    const ref = `\${secret:${secretName}}`;
    const ta = commandRef.current;
    const start = ta?.selectionStart ?? command.length;
    const end = ta?.selectionEnd ?? command.length;
    setCommand((c) => c.slice(0, start) + ref + c.slice(end));
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const pos = start + ref.length;
      ta.setSelectionRange(pos, pos);
    });
  }, [command]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setName('');
    setCommand('');
    setShowForm(false);
  }, []);

  const openNew = useCallback(() => {
    setEditingId(null);
    setName('');
    setCommand('');
    setShowForm(true);
  }, []);

  const openEdit = useCallback((sn: SshSnippet) => {
    setEditingId(sn.id);
    setName(sn.name);
    setCommand(sn.command);
    setShowForm(true);
  }, []);

  async function save(): Promise<void> {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      if (editingId != null) {
        await patchSnippet(projectId, editingId, { name: name.trim(), command });
      } else {
        await createSnippet(projectId, name.trim(), command);
      }
      resetForm();
      reload();
    } finally {
      setBusy(false);
    }
  }

  const host = findHostByKey(hosts, hostId);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center gap-2 px-2">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{t('snippets.title')}</span>
        <div className="flex-1 min-w-0 max-w-[220px]">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="h-6 text-xs"><SelectValue placeholder={t('snippets.selectHost')} /></SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={sshHostKey(h)} value={sshHostKey(h)}>{h.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          type="button"
          onClick={() => setShowSecrets((v) => !v)}
          title={t('secrets.title')}
          className={`ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-muted ${showSecrets ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <KeyRound className="h-3 w-3" />
          {t('secrets.title')}
        </button>
        <button
          type="button"
          onClick={() => (showForm && editingId == null ? resetForm() : openNew())}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {t('snippets.new')}
        </button>
      </div>

      {showSecrets && <SecretsManager projectId={projectId} secrets={secrets} onChange={reloadSecrets} />}

      {showForm && (
        <div className="border-b p-2 grid gap-2 bg-card/30">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('snippets.namePlaceholder')} className="h-8" />
          <Textarea ref={commandRef} value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('snippets.commandPlaceholder')} rows={3} className="font-mono text-xs" />
          <div className="flex items-center gap-2">
            <p className="text-[10px] text-muted-foreground flex-1">{t('snippets.multilineHint')}</p>
            {secrets.length > 0 && (
              <Select value="" onValueChange={insertSecret}>
                <SelectTrigger className="h-6 w-auto gap-1 text-[10px]">
                  <KeyRound className="h-3 w-3" />
                  {t('secrets.insert')}
                </SelectTrigger>
                <SelectContent>
                  {secrets.map((s) => (
                    <SelectItem key={s.id} value={s.name} className="font-mono text-xs">{`\${secret:${s.name}}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">{t('snippets.secretHint')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy}>
              {t('dialog.cancel')}
            </Button>
            <Button size="sm" onClick={save} disabled={busy || !name.trim() || !command.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {editingId != null ? t('snippets.update') : t('snippets.save')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {snippets.length === 0 && (
          <div className="grid place-items-center h-full text-xs text-muted-foreground gap-2">
            <Play className="h-5 w-5 opacity-60" />
            <span>{t('snippets.none')}</span>
          </div>
        )}
        {snippets.map((sn) => (
          <div key={sn.id} className="flex items-start gap-2 px-3 py-2 border-b text-xs group">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{sn.name}</div>
              {/* Preserve newlines + clamp: a multi-line snippet runs one command per line. */}
              <div className="font-mono text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-3 break-all">{sn.command}</div>
            </div>
            <button
              type="button"
              aria-label={t('snippets.run')}
              title={t('snippets.run')}
              disabled={!host}
              onClick={() => host && onRun(host, sn)}
              className="shrink-0 text-muted-foreground hover:text-emerald-500 disabled:opacity-40 p-0.5"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('panel.edit')}
              title={t('panel.edit')}
              onClick={() => openEdit(sn)}
              className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-foreground p-0.5"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('panel.delete')}
              title={t('panel.delete')}
              onClick={async () => {
                if (!(await confirm({
                  title: t('snippets.deleteConfirm', { name: sn.name }),
                  confirmLabel: t('panel.delete'),
                  tone: 'destructive',
                }))) return;
                await deleteSnippet(projectId, sn.id);
                reload();
              }}
              className="shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-red-500 p-0.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
