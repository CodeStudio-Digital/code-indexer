/**
 * Snippets panel — saved commands you can run on a host. Runs over a PTY-backed
 * `exec` and surfaces the output as a terminal tab (via `onRun`, which connects
 * with the host-key trust flow and switches to the Terminals view).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Play, Trash2, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select.js';
import { listSnippets, createSnippet, deleteSnippet } from '../api.js';
import type { SshHost, SshSnippet } from '../types.js';

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
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void listSnippets(projectId).then(setSnippets).catch(() => undefined);
  }, [projectId]);

  useEffect(() => reload(), [reload]);

  async function save(): Promise<void> {
    if (!name.trim() || !command.trim()) return;
    setBusy(true);
    try {
      await createSnippet(projectId, name.trim(), command);
      setName('');
      setCommand('');
      setShowForm(false);
      reload();
    } finally {
      setBusy(false);
    }
  }

  const host = hosts.find((h) => String(h.id) === hostId);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center gap-2 px-2">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{t('snippets.title')}</span>
        <div className="flex-1 min-w-0 max-w-[220px]">
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="h-6 text-xs"><SelectValue placeholder={t('snippets.selectHost')} /></SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={String(h.id)}>{h.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <Plus className="h-3 w-3" />
          {t('snippets.new')}
        </button>
      </div>

      {showForm && (
        <div className="border-b p-2 grid gap-2 bg-card/30">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('snippets.namePlaceholder')} className="h-8" />
          <Textarea value={command} onChange={(e) => setCommand(e.target.value)} placeholder={t('snippets.commandPlaceholder')} rows={2} className="font-mono text-xs" />
          <div className="flex justify-end">
            <Button size="sm" onClick={save} disabled={busy || !name.trim() || !command.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('snippets.save')}
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
          <div key={sn.id} className="flex items-center gap-2 px-3 py-2 border-b text-xs group">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{sn.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{sn.command}</div>
            </div>
            <button
              type="button"
              aria-label={t('snippets.run')}
              disabled={!host}
              onClick={() => host && onRun(host, sn)}
              className="text-muted-foreground hover:text-emerald-500 disabled:opacity-40 p-0.5"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label={t('panel.delete')}
              onClick={() => void deleteSnippet(projectId, sn.id).then(reload)}
              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground hover:text-red-500 p-0.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
