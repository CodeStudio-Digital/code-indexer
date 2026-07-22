/**
 * Language-intelligence chip: which tier answers for the ACTIVE file.
 *   green  "LSP"     — built-in TS service or an installed external server
 *   sky    "index"   — structural-index fallback (def/refs/completion básicos)
 *   amber  "falhou"  — an installed server crashed (shows reason + retry)
 *   amber  "syntax"  — highlight only (no tree-sitter grammar / plaintext)
 * Status is LIVE (serverStatusStream): the chip flips green the moment a
 * late-spawning server becomes ready, instead of staying stale.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Database, Languages as LanguagesIcon, TriangleAlert } from 'lucide-react';
import { apiCall } from '../../../../lib/api-client.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip.js';
import { cn } from '../../../../lib/utils.js';
import { useServerStatus } from './useServerStatus.js';
import { AngularProfileControl } from './AngularProfileControl.js';

/** Languages the structural index understands (tree-sitter grammars). */
const INDEXED_LANGS = new Set([
  'typescript', 'javascript', 'python', 'php', 'go', 'rust', 'java', 'csharp',
  'kotlin', 'swift', 'ruby', 'c', 'cpp', 'css', 'scss', 'html', 'vue', 'json',
  'yaml', 'shell', 'lua', 'dart', 'scala',
]);

type Tier = 'lsp' | 'idle' | 'failed' | 'index' | 'syntax';

export function LanguageChip({ projectId, activeFilePath }: { projectId: number; activeFilePath: string | null }) {
  const { t } = useTranslation('workspace');
  const language = activeFilePath ? languageIdForPath(activeFilePath) : null;
  const builtin = language === 'typescript' || language === 'javascript';
  const [statusRefresh, setStatusRefresh] = useState(0);
  // TypeScript/JavaScript can also have a project-scoped overlay (Angular).
  // Query the effective route even though the built-in TS service remains the
  // fallback when that overlay is absent or not installed.
  const server = useServerStatus(
    projectId,
    !language || language === 'plaintext' ? null : language,
    activeFilePath,
    statusRefresh,
  );
  const [retrying, setRetrying] = useState(false);

  if (!language) {
    return <span className="text-muted-foreground">No file</span>;
  }

  const tier: Tier = server?.state === 'ready'
    ? 'lsp'
    : server?.state === 'idle'
      ? 'idle'
      : server?.state === 'failed'
        ? 'failed'
        : builtin
          ? 'lsp'
        : INDEXED_LANGS.has(language)
          ? 'index'
          : 'syntax';

  const label = language === 'plaintext' ? 'Plain text' : language;
  const tone =
    tier === 'lsp' ? 'text-emerald-500/90'
      : tier === 'idle' || tier === 'index' ? 'text-sky-400/90'
        : 'text-amber-500/80'; // failed + syntax
  const Icon = tier === 'lsp' ? Activity : tier === 'idle' || tier === 'index' ? Database : tier === 'failed' ? TriangleAlert : LanguagesIcon;
  const angularSuffix = server?.route?.projectMajor ? ` Angular ${server.route.projectMajor}` : '';
  const suffix = tier === 'lsp' ? ` · LSP${angularSuffix}` : tier === 'idle' ? ` · ${t('lspStatus.onDemandSuffix')}${angularSuffix}` : tier === 'index' ? ' · index' : tier === 'failed' ? ' · LSP falhou' : ' · syntax only';

  const retry = async () => {
    if (!server?.server) return;
    setRetrying(true);
    try {
      await apiCall('lsp.restartServer', {
        projectId,
        serverId: server.server.id,
        routeId: server.route?.routeId,
        file: activeFilePath ?? undefined,
      });
      // The status stream re-emits starting→ready; no manual refresh needed.
    } catch { /* surfaced by the stream staying on failed */ }
    finally { setRetrying(false); }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1 cursor-default', tone)}>
          <Icon className="h-2.5 w-2.5" />
          <span>{label}{suffix}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px]">
        <div>
        {tier === 'lsp' ? (
          <span>
            Full IntelliSense — completion · hover · Ctrl+Click · diagnostics
            {server?.state === 'ready' && server.server
              ? ` (via ${server.server.label}${server.route?.profileId ? `, ${server.route.profileId}` : ''}).`
              : ' (built-in TypeScript service).'}
          </span>
        ) : tier === 'idle' ? (
          <span>{t('lspStatus.idleDescription', { server: server?.server?.label ?? 'LSP' })}</span>
        ) : tier === 'failed' ? (
          <div className="space-y-1.5">
            <div>
              O servidor {server?.server?.label ?? 'LSP'} falhou ao iniciar
              {server?.reason ? <> — <span className="font-mono text-[10.5px] opacity-80">{server.reason}</span></> : '.'}
            </div>
            <div className="text-muted-foreground">Usando o índice estrutural enquanto isso.</div>
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {retrying ? 'Reiniciando…' : 'Tentar novamente'}
            </button>
          </div>
        ) : tier === 'index' ? (
          <span>
            Structural-index intelligence: go-to-definition, find usages, prefix completion and hover
            from tree-sitter symbols.
            {server?.state === 'not-installed' && server.server
              ? ` Install ${server.server.label} for full IntelliSense (banner on file open, or Admin → Language Servers).`
              : ''}
          </span>
        ) : (
          <span>Syntax highlight only — no grammar/index coverage for this file type.</span>
        )}
        {server && (
          <AngularProfileControl
            projectId={projectId}
            status={server}
            onApplied={() => setStatusRefresh((value) => value + 1)}
          />
        )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
