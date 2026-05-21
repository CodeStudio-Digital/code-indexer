/**
 * SuggestionsPanel — surface auto-discovery output to the user.
 *
 * Two surfaces:
 *   1. "Scan dependencies" CTA — triggers POST /api/docs-agent/suggestions/scan
 *      against the currently-selected project. Result counters surface inline.
 *   2. Per-row "Approve" / "Dismiss" actions on each pending suggestion.
 *      Approve opens a tiny inline picker to assign the suggestion to an
 *      existing collection or create a new one.
 */
import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Search, RefreshCcw, ExternalLink } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  type DocSourceSuggestion,
  type ScanResult,
  approveSuggestion,
  dismissSuggestion,
  listSuggestions,
  scanSuggestions,
} from './suggestions-api.js';
import { listCollections, type DocCollection } from '../docs-api.js';

interface Props {
  /** Currently-selected project id. Null disables the panel. */
  projectId: number | null;
  /** Notify parent when a suggestion gets approved (so collections list refreshes). */
  onChanged?: () => void;
}

export function SuggestionsPanel({ projectId, onChanged }: Props) {
  const [suggestions, setSuggestions] = useState<DocSourceSuggestion[] | null>(null);
  const [collections, setCollections] = useState<DocCollection[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function refresh() {
    if (projectId == null) return;
    try {
      const [list, allCollections] = await Promise.all([
        listSuggestions({ projectId, status: 'pending' }),
        listCollections(),
      ]);
      setSuggestions(list);
      setCollections(allCollections);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleScan() {
    if (projectId == null) return;
    setScanning(true);
    setError(null);
    setScanResult(null);
    try {
      const result = await scanSuggestions(projectId);
      setScanResult(result);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function handleApprove(suggestion: DocSourceSuggestion, collectionName: string) {
    setPendingId(suggestion.id);
    setError(null);
    try {
      await approveSuggestion(suggestion.id, { collectionName });
      await refresh();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  async function handleDismiss(id: number) {
    setPendingId(id);
    setError(null);
    try {
      await dismissSuggestion(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  if (projectId == null) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
        Select a project to scan its dependency manifests.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Suggested collections</h3>
          <p className="text-sm text-muted-foreground">
            Scans <code className="bg-muted px-1 rounded text-xs">package.json</code>,{' '}
            <code className="bg-muted px-1 rounded text-xs">requirements.txt</code>,{' '}
            <code className="bg-muted px-1 rounded text-xs">Cargo.toml</code>,{' '}
            <code className="bg-muted px-1 rounded text-xs">go.mod</code>,{' '}
            <code className="bg-muted px-1 rounded text-xs">composer.json</code>, and{' '}
            <code className="bg-muted px-1 rounded text-xs">Gemfile</code> for packages whose docs
            you may want to index.
          </p>
        </div>
        <Button onClick={handleScan} disabled={scanning} variant="secondary">
          {scanning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scanning…
            </>
          ) : (
            <>
              <RefreshCcw className="mr-2 h-4 w-4" />
              Scan dependencies
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {scanResult && (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          Scan complete: detected <strong>{scanResult.packagesDetected}</strong> packages across{' '}
          {scanResult.manifestsFound.length > 0
            ? scanResult.manifestsFound.join(', ')
            : 'no manifests'}
          , inserted <strong>{scanResult.suggestionsInserted}</strong> new suggestions, skipped{' '}
          <strong>{scanResult.suggestionsSkipped}</strong> (already known or unresolvable).
        </div>
      )}

      {suggestions == null ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : suggestions.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Search className="h-5 w-5" />
          <span>No pending suggestions. Click “Scan dependencies” to populate.</span>
        </div>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((s) => (
            <SuggestionRow
              key={s.id}
              suggestion={s}
              collections={collections ?? []}
              pending={pendingId === s.id}
              onApprove={(collectionName) => handleApprove(s, collectionName)}
              onDismiss={() => handleDismiss(s.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface RowProps {
  suggestion: DocSourceSuggestion;
  collections: DocCollection[];
  pending: boolean;
  onApprove: (collectionName: string) => void;
  onDismiss: () => void;
}

function SuggestionRow({ suggestion, collections, pending, onApprove, onDismiss }: RowProps) {
  // Default to the package_manager as collection name — gives a clean
  // grouping ("npm-docs", "pypi-docs") that the user can override.
  const defaultCollection =
    collections.find((c) => c.name === `${suggestion.package_manager}-docs`)?.name ??
    `${suggestion.package_manager}-docs`;
  const [collectionName, setCollectionName] = useState(defaultCollection);

  const confidencePct = Math.round(suggestion.confidence * 100);
  const confidenceTone =
    confidencePct >= 60
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : confidencePct >= 40
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        : 'bg-muted text-muted-foreground';

  return (
    <li className="rounded-md border bg-card px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
              {suggestion.package_manager}
            </span>
            <span className="font-semibold text-sm">{suggestion.package_name}</span>
            {suggestion.package_version && (
              <span className="text-xs text-muted-foreground">v{suggestion.package_version}</span>
            )}
            <span className={`text-xs px-1.5 py-0.5 rounded ${confidenceTone}`}>
              {confidencePct}% confident
            </span>
          </div>
          {suggestion.suggested_title && (
            <p className="text-sm text-muted-foreground line-clamp-2">{suggestion.suggested_title}</p>
          )}
          <a
            href={suggestion.suggested_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline truncate max-w-full"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">{suggestion.suggested_url}</span>
          </a>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
              disabled={pending}
              className="h-8 w-44 rounded-md border bg-background px-2 text-xs"
              placeholder="collection name"
            />
            <Button
              size="sm"
              onClick={() => onApprove(collectionName.trim())}
              disabled={pending || collectionName.trim().length === 0}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              <span className="ml-1">Approve</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDismiss}
              disabled={pending}
            >
              <XCircle className="h-3 w-3" />
              <span className="ml-1">Dismiss</span>
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
