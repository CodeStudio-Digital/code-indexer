import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Keyboard, Plus, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { confirm as confirmDialog } from '../../components/ui/prompt-dialog.js';
import { listCommands, onCommandsChanged } from '../../keymap/commands.js';
import { installShortcutRecorder } from '../../keymap/recorder.js';
import {
  bindingIndex,
  conflictingCommands,
  effectiveBindings,
  displayBinding,
  useKeymapStore,
  type KeymapPreset,
} from '../../keymap/keymap-store.js';
import { useSeStore } from './se-store.js';

type FilterMode = 'all' | 'modified' | 'conflicts';
const CATEGORY_PT: Record<string, string> = {
  Workbench: 'Área de trabalho', File: 'Arquivo', Navigate: 'Navegação', Search: 'Busca',
  Edit: 'Edição', Selection: 'Seleção', Code: 'Código', Refactor: 'Refatoração',
  Problems: 'Problemas', Folding: 'Dobramento', AI: 'IA',
};

export function KeymapPane({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const pt = i18n.language.toLowerCase().startsWith('pt');
  const { preset, overrides, setPreset, addBinding, removeBinding, clearOverride, replaceConflict, resetAll } = useKeymapStore();
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<FilterMode>('all');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => onCommandsChanged(() => bump((n) => n + 1)), []);

  useEffect(() => {
    if (!capturing) return;
    const commit = async (binding: string) => {
      const conflicts = conflictingCommands(binding, capturing);
      if (conflicts.length) {
        const names = conflicts.map((id) => listCommands().find((cmd) => cmd.id === id)?.title ?? id).join(', ');
        const confirmed = await confirmDialog({
          title: pt ? 'Substituir atalho?' : 'Replace shortcut?',
          description: pt
            ? `O atalho ${binding} já pertence a ${names}. A outra ação perderá apenas esta combinação.`
            : `${binding} is already assigned to ${names}. The other action will lose only this binding.`,
          confirmLabel: pt ? 'Substituir' : 'Replace',
          cancelLabel: pt ? 'Cancelar' : 'Cancel',
        });
        if (confirmed) replaceConflict(capturing, binding, conflicts);
      } else {
        addBinding(capturing, binding);
      }
      setCapturing(null);
    };
    return installShortcutRecorder({
      onCommit: commit,
      onCancel: () => setCapturing(null),
    });
  }, [addBinding, capturing, pt, replaceConflict]);

  const conflictIds = useMemo(() => {
    const result = new Set<string>();
    for (const [binding, ids] of bindingIndex()) {
      for (const id of ids) if (conflictingCommands(binding, id).length) result.add(id);
    }
    return result;
  }, [preset, overrides]);

  const commands = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return listCommands()
      .filter((command) => {
        const bindings = effectiveBindings(command, preset, overrides);
        const haystack = [command.id, command.title, command.titlePt, command.category, command.categoryPt, ...bindings].join(' ').toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (mode === 'modified' && !(command.id in overrides)) return false;
        if (mode === 'conflicts' && !conflictIds.has(command.id)) return false;
        return true;
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }, [conflictIds, filter, mode, overrides, preset]);

  return (
    <div className={cn('flex min-h-0 flex-col rounded border bg-[var(--workbench-surface)]', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Keyboard className="h-4 w-4 text-primary" />
        <select value={preset} onChange={(event) => setPreset(event.target.value as KeymapPreset)} className="h-7 rounded border bg-background px-2 text-xs">
          <option value="intellij">IntelliJ ({pt ? 'padrão' : 'default'})</option>
          <option value="vscode">VS Code</option>
        </select>
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={pt ? 'Buscar por ação, categoria, id ou atalho…' : 'Search action, category, id or shortcut…'} className="h-7 min-w-48 flex-1 text-xs" />
        {(['all', 'modified', 'conflicts'] as const).map((value) => (
          <Button key={value} type="button" variant={mode === value ? 'secondary' : 'ghost'} size="sm" className="h-7 text-[11px]" onClick={() => setMode(value)}>
            {value === 'all' ? (pt ? 'Todos' : 'All') : value === 'modified' ? (pt ? 'Modificados' : 'Modified') : (pt ? 'Conflitos' : 'Conflicts')}
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => void confirmDialog({
          title: pt ? 'Restaurar todos os atalhos?' : 'Reset every shortcut?',
          description: pt ? 'Todos os atalhos voltarão ao preset selecionado.' : 'Every shortcut will return to the selected preset.',
          confirmLabel: pt ? 'Restaurar' : 'Reset', cancelLabel: pt ? 'Cancelar' : 'Cancel',
        }).then((confirmed) => { if (confirmed) resetAll(); })}><RotateCcw className="mr-1 h-3 w-3" />{pt ? 'Restaurar tudo' : 'Reset all'}</Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {commands.map((command) => {
          const bindings = effectiveBindings(command, preset, overrides);
          const overridden = command.id in overrides;
          const conflicted = conflictIds.has(command.id);
          return (
            <div key={command.id} data-command-id={command.id} className={cn('flex min-h-11 items-center gap-3 border-b border-border/40 px-3 py-1.5 text-xs hover:bg-muted/20', !command.available && 'opacity-60')}>
              <div className="w-28 shrink-0 text-[10px] text-muted-foreground">{pt ? (command.categoryPt ?? CATEGORY_PT[command.category] ?? command.category) : command.category}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{pt ? command.titlePt : command.title}</span>
                  {conflicted && <AlertTriangle className="h-3 w-3 text-amber-500" />}
                  {!command.available && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{pt ? 'indisponível neste contexto' : 'unavailable in this context'}</span>}
                </div>
                <div className="truncate font-mono text-[9px] text-muted-foreground/70">{command.id}{command.context ? ` · ${command.context}` : ''}</div>
              </div>
              <div className="flex max-w-[42%] flex-wrap justify-end gap-1">
                {bindings.map((binding) => (
                  <span key={binding} className={cn('inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]', conflicted ? 'border-amber-500/60 text-amber-500' : 'text-muted-foreground')}>
                    {displayBinding(binding)}
                    <button type="button" className="ml-1 hover:text-foreground" title={pt ? 'Remover atalho' : 'Remove shortcut'} onClick={() => removeBinding(command.id, binding)}><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
                <button type="button" onClick={() => setCapturing(command.id)} className={cn('inline-flex h-6 items-center rounded border px-1.5 text-[10px]', capturing === command.id ? 'animate-pulse border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
                  {capturing === command.id ? (pt ? 'Pressione…' : 'Press keys…') : <><Plus className="mr-0.5 h-3 w-3" />{pt ? 'Atalho' : 'Shortcut'}</>}
                </button>
                {overridden && <button type="button" title={pt ? 'Herdar do preset' : 'Reset to preset'} className="px-1 text-muted-foreground hover:text-foreground" onClick={() => clearOverride(command.id)}><RotateCcw className="h-3 w-3" /></button>}
              </div>
            </div>
          );
        })}
        {!commands.length && <div className="p-8 text-center text-xs text-muted-foreground">{pt ? 'Nenhuma ação encontrada.' : 'No actions found.'}</div>}
      </div>
    </div>
  );
}

export function KeymapDialog() {
  const open = useSeStore((state) => state.keymapOpen);
  const setOpen = useSeStore((state) => state.setKeymapOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[8%] max-w-4xl translate-y-0 gap-0 p-0">
        <KeymapPane className="h-[min(70vh,680px)] border-0" />
      </DialogContent>
    </Dialog>
  );
}
