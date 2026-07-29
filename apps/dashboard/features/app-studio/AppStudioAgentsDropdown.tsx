import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronDown } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import type { useCompanyStream } from '../../hooks/useCompanyStream.js';
import type { AgentStreamState } from '../../state/company/types.js';
import { AgentPane } from '../agents/AgentPane.js';
import { AgentSessionModal } from '../agents/AgentSessionModal.js';

const TERMINAL_STATUSES = new Set<AgentStreamState['status']>([
  'idle',
  'completed',
  'error',
  'aborted',
  'interrupted',
]);

export function isActiveAppAgent(agent: AgentStreamState): boolean {
  return !TERMINAL_STATUSES.has(agent.status);
}

export function collectActiveAppAgents(
  stream: Pick<ReturnType<typeof useCompanyStream>, 'masterState' | 'subordinateStates'>,
  masterSessionId: string | null,
): AgentStreamState[] {
  const agents: AgentStreamState[] = [];
  if (stream.masterState && isActiveAppAgent(stream.masterState)) {
    agents.push({
      ...stream.masterState,
      coderSessionId: stream.masterState.coderSessionId ?? masterSessionId ?? undefined,
    });
  }
  agents.push(...Array.from(stream.subordinateStates.values()).filter(isActiveAppAgent));
  return agents;
}

export function AppStudioAgentsDropdown({
  stream,
  masterSessionId,
}: {
  stream: ReturnType<typeof useCompanyStream>;
  masterSessionId: string | null;
}) {
  const { t } = useTranslation('appStudio');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{
    coderSessionId: string;
    role: string;
    status: string;
  } | null>(null);
  const agents = useMemo(
    () => collectActiveAppAgents(stream, masterSessionId),
    [stream.masterState, stream.subordinateStates, masterSessionId],
  );

  if (agents.length === 0) return null;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 border-emerald-500/30 bg-emerald-500/5 px-2 text-[11px] hover:bg-emerald-500/10"
            aria-label={t('v6.runningAgents.label', { count: agents.length })}
          >
            <span className="relative flex h-3.5 w-3.5 items-center justify-center">
              <Bot className="h-3.5 w-3.5 text-emerald-400" />
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 ring-2 ring-[var(--workbench-raised)]" />
            </span>
            <span className="hidden sm:inline">{t('v6.runningAgents.trigger')}</span>
            <span className="min-w-4 rounded bg-emerald-500/15 px-1 text-center font-semibold tabular-nums text-emerald-400">
              {agents.length}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1rem))] p-1.5">
          <DropdownMenuLabel className="flex items-center gap-2 px-1.5 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span>{t('v6.runningAgents.menuTitle')}</span>
            <span className="ml-auto rounded border px-1.5 py-0.5 text-[9px] tabular-nums">{agents.length}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-[min(28rem,70vh)] space-y-1.5 overflow-y-auto p-0.5">
            {agents.map((agent) => (
              <AgentPane
                key={`${agent.role}-${agent.agentRunId}`}
                agent={agent}
                onClick={agent.coderSessionId ? () => {
                  setOpen(false);
                  setSelected({
                    coderSessionId: agent.coderSessionId!,
                    role: agent.role,
                    status: agent.status,
                  });
                } : undefined}
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <AgentSessionModal
          coderSessionId={selected.coderSessionId}
          role={selected.role}
          status={selected.status}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
