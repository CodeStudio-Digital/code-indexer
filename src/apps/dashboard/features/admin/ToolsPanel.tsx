import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible.js';
import { useAdminTools } from './hooks/useAdminTools.js';
import type { ToolConfigItem } from './tools-api.js';

const TIER_LABELS: Record<string, { label: string; description: string }> = {
  bootstrap: { label: 'Bootstrap', description: 'Always visible on turn 1 — read, search, discovery' },
  navigate: { label: 'Navigate', description: 'Promoted via expand_toolset — write, edit, git, LSP' },
  admin: { label: 'Admin', description: 'Never auto-promoted — git mutations, project admin' },
};

function tierMeta(tier: string): { label: string; description: string } {
  return TIER_LABELS[tier] ?? {
    label: tier.charAt(0).toUpperCase() + tier.slice(1),
    description: `External MCP — on-demand via expand_toolset("${tier}")`,
  };
}

function ToolRow({ tool, onToggle }: { tool: ToolConfigItem; onToggle: (name: string, disabled: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm truncate">{tool.name}</span>
          {tool.source === 'mcp' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0">mcp</Badge>
          )}
          {tool.source === 'mcp_external' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0 border-blue-300 text-blue-600">ext</Badge>
          )}
        </div>
        {tool.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">{tool.description}</div>
        )}
      </div>
      <Switch
        checked={!tool.globallyDisabled}
        onCheckedChange={(checked) => onToggle(tool.name, !checked)}
        className="shrink-0"
      />
    </div>
  );
}

function TierSection({
  tier,
  tools,
  count,
  onToggle,
}: {
  tier: string;
  tools: ToolConfigItem[];
  count: { total: number; enabled: number };
  onToggle: (name: string, disabled: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const meta = tierMeta(tier);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 hover:bg-muted/30 rounded px-2 cursor-pointer">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="font-semibold text-sm">{meta.label}</span>
        <span className="text-xs text-muted-foreground ml-1">{meta.description}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {count.enabled}/{count.total} enabled
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-6 space-y-0.5">
        {tools.length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">No matching tools</div>
        ) : (
          tools.map((t) => <ToolRow key={t.name} tool={t} onToggle={onToggle} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolsPanel() {
  const { byTier, counts, loading, filter, setFilter, toggle, sortedTiers } = useAdminTools();

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading tools...</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Globally disable tools so they are never available to any coder session.
        Useful to reduce noise or cap the tool count for smaller models.
      </p>

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter tools..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="space-y-1">
        {sortedTiers.map((tier) => (
          <TierSection
            key={tier}
            tier={tier}
            tools={byTier[tier] ?? []}
            count={counts[tier] ?? { total: 0, enabled: 0 }}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}
