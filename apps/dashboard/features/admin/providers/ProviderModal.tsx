/**
 * Full-screen-ish dialog that wraps `ProviderCard` in always-expanded
 * mode. The grid tile (`ProviderTile`) is the entry point; this modal
 * keeps every per-provider control (test / refresh / edit / remove /
 * model list / subagent target / fallback chain) in one place instead
 * of competing for space in a horizontal row.
 *
 * The legacy `ProviderCard` is reused verbatim — it already implements
 * the expanded body and all callbacks. We hide its outer `<Card>` chrome
 * by overriding the dialog content's background and force-render the
 * expanded block via `isExpanded={true}`.
 */
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { cn } from '../../../lib/utils.js';
import { ProviderCard } from '../ProviderCard.js';
import type { AddModelInput } from './AddModelForm.js';
import type { AdminModel, AdminProvider, TestResult } from '../types.js';
import { providerVisual } from './provider-icons.js';

export interface ProviderModalProps {
  /** When non-null, the dialog is open and renders this provider. */
  provider: AdminProvider | null;
  allProviders: AdminProvider[];
  models: AdminModel[];
  providerModelsById: Record<string, AdminModel[]>;
  testResult: TestResult | undefined;
  refreshing: boolean;
  onClose: () => void;
  onTest: () => void;
  onLoadProviderModels: (providerId: string) => void | Promise<void>;
  onRefresh: () => void;
  onEdit: () => void;
  onConnect?: () => void;
  onRemove: () => void;
  onToggleModel: (modelId: string, mode: string, enabled: boolean) => void;
  onAddModel: (input: AddModelInput) => void;
  onDeleteModel: (modelId: string, mode: string) => void;
  onSetModelEffort: (modelId: string, mode: string, level: string | null) => void;
  onSetModelContextWindow: (modelId: string, mode: string, value: number | null) => void;
  onSetModelMaxOutputTokens: (modelId: string, mode: string, value: number | null) => void;
  onSetModelMaxTools: (modelId: string, mode: string, value: number | null) => void;
  onBackfillContextWindows: () => void;
  onSetFallback: (providerId: string, fallbackProviderId: string | null) => void;
  onSetSubagentTarget: (
    providerId: string,
    subagentProviderId: string | null,
    modelId: string | null,
    profile?: string,
  ) => void;
  onSetSubagentEffort: (
    providerId: string,
    effort: string | null,
    profile?: string,
  ) => void;
  onSetSubagentLimits: (
    providerId: string,
    profile: string,
    patch: { maxToolCalls?: number | null; timeoutMs?: number | null },
  ) => void;
}

export function ProviderModal({ provider, onClose, ...rest }: ProviderModalProps) {
  const { t } = useTranslation(['admin']);
  const open = provider != null;
  if (!provider) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent />
      </Dialog>
    );
  }
  const { icon: Icon, fg, bg } = providerVisual(provider);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b shrink-0 flex-row items-center gap-3 space-y-0">
          <div className={cn('h-9 w-9 rounded-md flex items-center justify-center shrink-0', bg)}>
            <Icon className={cn('h-4 w-4', fg)} />
          </div>
          <div className="flex-1 min-w-0">
            <DialogTitle className="text-sm font-semibold truncate">
              {provider.name}
            </DialogTitle>
            <DialogDescription className="text-[11px] uppercase tracking-wide">
              {provider.kind}
              {provider.has_key && provider.api_key_masked && (
                <span className="ml-2 normal-case font-mono">
                  {provider.api_key_masked}
                </span>
              )}
            </DialogDescription>
          </div>
        </DialogHeader>

        {/* Body is the legacy ProviderCard in always-expanded mode.
            We wrap it in a scrollable container; the card's own
            `<Card>` shell carries a subtle border that doubles as a
            visual separator from the dialog header — good enough.
            The `provider-card-in-modal` class lets us tame the
            ProviderCard's outer chrome (no double-border with the
            DialogContent) via a single global rule kept here. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 [&_.provider-card-shell]:border-0 [&_.provider-card-shell]:shadow-none">
          <ProviderCard
            {...rest}
            provider={provider}
            isExpanded
            onToggleExpand={() => {
              /* expanded permanently inside the modal */
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for convenience.
export { providerVisual };
