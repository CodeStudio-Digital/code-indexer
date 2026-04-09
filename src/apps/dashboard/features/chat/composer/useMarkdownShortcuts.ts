import { useCallback, type RefObject } from 'react';
import {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  toggleCodeBlock,
  toggleHeading,
  toggleUnorderedList,
  toggleOrderedList,
  toggleTaskList,
  toggleBlockquote,
  insertLink,
  insertHorizontalRule,
  handleListContinuation,
  handleTabIndent,
  type TextEditResult,
} from './markdownUtils.js';

export type MarkdownAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'inlineCode'
  | 'codeBlock'
  | 'heading'
  | 'unorderedList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'link'
  | 'horizontalRule';

const ACTION_FN: Record<MarkdownAction, (t: string, s: number, e: number) => TextEditResult> = {
  bold: toggleBold,
  italic: toggleItalic,
  strikethrough: toggleStrikethrough,
  inlineCode: toggleInlineCode,
  codeBlock: toggleCodeBlock,
  heading: toggleHeading,
  unorderedList: toggleUnorderedList,
  orderedList: toggleOrderedList,
  taskList: toggleTaskList,
  blockquote: toggleBlockquote,
  link: insertLink,
  horizontalRule: insertHorizontalRule,
};

export function useMarkdownShortcuts(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  input: string,
  setInput: (v: string) => void,
) {
  const applyEdit = useCallback(
    (result: TextEditResult) => {
      setInput(result.text);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.selectionStart = result.selStart;
        ta.selectionEnd = result.selEnd;
      });
    },
    [setInput, textareaRef],
  );

  const applyAction = useCallback(
    (action: MarkdownAction) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const fn = ACTION_FN[action];
      const result = fn(ta.value, ta.selectionStart, ta.selectionEnd);
      applyEdit(result);
    },
    [textareaRef, applyEdit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd + B — Bold
      if (mod && e.key === 'b') {
        e.preventDefault();
        applyAction('bold');
        return;
      }
      // Ctrl/Cmd + I — Italic
      if (mod && e.key === 'i') {
        e.preventDefault();
        applyAction('italic');
        return;
      }
      // Ctrl/Cmd + Shift + X — Strikethrough
      if (mod && e.shiftKey && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        applyAction('strikethrough');
        return;
      }
      // Ctrl/Cmd + E — Inline code
      if (mod && e.key === 'e') {
        e.preventDefault();
        applyAction('inlineCode');
        return;
      }
      // Ctrl/Cmd + Shift + . — Blockquote
      if (mod && e.shiftKey && (e.key === '>' || e.key === '.')) {
        e.preventDefault();
        applyAction('blockquote');
        return;
      }

      // Tab / Shift+Tab — indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        const result = handleTabIndent(ta.value, ta.selectionStart, ta.selectionEnd, e.shiftKey);
        applyEdit(result);
        return;
      }

      // Enter (plain, no modifier) — smart list continuation
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const result = handleListContinuation(ta.value, ta.selectionStart);
        if (result) {
          e.preventDefault();
          applyEdit(result);
        }
        // If null, let default Enter behavior happen
      }
    },
    [textareaRef, applyAction, applyEdit],
  );

  return { handleKeyDown, applyAction };
}
