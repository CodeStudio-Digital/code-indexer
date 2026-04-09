import { useState } from 'react';
import { Check, ClipboardList, Copy, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../messages/Markdown.js';

interface PlanPromptViewProps {
  plan: { id: string; plan: string; resolved?: 'approved' | 'rejected' };
  onResponse: (approved: boolean, feedback?: string) => Promise<void>;
}

export function PlanPromptView({ plan, onResponse }: PlanPromptViewProps) {
  const [feedback, setFeedback] = useState('');
  const [resolved, setResolved] = useState<string | undefined>(plan.resolved);
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plan.plan);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="my-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-7 w-7 rounded-md bg-warning/15 text-warning flex items-center justify-center">
          <ClipboardList className="h-4 w-4" />
        </div>
        <div className="text-xs font-semibold text-warning uppercase tracking-wider flex-1">
          Plan — awaiting approval
        </div>
        <Button size="sm" variant="outline" onClick={handleCopy} className="h-7 px-2 text-[11px]">
          {copied ? (
            <>
              <Check className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> Copy MD
            </>
          )}
        </Button>
      </div>
      <div className="text-sm text-foreground mb-3 px-1">
        <Markdown text={plan.plan} />
      </div>
      {!resolved ? (
        <>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Optional feedback…"
            rows={2}
            className="mb-2 text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="success"
              onClick={async () => {
                await onResponse(true, feedback);
                setResolved('approved');
              }}
            >
              <Check className="h-3.5 w-3.5" /> Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                await onResponse(false, feedback);
                setResolved('rejected');
              }}
            >
              <X className="h-3.5 w-3.5" /> Reject
            </Button>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'text-xs flex items-center gap-1.5',
            resolved === 'approved' ? 'text-success' : 'text-destructive',
          )}
        >
          {resolved === 'approved' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          {resolved}
        </div>
      )}
    </div>
  );
}
