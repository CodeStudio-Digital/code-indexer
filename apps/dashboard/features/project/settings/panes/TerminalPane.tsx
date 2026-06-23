/**
 * Terminal settings pane — the per-project runner shell (cmd / PowerShell /
 * Git Bash / WSL / custom). Stored as `runner_shell`, resolved server-side at
 * spawn. Extracted from the old RunnerShellChip; save-on-change.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../../../lib/api-client.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';
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

  const shells = mergeShells(detected, customShells);
  const value = project.runner_shell ?? null;

  return (
    <div className="space-y-3 max-w-xl">
      <h3 className="text-sm font-semibold">{t('settings.nav.terminal')}</h3>
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('runners.shellLabel')}</label>
        <Select
          value={value ?? SYSTEM}
          onValueChange={(next) => void patch({ runner_shell: next === SYSTEM ? null : next })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SYSTEM}>{t('runners.shellSystem')}</SelectItem>
            {shells.length > 0 && <SelectSeparator />}
            {shells.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('runners.shellHint')}</p>
      </div>
    </div>
  );
}
