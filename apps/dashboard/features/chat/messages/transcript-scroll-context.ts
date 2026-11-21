import { createContext } from 'react';
import type { VirtualItem } from '@tanstack/react-virtual';
import type { MarkdownDocument } from './markdown-document.js';

export interface MarkdownScrollLayout {
  source: string;
  document: MarkdownDocument;
  height: number;
  measurements: VirtualItem[];
}

export function findMarkdownLayout(layouts: ReadonlyMap<symbol, MarkdownScrollLayout>, text: string) {
  let prefix: MarkdownScrollLayout | undefined;
  for (const layout of layouts.values()) {
    if (layout.source === text) return layout;
    if (layout.source.length > (prefix?.source.length ?? 0) && text.startsWith(layout.source)) prefix = layout;
  }
  return prefix;
}

export const TranscriptScrollContext = createContext<{
  disengage: () => void;
  markdownLayouts: Map<symbol, MarkdownScrollLayout>;
} | null>(null);
