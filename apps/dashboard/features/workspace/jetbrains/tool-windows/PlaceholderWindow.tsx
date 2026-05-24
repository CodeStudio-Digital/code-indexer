/**
 * Stand-in tool window — used for Git / Snapshots / Inbox until their
 * real implementations land. Keeps the rail iconography in place so
 * users see what's coming.
 */

import { Construction } from 'lucide-react';
import { ToolWindowFrame } from '../ToolWindowFrame.js';

interface PlaceholderWindowProps {
  title: string;
  hint?: string;
  onClose?: () => void;
}

export function PlaceholderWindow({ title, hint, onClose }: PlaceholderWindowProps) {
  return (
    <ToolWindowFrame title={title} onClose={onClose}>
      <div className="h-full grid place-items-center px-6 text-center text-muted-foreground gap-3">
        <Construction className="h-5 w-5 opacity-50" />
        <div>
          <p className="text-[12px] font-medium text-foreground">{title} — coming soon</p>
          {hint && <p className="text-[10.5px] mt-1 leading-relaxed">{hint}</p>}
        </div>
      </div>
    </ToolWindowFrame>
  );
}
