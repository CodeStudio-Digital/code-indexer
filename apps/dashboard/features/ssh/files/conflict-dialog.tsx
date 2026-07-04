/**
 * "A file named X already exists" prompt for cross-pane transfers. A 3-way
 * choice (overwrite / skip / keep both) with an "apply to all" checkbox, driven
 * by a module store + promise the same way `prompt-dialog` is — but self-hosted:
 * `<ConflictDialogHost/>` is rendered inside `DualPaneFiles`, so no App-root
 * wiring is needed (conflicts only ever arise while the manager is open).
 */

import { useState } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';

export type ConflictAction = 'overwrite' | 'skip' | 'keepBoth';
export interface ConflictChoice {
  action: ConflictAction;
  applyToAll: boolean;
}

interface ConflictRequest {
  id: number;
  name: string;
  resolve: (c: ConflictChoice) => void;
}

interface ConflictState {
  active: ConflictRequest | null;
  open: (name: string) => Promise<ConflictChoice>;
  resolve: (c: ConflictChoice) => void;
}

let counter = 0;

const useConflictStore = create<ConflictState>((set, get) => ({
  active: null,
  open: (name) =>
    new Promise<ConflictChoice>((resolve) => {
      counter += 1;
      set({ active: { id: counter, name, resolve } });
    }),
  resolve: (c) => {
    const cur = get().active;
    if (!cur) return;
    cur.resolve(c);
    set({ active: null });
  },
}));

/** Ask the user how to resolve a same-name collision at the destination. */
export function askConflict(name: string): Promise<ConflictChoice> {
  return useConflictStore.getState().open(name);
}

export function ConflictDialogHost() {
  const active = useConflictStore((s) => s.active);
  const resolve = useConflictStore((s) => s.resolve);
  if (!active) return null;
  return <ConflictBody key={active.id} name={active.name} onResolve={resolve} />;
}

function ConflictBody({ name, onResolve }: { name: string; onResolve: (c: ConflictChoice) => void }) {
  const { t } = useTranslation('ssh');
  const [all, setAll] = useState(false);
  const pick = (action: ConflictAction) => onResolve({ action, applyToAll: all });
  return (
    <Dialog open onOpenChange={(o) => !o && onResolve({ action: 'skip', applyToAll: false })}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{t('files.collisionTitle')}</DialogTitle>
          <DialogDescription className="text-[12px]">{t('files.collisionBody', { name })}</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground select-none">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {t('files.applyToAll')}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => pick('skip')}>
            {t('files.skip')}
          </Button>
          <Button variant="ghost" onClick={() => pick('keepBoth')}>
            {t('files.keepBoth')}
          </Button>
          <Button onClick={() => pick('overwrite')}>{t('files.overwrite')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
