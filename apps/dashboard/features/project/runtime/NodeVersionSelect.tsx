/**
 * Per-project Node version picker. Lists detected + managed runtimes plus
 * a "System default" option (stored as null) and a "Manage versions…"
 * entry that opens the install/remove dialog. Used in the project settings
 * dialog and the Runners-tab quick chip.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { useNodeRuntimes, loadNodeRuntimes } from '../../../state/node-runtimes.js';
import { NodeVersionsDialog } from './NodeVersionsDialog.js';

const SYSTEM = 'system';
const MANAGE = '__manage__';

interface NodeVersionSelectProps {
  /** Stored node_version id, or null for system default. */
  value: string | null;
  onChange: (id: string | null) => void;
  className?: string;
}

export function NodeVersionSelect({ value, onChange, className }: NodeVersionSelectProps) {
  const { t } = useTranslation(['projects', 'common']);
  const runtimes = useNodeRuntimes((s) => s.runtimes);
  const loaded = useNodeRuntimes((s) => s.loaded);
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void loadNodeRuntimes();
  }, [loaded]);

  function handleChange(next: string) {
    if (next === MANAGE) {
      setManageOpen(true);
      return;
    }
    onChange(next === SYSTEM ? null : next);
  }

  return (
    <>
      <Select value={value ?? SYSTEM} onValueChange={handleChange}>
        <SelectTrigger className={className ?? 'w-full'}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SYSTEM}>{t('runtime.systemDefault')}</SelectItem>
          {runtimes.length > 0 && <SelectSeparator />}
          {runtimes.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={MANAGE}>{t('runtime.manage')}</SelectItem>
        </SelectContent>
      </Select>
      <NodeVersionsDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  );
}
