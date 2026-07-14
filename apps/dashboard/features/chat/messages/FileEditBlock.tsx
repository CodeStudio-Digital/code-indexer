/**
 * File-first render for the edit tools (edit_file / multi_edit / write_file /
 * create_file / apply_patch) — replaces the generic tool card with the list of
 * files the call touched, each expandable to an inline diff. Failures fall back
 * to a visible error so a failed edit is never disguised as a success.
 */
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { ToolCallEvent } from '../../../hooks/useAgentStream.js';
import { ToolApprovalCard, type ToolApprovalVerdict } from './ToolApprovalCard.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { FileChangeRow } from './FileChangeRow.js';
import { filesFromEditToolCall } from './edit-tools.js';

export function FileEditBlock({
  call,
  onToolApproval,
}: {
  call: ToolCallEvent;
  onToolApproval?: (toolUseId: string, verdict: ToolApprovalVerdict) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const refs = filesFromEditToolCall(call.name, call.input);

  // Couldn't identify a file (odd input) → keep the generic block so nothing is lost.
  if (refs.length === 0) {
    return <ToolCallBlock call={call} onToolApproval={onToolApproval} />;
  }

  // A failed edit: surface the error, don't imply a successful change.
  if (call.result?.isError) {
    return <ToolCallBlock call={call} onToolApproval={onToolApproval} />;
  }

  const running = call.status === 'running';

  return (
    <div className="my-2 space-y-1">
      {onToolApproval && call.approvals && call.approvals.length > 0 && (
        <div className="rounded-lg border bg-background/50 px-3 py-2">
          <ToolApprovalCard approvals={call.approvals} onRespond={onToolApproval} />
        </div>
      )}
      {refs.map((ref) => (
        // Tool-call rows must never fall back to the cumulative global
        // baseline. The completed-round summary below the response owns the
        // frozen diff; the global baseline is actionable only in its modal.
        <FileChangeRow key={`${ref.path}:${ref.op}`} file={ref} />
      ))}
      {running && (
        <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('messages.editing', { defaultValue: 'editing…' })}
        </div>
      )}
    </div>
  );
}
