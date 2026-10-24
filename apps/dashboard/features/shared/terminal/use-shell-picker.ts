/**
 * Shell-picker glue shared by the workspace and company terminal panels.
 *
 * Fetches the host's installed shells once per mount via
 * `terminal.listShells`, merges in the user's custom entries, resolves
 * which shell is "active" (the persisted preference, falling back to the
 * first available), and exposes the select + add-custom actions. Keeping
 * this in one hook means both panels stay lean and behave identically.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import { prompt } from '../../../components/ui/prompt-dialog.js';
import {
  mergeShells,
  resolveActiveShell,
  useShellPrefs,
  type TerminalShell,
} from '../../../state/terminal-shell-prefs.js';

interface ShellPicker {
  /** Detected + custom shells, for the picker menu. */
  shells: TerminalShell[];
  /** The shell "+" will spawn (preferred, or first available). */
  activeShell: TerminalShell | null;
  /** Persist a new preferred shell. */
  selectShell: (id: string) => void;
  /** Prompt for a custom executable path and add it as a shell. */
  addCustomShell: () => Promise<void>;
}

export function useShellPicker(): ShellPicker {
  const preferredShellId = useShellPrefs((s) => s.preferredShellId);
  const customShells = useShellPrefs((s) => s.customShells);
  const setPreferred = useShellPrefs((s) => s.setPreferred);
  const addCustom = useShellPrefs((s) => s.addCustom);

  const [detected, setDetected] = useState<TerminalShell[]>([]);

  useEffect(() => {
    let alive = true;
    void apiCall<TerminalShell[]>('terminal.listShells', {})
      .then((list) => {
        if (alive && Array.isArray(list)) setDetected(list);
      })
      .catch(() => {
        /* detection failed — leave list empty; spawn falls back to default */
      });
    return () => {
      alive = false;
    };
  }, []);

  const shells = useMemo(() => mergeShells(detected, customShells), [detected, customShells]);
  const activeShell = resolveActiveShell(shells, preferredShellId);

  const addCustomShell = useCallback(async () => {
    const path = await prompt({
      title: 'Adicionar shell',
      description: 'Caminho do executável (ex.: C:\\msys64\\usr\\bin\\bash.exe)',
      placeholder: 'Caminho do executável',
      confirmLabel: 'Adicionar',
    });
    const file = path?.trim();
    if (!file) return;
    const fallbackLabel = file.split(/[\\/]/).pop() || file;
    const label = await prompt({
      title: 'Nome do shell',
      description: 'Como exibir este shell no menu.',
      defaultValue: fallbackLabel,
      confirmLabel: 'Salvar',
    });
    const shell: TerminalShell = { id: `custom:${file}`, label: label?.trim() || fallbackLabel, file };
    addCustom(shell);
    setPreferred(shell.id);
  }, [addCustom, setPreferred]);

  return { shells, activeShell, selectShell: setPreferred, addCustomShell };
}
