import { ArrowRight, ChevronRight, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import type { AdminProvider } from './types.js';

interface FallbackChainPanelProps {
  provider: AdminProvider;
  allProviders: AdminProvider[];
  onSetFallback: (providerId: string, fallbackProviderId: string | null) => void;
}

/**
 * Resolves the full fallback chain starting from a provider,
 * walking fallback_provider_id links. Stops at null, cycles, or max depth.
 */
function resolveChain(startId: string, providers: AdminProvider[]): AdminProvider[] {
  const chain: AdminProvider[] = [];
  const visited = new Set<string>();
  let currentId: string | null = startId;
  const providerMap = new Map(providers.map((p) => [p.id, p]));

  for (let i = 0; i < 10 && currentId; i++) {
    const current = providerMap.get(currentId);
    if (!current) break;
    const nextId = current.fallback_provider_id;
    if (!nextId) break;
    if (visited.has(nextId)) break; // cycle
    visited.add(nextId);
    const next = providerMap.get(nextId);
    if (!next) break;
    chain.push(next);
    currentId = nextId;
  }

  return chain;
}

export function FallbackChainPanel({ provider, allProviders, onSetFallback }: FallbackChainPanelProps) {
  const chain = resolveChain(provider.id, allProviders);

  // Build the list of providers available as fallback targets
  // Exclude: self, and providers already in the chain (to prevent cycles)
  const chainIds = new Set([provider.id, ...chain.map((p) => p.id)]);
  const available = allProviders.filter((p) => !chainIds.has(p.id) && p.enabled);

  // Find the last provider in the chain (or the current provider if chain is empty)
  const lastInChain = chain.length > 0 ? chain[chain.length - 1] : provider;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Fallback chain</span>
        <span>-</span>
        <span>Quando o provider falhar (429, timeout, 5xx), o sistema troca automaticamente</span>
      </div>

      {/* Visual chain */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Primary provider */}
        <Badge variant="default" className="text-xs py-1 px-2.5">
          {provider.name}
          <span className="ml-1 opacity-60">({provider.kind})</span>
        </Badge>

        {/* Chain links */}
        {chain.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <Badge variant="outline" className="text-xs py-1 px-2.5 group relative">
              {p.name}
              <span className="ml-1 opacity-60">({p.kind})</span>
              <button
                className="ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remover deste ponto da chain"
                onClick={() => {
                  // Remove this fallback link: set the PREVIOUS provider's fallback to null
                  const prevProvider = i === 0 ? provider : chain[i - 1];
                  onSetFallback(prevProvider.id, null);
                }}
              >
                <X className="h-3 w-3 text-destructive" />
              </button>
            </Badge>
          </div>
        ))}

        {/* Add next fallback */}
        {available.length > 0 && (
          <div className="flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value=""
              onValueChange={(val) => {
                if (val) onSetFallback(lastInChain.id, val);
              }}
            >
              <SelectTrigger className="h-7 w-[180px] text-xs">
                <SelectValue placeholder="+ Adicionar fallback" />
              </SelectTrigger>
              <SelectContent>
                {available.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name} ({p.kind})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {chain.length === 0 && available.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          Nenhum provider disponivel para fallback. Adicione mais providers habilitados.
        </p>
      )}
    </div>
  );
}
