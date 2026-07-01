import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Gauge, Paperclip, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';
import { fileToAttachment } from '../chat/utils.js';
import { useFileDrop } from '../chat/composer/useFileDrop.js';
import { DropOverlay } from '../chat/composer/DropOverlay.js';
import { useComposerDraft } from '../chat/composer/useComposerDraft.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';

interface MasterComposerProps {
  onSend: (text: string, attachments: AgentAttachment[], opts?: { thinking?: boolean }) => void | Promise<void>;
  placeholder: string;
  disabled?: boolean;
  /** When true, render the brain toggle. Computed by the parent from the master's provider capabilities. */
  supportsThinking?: boolean;
  /**
   * Sticky master reasoning-effort override (config_json `master_reasoning_effort`).
   * Orthogonal to thinking. The selector renders only when `reasoningLevels` is
   * non-empty (master model exposes discrete effort levels). `null` = auto.
   */
  reasoningEffort?: string | null;
  setReasoningEffort?: (v: string | null) => void;
  /** Discrete effort levels the master model supports. Empty → hide selector. */
  reasoningLevels?: string[];
  /**
   * Optional prefix builder (Builder studio). Called once per send to
   * prepend context (e.g. the selected element block) to the message and
   * clear that pending state. Returns '' when there's nothing to prepend.
   */
  buildPrefix?: () => string;
  /** Company session id — keys the per-session draft persistence (`company:<id>`). */
  sessionId?: number | null;
}

export function MasterComposer({ onSend, placeholder, disabled, supportsThinking, reasoningEffort, setReasoningEffort, reasoningLevels, buildPrefix, sessionId }: MasterComposerProps) {
  const { t } = useTranslation('agents');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  // Per-session draft persistence (survives navigation / rail unmount).
  const draftKey = sessionId != null ? `company:${sessionId}` : null;
  const { clearDraft } = useComposerDraft({ draftKey, input, setInput, attachments, setAttachments });
  const [thinking, setThinking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Markdown formatting toolbar removed (useless markers for an AI prompt);
  // the smart keyboard behaviors (Tab indent, Enter list continuation) stay.
  const { handleKeyDown: mdHandleKeyDown } = useMarkdownShortcuts(textareaRef, input, setInput);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = await Promise.all(Array.from(files).map(fileToAttachment));
    setAttachments((prev) => [...prev, ...arr]);
  }

  const { isDragging, dropHandlers } = useFileDrop({ onFiles: handleFiles, disabled });

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    const atts = attachments;
    setInput('');
    setAttachments([]);
    clearDraft();
    // Builder studio: prepend the selected-element block (and clear it).
    const prefix = buildPrefix?.() ?? '';
    await onSend(prefix ? `${prefix}\n${text}` : text, atts, { thinking });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    mdHandleKeyDown(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="space-y-2 relative" {...dropHandlers}>
      <DropOverlay show={isDragging} />

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a, i) => {
            const isImg = a.mediaType.startsWith('image/') && a.base64;
            return (
              <div key={i} className="relative group">
                {isImg ? (
                  <img
                    src={`data:${a.mediaType};base64,${a.base64}`}
                    alt={a.name}
                    className="h-14 w-14 object-cover rounded-md border"
                  />
                ) : (
                  <div className="h-14 px-3 flex items-center text-xs rounded-md border bg-muted gap-1.5 max-w-[180px]">
                    <Paperclip className="h-3 w-3 shrink-0" />
                    <span className="truncate">{a.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                  aria-label="Remove attachment"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <div className="relative flex-1 rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full resize-y px-3 py-2 text-sm min-h-[60px] max-h-[300px] bg-transparent focus:outline-none"
            rows={3}
          />
          <div className="flex items-center gap-1 border-t">
              <label className="cursor-pointer">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf,.txt,.md,.json,.csv,.yaml,.yml,.xml,.html"
                  className="hidden"
                  onChange={(e) => {
                    handleFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <span className="inline-flex items-center justify-center h-7 w-7 ml-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <Paperclip className="h-3.5 w-3.5" />
                </span>
              </label>
              {supportsThinking && (
                <button
                  type="button"
                  onClick={() => setThinking((v) => !v)}
                  title={thinking ? 'Thinking mode: ON' : 'Thinking mode: OFF'}
                  className={`ml-1 p-1.5 rounded-md transition-colors ${
                    thinking
                      ? 'text-purple-600 bg-purple-100 dark:bg-purple-900/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  <Brain className="h-3.5 w-3.5" />
                </button>
              )}
              {setReasoningEffort && reasoningLevels && reasoningLevels.length > 0 && (
                <span
                  className="ml-1 inline-flex items-center gap-1 text-muted-foreground"
                  title={t('composer.effortHint', 'Reasoning effort (auto = model default). Independent of thinking.')}
                >
                  <Gauge className="h-3.5 w-3.5" />
                  <select
                    aria-label={t('composer.effort', 'Reasoning effort')}
                    className="h-7 rounded border bg-background px-1 text-xs"
                    value={reasoningEffort ?? ''}
                    onChange={(e) => setReasoningEffort(e.target.value === '' ? null : e.target.value)}
                  >
                    <option value="">{t('composer.effortAuto', 'auto')}</option>
                    {reasoningLevels.map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </select>
                </span>
              )}
          </div>
        </div>
        <Button onClick={handleSend} disabled={disabled || !input.trim()} size="sm" className="h-9 shrink-0">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
