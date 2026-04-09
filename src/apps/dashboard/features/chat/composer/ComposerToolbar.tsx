import React from 'react';
import { Paperclip, Repeat, Send, Square } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Combobox, type ComboboxOption } from '../../../components/ui/combobox.js';
import { PROVIDERS } from '../constants.js';
import type { EnrichedProviderModel, ProviderOption } from '../types.js';
import { AgentPicker } from './AgentPicker.js';

type AgentId = 'explore' | 'plan' | 'build' | 'admin';

interface ComposerToolbarProps {
  hasInput: boolean;
  autoSuggestText: string;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  provider: string;
  model: string;
  setModel: (v: string) => void;
  onSwitchProvider: (p: string, m: string) => void;
  onSend: () => void;
  onAbort: () => void;
  streaming: boolean;
  handleFiles: (files: FileList | null) => Promise<void>;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  maxTurns: number | null;
  setMaxTurns: (v: number | null) => void;
}

export const ComposerToolbar = React.memo(function ComposerToolbar({
  hasInput,
  autoSuggestText,
  agent,
  setAgent,
  provider,
  model,
  setModel,
  onSwitchProvider,
  onSend,
  onAbort,
  streaming,
  handleFiles,
  providerOptions,
  currentProviderModels,
  maxTurns,
  setMaxTurns,
}: ComposerToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-2 pb-2 flex-wrap">
      <label className="cursor-pointer">
        <input
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.sh,.sql,.toml,.ini,.log"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <span className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
          <Paperclip className="h-4 w-4" />
        </span>
      </label>

      <AgentPicker value={agent} onChange={setAgent} autoSuggestFor={autoSuggestText} />

      <div className="w-[110px]">
        <Combobox
          value={provider}
          onChange={(v) => onSwitchProvider(v, '')}
          options={providerOptions.map((p) => ({ value: p.id, label: p.label }))}
          placeholder="Provider"
          searchPlaceholder="Search provider…"
          emptyLabel="No provider"
        />
      </div>

      {currentProviderModels.length > 0 ? (
        <div className="w-40">
          <Combobox
            value={model}
            onChange={(v) => {
              setModel(v);
              onSwitchProvider(provider, v);
            }}
            options={currentProviderModels.map<ComboboxOption>((m) => ({
              value: m.mode ? `${m.id}::${m.mode}` : m.id,
              label: m.id,
              hint: m.mode,
            }))}
            placeholder="(default)"
            searchPlaceholder="Search model…"
            emptyLabel="No model"
          />
        </div>
      ) : (
        <Input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={(e) => onSwitchProvider(provider, e.target.value)}
          placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel}
          className="h-8 w-32 text-xs font-mono"
        />
      )}

      <div className="flex items-center gap-1 text-muted-foreground" title="Max turns (empty = default)">
        <Repeat className="h-3.5 w-3.5" />
        <Input
          type="number"
          min={1}
          max={200}
          value={maxTurns ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setMaxTurns(v === '' ? null : Math.max(1, parseInt(v, 10) || 1));
          }}
          placeholder="50"
          className="h-7 w-16 text-xs font-mono px-1.5"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground hidden sm:inline">⌘+Enter</span>
        {streaming ? (
          <Button onClick={onAbort} variant="destructive" size="sm">
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button onClick={onSend} disabled={!hasInput} size="sm">
            <Send className="h-3.5 w-3.5" /> Send
          </Button>
        )}
      </div>
    </div>
  );
});
