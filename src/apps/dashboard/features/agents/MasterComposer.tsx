import React, { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { MarkdownToolbar } from '../chat/composer/MarkdownToolbar.js';
import { useMarkdownShortcuts } from '../chat/composer/useMarkdownShortcuts.js';

interface MasterComposerProps {
  onSend: (text: string) => void | Promise<void>;
  placeholder: string;
  disabled?: boolean;
}

export function MasterComposer({ onSend, placeholder, disabled }: MasterComposerProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { handleKeyDown: mdHandleKeyDown, applyAction } = useMarkdownShortcuts(textareaRef, input, setInput);

  async function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await onSend(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    mdHandleKeyDown(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
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
        <MarkdownToolbar onAction={applyAction} />
      </div>
      <Button onClick={handleSend} disabled={disabled || !input.trim()} size="sm" className="h-9 shrink-0">
        <Send className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
