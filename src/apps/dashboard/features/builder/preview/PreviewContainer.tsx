import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs.js';
import type { SandboxSnapshot } from '../useSandboxStatus.js';
import { PreviewIframe } from './preview-iframe/PreviewIframe.js';
import { FilesTab } from './files/FilesTab.js';
import { GitTab } from './git/GitTab.js';
import { ApiReferenceTab } from './api-reference/ApiReferenceTab.js';
import { useSessionProjects } from './useSessionProjects.js';
import { PREVIEW_TABS, type TabValue } from './tabs.js';

export interface PreviewContainerProps {
  snapshot: SandboxSnapshot | null;
  onRefresh: () => void;
  onRetry: () => Promise<void>;
  onRestartDev: () => Promise<void>;
  sessionId: number;
  fileChangeTick?: number;
  extraServices?: Array<{
    id: string;
    label: string;
    previewUrl: string;
    status: string;
    runtimePaused?: boolean;
  }>;
}

/**
 * Right-hand panel of BuilderView. Tabs: Preview (iframe + toolbar),
 * Files (read-only filesystem tree), Git (status/diff/log + init),
 * API Reference (Scalar render of openapi.{yaml,json}).
 * All tabs share the same session's linked projects via
 * `useSessionProjects`.
 */
export function PreviewContainer(props: PreviewContainerProps) {
  const [tab, setTab] = useState<TabValue>('preview');
  const { projects } = useSessionProjects(props.sessionId);

  return (
    <div className="flex flex-col h-full bg-card border-l">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as TabValue)}
        className="flex flex-col h-full min-h-0"
      >
        <div className="px-2 pt-2 border-b">
          <TabsList className="h-8 p-0.5">
            {PREVIEW_TABS.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value} className="text-xs px-2.5 py-1 gap-1.5">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="preview" className="flex-1 min-h-0 mt-0 outline-none">
          <PreviewIframe {...props} />
        </TabsContent>
        <TabsContent value="files" className="flex-1 min-h-0 mt-0 outline-none">
          <FilesTab sessionId={props.sessionId} projects={projects} />
        </TabsContent>
        <TabsContent value="git" className="flex-1 min-h-0 mt-0 outline-none">
          <GitTab sessionId={props.sessionId} projects={projects} />
        </TabsContent>
        <TabsContent value="api-reference" className="flex-1 min-h-0 mt-0 outline-none">
          <ApiReferenceTab
            sessionId={props.sessionId}
            snapshot={props.snapshot}
            extraServices={props.extraServices ?? []}
            fileChangeTick={props.fileChangeTick}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
