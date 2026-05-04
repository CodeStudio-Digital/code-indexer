import React, { useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';
import { fileToAttachment } from '../chat/utils.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';

interface MasterComposerProps {
  onSend: (text: string, attachments: AgentAttachment[]) => void | Promise<void>;
  placeholder: string;
  disabled?: boolean;
}

export function MasterComposer({ onSend, placeholder, disabled }: MasterComposerProps) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { handleKeyDown: mdHandleKeyDown, applyAction } = useMarkdownShortcuts(textareaRef, input, setInput);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const arr = await Promise.all(Array.from(files).map(fileToAttachment));
    // Images-only filter — backend rejects non-images for company sessions.
    setAttachments((prev) => [...prev, ...arr.filter((a) => a.mediaType.startsWith('image/'))]);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    const atts = attachments;
    setInput('');
    setAttachments([]);
    await onSend(text, atts);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    mdHandleKeyDown(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="space-y-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a, i) => (
            <div key={i} className="relative group">
              <img
                src={`data:${a.mediaType};base64,${a.base64}`}
                alt={a.name}
                className="h-14 w-14 object-cover rounded-md border"
              />
              <button
                type="button"
                onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
                aria-label="Remove attachment"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <div className="flex-1 rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring overflow-hidden">
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
                accept="image/*"
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
            <MarkdownToolbar onAction={applyAction} />
          </div>
        </div>
        <Button onClick={handleSend} disabled={disabled || !input.trim()} size="sm" className="h-9 shrink-0">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
