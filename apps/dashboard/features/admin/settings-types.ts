/**
 * Shared types for the Admin/Settings shell. Extracted so the rail
 * (`SettingsRail`) and the registry (which still lives in `Admin.tsx`,
 * because it captures `t` + the providers section's handlers) can share
 * the same `SectionDef`/`GroupId` shapes without a circular import.
 */
import type { LucideIcon } from 'lucide-react';

export type SectionId =
  | 'providers'
  | 'capabilities'
  | 'app-settings'
  | 'semantic'
  | 'hygiene'
  | 'tools'
  | 'mcp-servers'
  | 'skills'
  | 'agents'
  | 'plugins'
  | 'ai-geral'
  | 'lsp-servers'
  | 'chrome-service'
  | 'pipeline-bindings'
  | 'perf';

export type GroupId = 'models' | 'knowledge' | 'extensions' | 'services' | 'system';

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** Which rail group this section is filed under (see `groups`). */
  group: GroupId;
  /** Optional descriptor — surfaces as muted-fg sub-text under each rail
   *  row so the user knows what the section covers without clicking. */
  hint?: string;
}

export interface GroupDef {
  id: GroupId;
  label: string;
}
