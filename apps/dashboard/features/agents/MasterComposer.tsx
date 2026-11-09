import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Gauge, Paperclip, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';
import { filesToAttachments } from '../chat/utils.js';
import { useFileDrop } from '../chat/composer/useFileDrop.js';
import { DropOverlay } from '../chat/composer/DropOverlay.js';
import { useComposerDraft } from '../chat/composer/useComposerDraft.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';
import { clipboardFiles } from '../chat/composer/clipboard-files.js';
import { ImageGallery } from '../chat/messages/ImageGallery.js';

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
  sessionId?: string | null;
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
  const currentAttachments = useRef(attachments);
  const fileQueue = useRef(Promise.resolve());
  const owner = useRef(0);
  const [reading, setReading] = useState<{ key: string | null; count: number }>({ key: draftKey, count: 0 });
  const readingFiles = reading.key === draftKey && reading.count > 0;
  useEffect(() => { currentAttachments.current = attachments; }, [attachments]);
  useEffect(() => { const generation = owner.current + 1; owner.current = generation; return () => { owner.current = generation + 1; }; }, [draftKey]);
  // Markdown formatting toolbar removed (useless markers for an AI prompt);
  // the smart keyboard behaviors (Tab indent, Enter list continuation) stay.
  const { handleKeyDown: mdHandleKeyDown } = useMarkdownShortcuts(textareaRef, input, setInput);

  function handleFiles(files: FileList | File[] | null) {
    if (disabled || !files?.length) return;
    const selected = Array.from(files);
    const generation = owner.current;
    setReading(previous => ({ key: draftKey, count: (previous.key === draftKey ? previous.count : 0) + 1 }));
    fileQueue.current = fileQueue.current.then(async () => {
      if (owner.current !== generation) return;
      try {
        const added = await filesToAttachments(selected, currentAttachments.current);
        if (owner.current !== generation) return;
        const next = [...currentAttachments.current, ...added];
        currentAttachments.current = next;
        setAttachments(next);
      } catch (error) {
        if (owner.current === generation) toast.error(t('composer.attachmentRejected', 'Attachment rejected'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (owner.current === generation) setReading(previous => ({ key: draftKey, count: Math.max(0, previous.count - 1) }));
      }
    });
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled) return;
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    handleFiles(files);
  }

  const { isDragging, dropHandlers } = useFileDrop({ onFiles: handleFiles, disabled });

  async function handleSend() {
    if (disabled || readingFiles) return;
    const text = input.trim() || t('composer.analyzeAttachments', 'Analyze the attached files.');
    if (!input.trim() && attachments.length === 0) return;
    const atts = attachments;
    setInput('');
    setAttachments([]);
    currentAttachments.current = [];
    clearDraft();
    // Builder studio: prepend the selected-element block (and clear it).
    const prefix = buildPrefix?.() ?? '';
    await onSend(prefix ? `${prefix}\n${text}` : text, atts, { thinking });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
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
                  <ImageGallery images={[{ name: a.name, src: `data:${a.mediaType};base64,${a.base64}` }]} />
                ) : (
                  <div className="h-14 px-3 flex items-center text-xs rounded-md border bg-muted gap-1.5 max-w-[180px]">
                    <Paperclip className="h-3 w-3 shrink-0" />
                    <span className="truncate">{a.name}</span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { const next = currentAttachments.current.filter((_, j) => j !== i); currentAttachments.current = next; setAttachments(next); }}
                  className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t('composer.removeAttachment', { name: a.name, defaultValue: 'Remove {{name}}' })}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {readingFiles && <p role="status" className="text-xs text-muted-foreground">{t('composer.readingAttachments', 'Preparing attachments…')}</p>}

      <div className="flex gap-2 items-end">
        <div className="relative flex-1 rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full resize-y px-3 py-2 text-sm min-h-[60px] max-h-[300px] bg-transparent focus:outline-none"
            rows={3}
          />
          <div className="flex items-center gap-1 border-t">
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  disabled={disabled}
                  aria-label={t('composer.attachFiles', 'Attach files')}
                  multiple
                  accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf,.txt,.md,.markdown,.json,.csv,.yaml,.yml,.xml,.html,.css,.svg,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.cpp,.h,.hpp,.sh,.bash,.sql,.toml,.ini,.env,.log"
                  className="hidden"
                  onChange={(e) => {
                    handleFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button type="button" disabled={disabled} onClick={() => fileInputRef.current?.click()} aria-label={t('composer.attachFiles', 'Attach files')} className="inline-flex items-center justify-center h-7 w-7 ml-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
              </div>
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
        <Button onClick={handleSend} disabled={disabled || readingFiles || (!input.trim() && attachments.length === 0)} aria-label={t('composer.sendMessage', 'Send message')} size="sm" className="h-9 shrink-0">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
