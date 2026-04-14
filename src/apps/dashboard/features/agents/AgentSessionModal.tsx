import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Crown, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useApi } from '../../hooks/useApi.js';
import { Markdown } from '../chat/messages/Markdown.js';

interface PersistedMessage {
  id: number;
  role: string;
  content_json: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

interface SessionData {
  session: {
    id: number;
    title: string;
    provider: string;
    model: string;
    status: string;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  messages: PersistedMessage[];
}

interface AgentSessionModalProps {
  coderSessionId: number;
  role: string;
  status: string;
  onClose: () => void;
}

export function AgentSessionModal({ coderSessionId, role, status, onClose }: AgentSessionModalProps) {
  const { t } = useTranslation('agents');
  const { data: sessionData } = useApi<SessionData>(`/coder/sessions/${coderSessionId}?full=1`);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-lg border shadow-xl w-full max-w-4xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center gap-2">
          {role === 'master' ? (
            <Crown className="h-4 w-4 text-yellow-400" />
          ) : (
            <Bot className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium capitalize">{role}</span>
          {sessionData && (
            <span className="text-xs text-muted-foreground">
              {sessionData.session.provider}/{sessionData.session.model}
            </span>
          )}
          <Badge variant="outline" className="text-[10px] capitalize">{status}</Badge>
          {sessionData && (
            <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
              {formatTokens(sessionData.session.total_input_tokens)} in / {formatTokens(sessionData.session.total_output_tokens)} out
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0 ml-2">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!sessionData && (
            <p className="text-sm text-muted-foreground text-center py-8">Loading session...</p>
          )}
          {sessionData?.messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: PersistedMessage }) {
  const blocks = parseContentBlocks(message.content_json);
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <div className={`rounded-lg border p-3 text-xs ${isUser ? 'bg-primary/5 border-primary/20' : 'bg-card'}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <Badge variant="outline" className="text-[9px]">{message.role}</Badge>
        <span className="text-[10px] text-muted-foreground">
          {formatTime(message.created_at)}
        </span>
        {(message.input_tokens > 0 || message.output_tokens > 0) && (
          <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
            {formatTokens(message.input_tokens + message.output_tokens)}
          </span>
        )}
      </div>
      {blocks.map((block, i) => (
        <div key={i}>
          {block.type === 'text' && block.text && (
            <Markdown text={block.text} />
          )}
          {block.type === 'tool_use' && (
            <div className="my-1 px-2 py-1 rounded bg-muted/50 font-mono text-[10px]">
              <span className="text-muted-foreground">tool:</span> {block.name}
            </div>
          )}
          {block.type === 'tool_result' && (
            <div className="my-1 px-2 py-1 rounded bg-muted/30 text-[10px] max-h-32 overflow-y-auto">
              <span className="text-muted-foreground">result:</span>{' '}
              {block.content && block.content.length > 200 ? block.content.slice(0, 200) + '...' : block.content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  content?: string;
}

function parseContentBlocks(json: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [{ type: 'text', text: json }];
  } catch {
    return [{ type: 'text', text: json }];
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** SQLite timestamps use space separator ("2026-04-10 17:41:22"), not ISO "T".
 *  new Date() fails in strict browsers without the T. */
function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? ts.slice(11, 19) : d.toLocaleTimeString();
}
