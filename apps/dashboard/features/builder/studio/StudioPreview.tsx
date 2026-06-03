import React, { useCallback, useState } from 'react';
import type { SandboxSnapshot } from '../useSandboxStatus.js';
import type { PreviewToParentMessage } from '@mcp/services/sandbox/builder/protocol.js';
import { PreviewIframe } from '../preview/preview-iframe/PreviewIframe.js';
import { setSelected } from './studio-context-store.js';
import { SelectionChip } from './selection/SelectionChip.js';
import { usePreviewProblems } from './problems/usePreviewProblems.js';
import { useAutoFix } from './problems/useAutoFix.js';
import { ProblemsBadge } from './problems/ProblemsBadge.js';
import { DeviceFrameSwitcher, DEVICE_WIDTH, type DeviceFrame } from './DeviceFrameSwitcher.js';

export interface StudioPreviewProps {
  snapshot: SandboxSnapshot | null;
  onRefresh: () => void;
  onRetry: () => Promise<void>;
  onRestartDev: () => Promise<void>;
  sessionId: number;
  fileChangeTick?: number;
}

/**
 * Right pane of the Builder studio: the live preview enhanced with
 * element selection, a unified problems feed, and device-frame widths.
 * Routes the iframe's `mcp:*` messages to the selection store (so the chat
 * composer can prefix the next message) and the problems hook.
 */
export function StudioPreview({
  snapshot,
  onRefresh,
  onRetry,
  onRestartDev,
  sessionId,
  fileChangeTick,
}: StudioPreviewProps) {
  const [selectMode, setSelectMode] = useState(false);
  const [device, setDevice] = useState<DeviceFrame>('desktop');
  const { problems, add, clear, dismiss, errorCount } = usePreviewProblems();
  const { autoFixEnabled, setAutoFixEnabled } = useAutoFix(sessionId, problems);

  const onPreviewMessage = useCallback(
    (msg: PreviewToParentMessage) => {
      switch (msg.type) {
        case 'mcp:select':
          setSelected(sessionId, msg);
          break;
        case 'mcp:clear':
          setSelected(sessionId, null);
          break;
        case 'mcp:runtime-error':
        case 'mcp:network':
        case 'mcp:console':
          add(msg);
          break;
        // mcp:hover / mcp:ready — handled in the iframe layer.
      }
    },
    [sessionId, add],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0">
        <PreviewIframe
          snapshot={snapshot}
          onRefresh={onRefresh}
          onRetry={onRetry}
          onRestartDev={onRestartDev}
          sessionId={sessionId}
          fileChangeTick={fileChangeTick}
          selectMode={selectMode}
          onToggleSelectMode={() => setSelectMode((v) => !v)}
          onPreviewMessage={onPreviewMessage}
          frameWidth={DEVICE_WIDTH[device]}
          toolbarRightSlot={
            <>
              <DeviceFrameSwitcher value={device} onChange={setDevice} />
              <ProblemsBadge
                sessionId={sessionId}
                problems={problems}
                errorCount={errorCount}
                onDismiss={dismiss}
                onClear={clear}
                autoFixEnabled={autoFixEnabled}
                onToggleAutoFix={() => setAutoFixEnabled(!autoFixEnabled)}
              />
            </>
          }
        />
      </div>
      <div className="px-2 py-1 border-t bg-card empty:hidden">
        <SelectionChip sessionId={sessionId} />
      </div>
    </div>
  );
}
