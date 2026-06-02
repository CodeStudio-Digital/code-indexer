/**
 * Quick per-project runner-shell switcher for the Runners tab header.
 * Lets the user pick which shell the runner launches scripts with (cmd,
 * PowerShell, Git Bash, WSL, or a custom path) — independent of the
 * interactive terminal's shell. Stored as `runner_shell` on the project
 * and resolved server-side at spawn. Applies to NEW runs only.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalSquare } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../../../lib/api-client.js';
import { apiPatch } from '../../../../hooks/useApi.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../../components/ui/select.js';
import {
  mergeShells,
  useShellPrefs,
  type TerminalShell,
} from '../../../../state/terminal-shell-prefs.js';

const SYSTEM = 'system';

export function RunnerShellChip({ projectId }: { projectId: number }) {
  const { t } = useTranslation(['projects']);
  const customShells = useShellPrefs((s) => s.customShells);
  const [detected, setDetected] = useState<TerminalShell[]>([]);
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void apiCall<TerminalShell[]>('terminal.listShells', {})
      .then((l) => {
        if (alive && Array.isArray(l)) setDetected(l);
      })
      .catch(() => undefined);
    void apiCall<Project>('projects.get', { id: projectId })
      .then((p) => {
        if (alive) setValue(p.runner_shell ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  const shells = mergeShells(detected, customShells);

  const change = useCallback(
    (next: string) => {
      const id = next === SYSTEM ? null : next;
      setValue(id);
      void apiPatch(`/projects/${projectId}`, { runner_shell: id });
    },
    [projectId],
  );

  return (
    <div className="flex items-center gap-1.5" title={t('runners.shellHint')}>
      <TerminalSquare className="h-3.5 w-3.5 text-sky-400" />
      <Select value={value ?? SYSTEM} onValueChange={change}>
        <SelectTrigger className="h-7 w-44 text-xs">
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
    </div>
  );
}
