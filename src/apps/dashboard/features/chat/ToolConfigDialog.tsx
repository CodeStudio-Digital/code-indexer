import { ChevronDown, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible.js';
import { useSessionToolConfig, type SessionToolItem } from './hooks/useSessionToolConfig.js';

const TIER_LABELS: Record<string, string> = {
  bootstrap: 'Bootstrap',
  navigate: 'Navigate',
  admin: 'Admin',
};

function ToolRow({
  tool,
  onToggle,
}: {
  tool: SessionToolItem;
  onToggle: (name: string, disabled: boolean) => void;
}) {
  const isGloballyDisabled = tool.globallyDisabled;
  return (
    <div className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/50 gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`font-mono text-xs truncate ${isGloballyDisabled ? 'text-muted-foreground line-through' : ''}`}
          >
            {tool.name}
          </span>
          {tool.source === 'mcp' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0">mcp</Badge>
          )}
          {tool.source === 'mcp_external' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0 border-blue-300 text-blue-600">ext</Badge>
          )}
          {isGloballyDisabled && (
            <Badge variant="destructive" className="h-4 text-[10px] shrink-0">global off</Badge>
          )}
        </div>
        {tool.description && (
          <div className={`text-[11px] truncate mt-0.5 ${isGloballyDisabled ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
            {tool.description}
          </div>
        )}
      </div>
      <Switch
        checked={!tool.sessionDisabled && !isGloballyDisabled}
        disabled={isGloballyDisabled}
        onCheckedChange={(checked) => onToggle(tool.name, !checked)}
        className="shrink-0"
      />
    </div>
  );
}

function TierGroup({
  tier,
  tools,
  onToggle,
}: {
  tier: string;
  tools: SessionToolItem[];
  onToggle: (name: string, disabled: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const enabled = tools.filter((t) => !t.globallyDisabled && !t.sessionDisabled).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-1.5 hover:bg-muted/30 rounded px-2 cursor-pointer">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="font-semibold text-xs">
          {TIER_LABELS[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1)}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {enabled}/{tools.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-5 space-y-0">
        {tools.length === 0 ? (
          <div className="text-xs text-muted-foreground py-1">No matching tools</div>
        ) : (
          tools.map((t) => <ToolRow key={t.name} tool={t} onToggle={onToggle} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ToolConfigDialogProps {
  sessionId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ToolConfigDialog({ sessionId, open, onOpenChange }: ToolConfigDialogProps) {
  const {
    byTier,
    sortedTiers,
    activeCount,
    disabledCount,
    globalDisabledCount,
    loading,
    filter,
    setFilter,
    toggle,
    resetAll,
  } = useSessionToolConfig(open ? sessionId : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Session Tools</DialogTitle>
          <DialogDescription>
            Enable or disable tools for this session. Globally disabled tools (admin) cannot be toggled here.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-sm text-muted-foreground py-4">Loading...</div>
        ) : (
          <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>Active: <strong className="text-foreground">{activeCount}</strong></span>
              {disabledCount > 0 && (
                <span>Session disabled: <strong className="text-orange-500">{disabledCount}</strong></span>
              )}
              {globalDisabledCount > 0 && (
                <span>Global disabled: <strong className="text-destructive">{globalDisabledCount}</strong></span>
              )}
              {disabledCount > 0 && (
                <Button variant="ghost" size="sm" className="ml-auto h-6 text-xs gap-1" onClick={() => void resetAll()}>
                  <RotateCcw className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter tools..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>

            <div className="flex-1 overflow-auto space-y-1 -mx-2 px-2">
              {sortedTiers.map((tier) => (
                <TierGroup key={tier} tier={tier} tools={byTier[tier] ?? []} onToggle={toggle} />
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
