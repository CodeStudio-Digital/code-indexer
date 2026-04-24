import type React from 'react';
import { Eye, FolderTree, GitBranch } from 'lucide-react';

export interface TabDef {
  value: 'preview' | 'files' | 'git';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * Declarative tab list. Adding a new tab = appending here and rendering
 * its body in PreviewContainer (open/closed for extension).
 */
export const PREVIEW_TABS: TabDef[] = [
  { value: 'preview', label: 'Preview', icon: Eye },
  { value: 'files', label: 'Files', icon: FolderTree },
  { value: 'git', label: 'Git', icon: GitBranch },
];
