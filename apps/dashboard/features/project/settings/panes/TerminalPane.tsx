/**
 * Terminal settings pane — the per-project runner shell (cmd / PowerShell /
 * Git Bash / WSL / custom). Stored as `runner_shell`, resolved server-side at
 * spawn. Extracted from the old RunnerShellChip; save-on-change.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../../../lib/api-client.js';
import { Combobox } from '../../../../components/ui/combobox.js';
import { mergeShells, useShellPrefs, type TerminalShell } from '../../../../state/terminal-shell-prefs.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

const SYSTEM = 'system';

export function TerminalPane({ project, patch }: { project: Project; patch: PatchFn }) {
  const { t } = useTranslation(['projects']);
  const customShells = useShellPrefs((s) => s.customShells);
  const [detected, setDetected] = useState<TerminalShell[]>([]);

  useEffect(() => {
    let alive = true;
    void apiCall<TerminalShell[]>('terminal.listShells', {})
      .then((l) => { if (alive && Array.isArray(l)) setDetected(l); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const shells = useMemo(() => mergeShells(detected, customShells), [customShells, detected]);
  const value = project.runner_shell ?? null;
  const shellOptions = useMemo(() => [
    { value: SYSTEM, label: t('runners.shellSystem') },
    ...shells.map((shell) => ({ value: shell.id, label: shell.label })),
  ], [shells, t]);

  return (
    <div className="w-full max-w-3xl space-y-3">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('runners.shellLabel')}</label>
        <Combobox
          value={value ?? SYSTEM}
          onChange={(next) => void patch({ runner_shell: next === SYSTEM ? null : next })}
          options={shellOptions}
          searchPlaceholder={t('settings.select.search')}
          emptyLabel={t('settings.select.empty')}
          size="md"
        />
        <p className="text-xs text-muted-foreground">{t('runners.shellHint')}</p>
        {value?.startsWith('wsl:') && (
          <p className="text-xs text-muted-foreground border-l-2 border-primary/40 pl-2">
            {t('runners.shellWslRuntimeHint')}
          </p>
        )}
      </div>
    </div>
  );
}
