import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Paperclip, Sparkles, X } from 'lucide-react';
import { Textarea } from '../../../components/ui/textarea.js';
import type { AgentAttachment, EnrichedProviderModel, ProviderOption } from '../types.js';
import { fileToAttachment } from '../utils.js';
import { ComposerToolbar } from './ComposerToolbar.js';
import { MarkdownToolbar } from './MarkdownToolbar.js';
import { useMarkdownShortcuts } from './useMarkdownShortcuts.js';

interface SlashCommand {
  id: string;
  command: string;
  name: string;
  description: string;
  context_mode: string;
}

type AgentId = 'explore' | 'plan' | 'build' | 'admin';

export interface ComposerHandle {
  setInput: (v: string) => void;
}

interface ComposerProps {
  onSend: (text: string, attachments: AgentAttachment[]) => void;
  onAbort: () => void;
  streaming: boolean;
  agent: AgentId;
  setAgent: (v: AgentId) => void;
  provider: string;
  model: string;
  setModel: (v: string) => void;
  onSwitchProvider: (p: string, m: string) => void;
  providerOptions: ProviderOption[];
  currentProviderModels: EnrichedProviderModel[];
  maxTurns: number | null;
  setMaxTurns: (v: number | null) => void;
  sessionId?: number | null;
  onInvokeSkill?: (skillId: string, input: string) => void;
  /** Thinking mode toggle — only shown when provider supports it. */
  thinking?: boolean;
  setThinking?: (v: boolean) => void;
  supportsThinking?: boolean;
  /** Fallback configuration. */
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  onFallbackChange?: (provider: string | null, model: string | null) => void;
  getModelsForProvider?: (providerId: string) => EnrichedProviderModel[];
}

export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(
  function Composer(props, ref) {
    const { t } = useTranslation('chat');
    const { streaming } = props;
    const [input, setInput] = useState('');
    const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { handleKeyDown: mdKeyDown, applyAction } = useMarkdownShortcuts(textareaRef, input, setInput);

    // Debounced value for AgentPicker auto-suggest (avoids re-rendering toolbar on every keystroke)
    const [debouncedInput, setDebouncedInput] = useState('');
    useEffect(() => {
      const h = setTimeout(() => setDebouncedInput(input), 300);
      return () => clearTimeout(h);
    }, [input]);

    // ─── Slash command autocomplete ─────────────────────────────
    const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
    const [showSlash, setShowSlash] = useState(false);
    const [slashIndex, setSlashIndex] = useState(0);

    // Load available slash commands once
    useEffect(() => {
      fetch('/api/coder/skills/slash-commands')
        .then((r) => r.json())
        .then((data: { commands: SlashCommand[] }) => setSlashCommands(data.commands))
        .catch(() => {});
    }, []);

    // Filter slash commands based on current input
    const slashPrefix = input.startsWith('/') ? input.slice(1).split(/\s/)[0].toLowerCase() : '';
    const filteredSlash = input.startsWith('/') && !input.includes(' ')
      ? slashCommands.filter((c) => c.command.toLowerCase().startsWith(slashPrefix))
      : [];

    useEffect(() => {
      setShowSlash(filteredSlash.length > 0 && input.startsWith('/') && !input.includes(' '));
      setSlashIndex(0);
    }, [input]);

    useImperativeHandle(ref, () => ({ setInput }), []);

    const handleFiles = useCallback(async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const arr = await Promise.all(Array.from(files).map(fileToAttachment));
      setAttachments((prev) => [...prev, ...arr]);
    }, []);

    // Auto-resize textarea based on content
    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      const minH = 72;  // ~3 rows
      const maxH = 288; // ~12 rows
      ta.style.height = `${Math.min(Math.max(ta.scrollHeight, minH), maxH)}px`;
    }, [input]);

    const onPaste = useCallback(async (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files = items
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length === 0) return;
      e.preventDefault();
      const renamed = files.map((f) => {
        if (f.name && f.name !== 'image.png') return f;
        const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
        return new File([f], `pasted-${Date.now()}.${ext}`, { type: f.type });
      });
      const dt = new DataTransfer();
      renamed.forEach((f) => dt.items.add(f));
      await handleFiles(dt.files);
    }, [handleFiles]);

    const hasInput = input.trim().length > 0;

    const handleSend = useCallback(() => {
      if (!input.trim()) return;
      const text = input;

      // Intercept slash commands: /command args → invoke skill
      if (text.startsWith('/') && props.onInvokeSkill && props.sessionId) {
        const spaceIdx = text.indexOf(' ');
        const cmd = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
        const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';
        const match = slashCommands.find((c) => c.command.toLowerCase() === cmd.toLowerCase());
        if (match) {
          setInput('');
          setAttachments([]);
          props.onInvokeSkill(match.id, args);
          return;
        }
      }

      const atts = attachments;
      setInput('');
      setAttachments([]);
      props.onSend(text, atts);
    }, [input, attachments, slashCommands, props.onSend, props.onInvokeSkill, props.sessionId]);

    return (
      <div className="border-t bg-card p-4">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {attachments.map((a, i) => {
              const isImg = a.mediaType.startsWith('image/') && a.base64;
              return (
                <div key={i} className="relative group">
                  {isImg ? (
                    <img
                      src={`data:${a.mediaType};base64,${a.base64}`}
                      alt={a.name}
                      className="h-16 w-16 object-cover rounded-lg border"
                    />
                  ) : (
                    <div className="h-16 px-3 flex items-center text-xs rounded-lg border bg-muted gap-1.5">
                      <Paperclip className="h-3 w-3" />
                      {a.name}
                    </div>
                  )}
                  <button
                    onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                    title={t('composer.remove')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="relative rounded-xl border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background transition">
          {/* Slash command autocomplete dropdown */}
          {showSlash && filteredSlash.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border bg-popover text-popover-foreground shadow-md max-h-48 overflow-auto">
              {filteredSlash.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors ${i === slashIndex ? 'bg-muted' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(`/${cmd.command} `);
                    setShowSlash(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs font-medium">/{cmd.command}</span>
                  <span className="text-xs text-muted-foreground truncate">{cmd.name}</span>
                  {cmd.description && (
                    <span className="text-xs text-muted-foreground/60 truncate ml-auto">
                      {cmd.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Slash command navigation
              if (showSlash && filteredSlash.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSlashIndex((i) => Math.min(i + 1, filteredSlash.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSlashIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
                  e.preventDefault();
                  const cmd = filteredSlash[slashIndex];
                  if (cmd) setInput(`/${cmd.command} `);
                  setShowSlash(false);
                  return;
                }
                if (e.key === 'Escape') {
                  setShowSlash(false);
                  return;
                }
              }
              // Highest priority: send message
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
                return;
              }
              // Markdown shortcuts and smart behaviors
              mdKeyDown(e);
            }}
            placeholder={t('composer.placeholder')}
            rows={3}
            disabled={streaming}
            className="border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent text-sm min-h-0"
          />
          <div className="flex items-center">
            <MarkdownToolbar onAction={applyAction} disabled={streaming} />
            {props.supportsThinking && props.setThinking && (
              <button
                type="button"
                onClick={() => props.setThinking!(!props.thinking)}
                title={props.thinking ? t('composer.thinkingOn') : t('composer.thinkingOff')}
                className={`ml-1 p-1.5 rounded-md transition-colors ${
                  props.thinking
                    ? 'text-purple-600 bg-purple-100 dark:bg-purple-900/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <Brain className="h-4 w-4" />
              </button>
            )}
          </div>
          <ComposerToolbar
            hasInput={hasInput}
            autoSuggestText={debouncedInput}
            agent={props.agent}
            setAgent={props.setAgent}
            provider={props.provider}
            model={props.model}
            setModel={props.setModel}
            onSwitchProvider={props.onSwitchProvider}
            onSend={handleSend}
            onAbort={props.onAbort}
            streaming={streaming}
            handleFiles={handleFiles}
            providerOptions={props.providerOptions}
            currentProviderModels={props.currentProviderModels}
            maxTurns={props.maxTurns}
            setMaxTurns={props.setMaxTurns}
            fallbackProvider={props.fallbackProvider ?? null}
            fallbackModel={props.fallbackModel ?? null}
            onFallbackChange={props.onFallbackChange ?? (() => {})}
            getModelsForProvider={props.getModelsForProvider ?? (() => [])}
          />
        </div>
      </div>
    );
  },
);
