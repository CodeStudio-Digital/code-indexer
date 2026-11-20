import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible.js';
import { useAdminTools } from './hooks/useAdminTools.js';
import type { ToolConfigItem } from './tools-api.js';

const TIER_LABEL_KEYS: Record<string, string> = {
  bootstrap: 'tools.bootstrap',
  navigate: 'tools.navigate',
  admin: 'tools.admin',
};
const TIER_DESC_KEYS: Record<string, string> = {
  bootstrap: 'tools.bootstrapDesc',
  navigate: 'tools.navigateDesc',
  admin: 'tools.adminDesc',
};

function ToolRow({ tool, onToggle }: { tool: ToolConfigItem; onToggle: (name: string, disabled: boolean) => void }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm truncate">{tool.name}</span>
          {tool.source === 'index' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0">{t('tools.index')}</Badge>
          )}
          {tool.source === 'mcp_external' && (
            <Badge variant="outline" className="h-4 text-[10px] shrink-0 border-blue-300 text-blue-600">{t('tools.ext')}</Badge>
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
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(true);
  const label = TIER_LABEL_KEYS[tier] ? t(TIER_LABEL_KEYS[tier]) : tier.charAt(0).toUpperCase() + tier.slice(1);
  const description = TIER_DESC_KEYS[tier] ? t(TIER_DESC_KEYS[tier]) : t('tools.externalMcp', { tier });

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 hover:bg-muted/30 rounded px-2 cursor-pointer">
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="font-semibold text-sm">{label}</span>
        <span className="text-xs text-muted-foreground ml-1">{description}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {t('tools.enabledCount', { enabled: count.enabled, total: count.total })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pl-6 space-y-0.5">
        {tools.length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">{t('tools.noMatch')}</div>
        ) : (
          tools.map((t) => <ToolRow key={t.name} tool={t} onToggle={onToggle} />)
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolsPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const { byTier, counts, loading, filter, setFilter, toggle, sortedTiers } = useAdminTools();

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('admin:tools.description')}
      </p>

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('admin:tools.filterPlaceholder')}
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
