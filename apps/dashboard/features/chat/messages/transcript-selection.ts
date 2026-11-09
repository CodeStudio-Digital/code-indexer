import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';

/** Native selections belong to DOM nodes. Retain only explicitly selected
 * rows while scrolling, releasing them immediately when selection is cleared. */
export function selectionRange(range: Range, selectedIndexes: readonly number[]): number[] {
  if (!selectedIndexes.length) return defaultRangeExtractor(range);
  return [...new Set([...defaultRangeExtractor(range), ...selectedIndexes])]
    .filter(index => index >= 0 && index < range.count).sort((a, b) => a - b);
}

export function useTranscriptSelection(
  scrollRef: RefObject<HTMLDivElement | null>, rows: readonly { key: string }[],
): (range: Range) => number[] {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  useEffect(() => {
    const selectionChanged = () => {
      const selection = document.getSelection();
      const keys: string[] = [];
      if (selection && !selection.isCollapsed && scrollRef.current) {
        for (const row of scrollRef.current.querySelectorAll<HTMLElement>('[data-transcript-row-key]')) {
          if (selection.containsNode(row, true)) keys.push(row.dataset.transcriptRowKey!);
        }
      }
      setSelectedKeys(previous => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys);
    };
    document.addEventListener('selectionchange', selectionChanged);
    return () => document.removeEventListener('selectionchange', selectionChanged);
  }, [scrollRef]);
  const indexes = useMemo(() => {
    if (!selectedKeys.length) return [];
    const wanted = new Set(selectedKeys);
    const result: number[] = [];
    rows.forEach((row, index) => { if (wanted.has(row.key)) result.push(index); });
    return result;
  }, [rows, selectedKeys]);
  return useCallback((range: Range) => selectionRange(range, indexes), [indexes]);
}
