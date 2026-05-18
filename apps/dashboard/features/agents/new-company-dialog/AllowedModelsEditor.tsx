/**
 * Curated `(provider, model)` pool editor for the new-company dialog.
 *
 * Empty list = "no restriction" (legacy behavior preserved). Non-empty
 * list = server-side enforcement: `spawn_subordinate_agent` rejects
 * anything outside the pool. One entry is marked `is_default` and used
 * when the master spawns without an explicit model.
 *
 * Extracted from `NewCompanyDialog.tsx` (Frente B). The dialog owns
 * the state; this component is pure render given a value + setter and
 * the provider catalog handles.
 */

import { useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import type { PoolEntry } from './types.js';

export interface AllowedModelsEditorProps {
  allowedModels: PoolEntry[];
  setAllowedModels: React.Dispatch<React.SetStateAction<PoolEntry[]>>;
  /** Master `(provider, model)` for the "Use master model as the only entry" shortcut. */
  masterProvider: string;
  masterModel: string;
  /** Provider catalog handles wired from the dialog. */
  providerOptions: ReadonlyArray<{ id: string; label: string }>;
  getModelsForProvider: (provider: string) => Array<{ id: string; name: string }>;
  getDefaultModel: (provider: string) => string;
}

export function AllowedModelsEditor({
  allowedModels,
  setAllowedModels,
  masterProvider,
  masterModel,
  providerOptions,
  getModelsForProvider,
  getDefaultModel,
}: AllowedModelsEditorProps) {
  const [newPoolProvider, setNewPoolProvider] = useState('');
  const [newPoolModel, setNewPoolModel] = useState('');
  const [newPoolNotes, setNewPoolNotes] = useState('');

  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
        Allowed subordinate models
        <span className="text-[10px] font-normal italic opacity-70">
          (optional — empty = no restriction)
        </span>
      </label>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Constrain which models the master can pick when spawning sub-agents. Prevents
        hallucinated model names; the master sees this list in its prompt and picks from it.
        The first entry (or the one marked default) is used when no explicit model is given.
      </p>

      {allowedModels.length > 0 && (
        <div className="mt-2 border rounded-md divide-y">
          {allowedModels.map((entry, i) => (
            <div
              key={`${entry.provider}/${entry.model}`}
              className="px-3 py-2 text-xs flex items-center gap-2"
            >
              <input
                type="radio"
                name="pool-default"
                checked={!!entry.is_default}
                onChange={() => {
                  setAllowedModels((prev) =>
                    prev.map((e, idx) => ({ ...e, is_default: idx === i })),
                  );
                }}
                title="Mark as default (used when master spawns without explicit model)"
              />
              <span className="font-mono">{entry.provider}/{entry.model}</span>
              {entry.is_default && (
                <span className="text-[10px] text-primary font-medium">default</span>
              )}
              {entry.notes && (
                <span className="text-muted-foreground truncate italic">— {entry.notes}</span>
              )}
              <button
                type="button"
                onClick={() =>
                  setAllowedModels((prev) => {
                    const next = prev.filter((_, idx) => idx !== i);
                    // If we just removed the default, promote the first
                    // remaining entry so `is_default` is always self-consistent.
                    if (entry.is_default && next.length > 0) next[0].is_default = true;
                    return next;
                  })
                }
                className="ml-auto text-destructive hover:underline text-[11px]"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add-model row */}
      <div className="mt-2 grid grid-cols-[1fr_1fr_1.2fr_auto] gap-1.5">
        <select
          value={newPoolProvider}
          onChange={(e) => {
            setNewPoolProvider(e.target.value);
            const def = getDefaultModel(e.target.value);
            if (def) setNewPoolModel(def);
          }}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          <option value="">Provider…</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {newPoolProvider && getModelsForProvider(newPoolProvider).length > 0 ? (
          <select
            value={newPoolModel}
            onChange={(e) => setNewPoolModel(e.target.value)}
            className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
          >
            <option value="">Model…</option>
            {getModelsForProvider(newPoolProvider).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        ) : (
          <input
            value={newPoolModel}
            onChange={(e) => setNewPoolModel(e.target.value)}
            placeholder="model name"
            className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
          />
        )}
        <input
          value={newPoolNotes}
          onChange={(e) => setNewPoolNotes(e.target.value)}
          placeholder="notes (e.g. cheap — trivial tasks)"
          className="rounded-md border bg-background px-2 py-1 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!newPoolProvider.trim() || !newPoolModel.trim()}
          onClick={() => {
            const provider = newPoolProvider.trim();
            const model = newPoolModel.trim();
            if (!provider || !model) return;
            // Silently dedupe — a common mistake is adding the master
            // model twice when it was already auto-included.
            if (allowedModels.some((e) => e.provider === provider && e.model === model)) {
              setNewPoolNotes('');
              return;
            }
            setAllowedModels((prev) => [
              ...prev,
              {
                provider,
                model,
                notes: newPoolNotes.trim() || undefined,
                is_default: prev.length === 0, // first entry is default
              },
            ]);
            setNewPoolNotes('');
          }}
        >
          + Add
        </Button>
      </div>

      {/* Convenience: pre-populate with the master model in one click. */}
      {allowedModels.length === 0 && (
        <button
          type="button"
          onClick={() =>
            setAllowedModels([
              {
                provider: masterProvider,
                model: masterModel,
                notes: 'master model',
                is_default: true,
              },
            ])
          }
          className="mt-2 text-[11px] text-primary hover:underline"
        >
          Use master model as the only allowed entry
        </button>
      )}
    </div>
  );
}
