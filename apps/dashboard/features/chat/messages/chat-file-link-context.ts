import { createContext } from 'react';
import type { FileLink } from './markdown-links.js';

export const ChatFileLinkContext = createContext<{
  open: (link: FileLink, trigger: HTMLElement) => void;
  sourceFile?: string;
} | null>(null);
