import React, { useEffect, useRef } from 'react';
import { MessageSquare, Zap, HelpCircle, Package, ArrowRightLeft } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { cn } from '../../lib/utils.js';
import type { BoardMessage } from '../../hooks/useCompanyStream.js';

const KIND_ICONS: Record<string, React.FC<{ className?: string }>> = {
  message: MessageSquare,
  decision: Zap,
  question: HelpCircle,
  deliverable: Package,
  handoff: ArrowRightLeft,
};

const ROLE_COLORS: Record<string, string> = {
  master: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  frontend: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  backend: 'bg-green-500/20 text-green-400 border-green-500/30',
  qa: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  po: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  reviewer: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  critic: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function getRoleColor(role: string): string {
  return ROLE_COLORS[role] ?? 'bg-muted text-muted-foreground border-border';
}

interface BoardPanelProps {
  messages: BoardMessage[];
}

export function BoardPanel({ messages }: BoardPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Board</span>
        <Badge variant="outline" className="text-[10px]">{messages.length}</Badge>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No board activity yet.</p>
        )}
        {messages.map((msg) => {
          const Icon = KIND_ICONS[msg.kind] ?? MessageSquare;
          return (
            <div key={msg.id} className="rounded-md border p-2 text-xs space-y-1">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className={cn('text-[10px] px-1.5', getRoleColor(msg.author_role))}>
                  @{msg.author_role}
                </Badge>
                <Icon className="h-3 w-3 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(msg.created_at).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
                {highlightMentions(msg.content)}
              </p>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function highlightMentions(text: string): React.ReactNode {
  const parts = text.split(/(@\w+)/g);
  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <strong key={i} className="text-foreground">{part}</strong>
    ) : (
      part
    ),
  );
}
