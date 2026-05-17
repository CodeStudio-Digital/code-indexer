/**
 * Diagnostic drawer that surfaces the URLs the QA stack uses for a
 * session. Three groups, side-by-side per microservice:
 *
 *   - PREVIEW_URL_*           → what the user's browser hits via the dashboard iframe.
 *   - PLAYWRIGHT_BASE_URL_*   → what the Chrome Service navigates to (proxy + cookie).
 *   - SERVICE_URL_*           → internal docker network sibling URL.
 *
 * Pure presentation — fetches the existing `/envs` endpoint and groups
 * keys client-side. No new route required.
 *
 * Renders nothing when there are zero matching env vars (e.g. session
 * without any provisioned sandbox); the caller hides its trigger button
 * in that case via the same hook return.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../../components/ui/dialog.js';
import { Button } from '../../../../components/ui/button.js';
import { Info } from 'lucide-react';

interface EnvRow {
  key: string;
  value: string;
  is_secret: boolean;
  source?: string;
}

interface Props {
  sessionId: number;
}

interface ServiceUrls {
  /** Uppercase id key — `MAIN`, `API`, `WORKER`. */
  id: string;
  preview?: string;
  playwright?: string;
  service?: string;
}

function groupByService(rows: EnvRow[]): ServiceUrls[] {
  const map = new Map<string, ServiceUrls>();
  const ensure = (id: string): ServiceUrls => {
    let entry = map.get(id);
    if (!entry) {
      entry = { id };
      map.set(id, entry);
    }
    return entry;
  };
  for (const row of rows) {
    if (row.key.startsWith('PREVIEW_URL_')) {
      ensure(row.key.slice('PREVIEW_URL_'.length)).preview = row.value;
    } else if (row.key.startsWith('SERVICE_URL_')) {
      ensure(row.key.slice('SERVICE_URL_'.length)).service = row.value;
    } else if (row.key.startsWith('PLAYWRIGHT_BASE_URL_')) {
      ensure(row.key.slice('PLAYWRIGHT_BASE_URL_'.length)).playwright = row.value;
    }
  }
  // Stable order — primary first, then alphabetical.
  return [...map.values()].sort((a, b) => {
    if (a.id === 'MAIN') return -1;
    if (b.id === 'MAIN') return 1;
    return a.id.localeCompare(b.id);
  });
}

export function UrlsDrawer({ sessionId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/company/sessions/${sessionId}/envs`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRows(Array.isArray(data?.envs) ? data.envs : []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  const groups = useMemo(() => groupByService(rows), [rows]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs h-7 gap-1">
          <Info className="h-3.5 w-3.5" />
          URLs
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>QA URL routing</DialogTitle>
          <p className="text-xs text-muted-foreground">
            How each microservice is addressed at three layers. The Chrome
            Service navigates to <code>PLAYWRIGHT_BASE_URL_*</code> via the
            http-api proxy with an HMAC cookie (auto-injected). Specs use
            relative paths (<code>page.goto('/login')</code>); the bundled
            <code> playwright.config.ts</code> wires the rest.
          </p>
        </DialogHeader>
        <div className="mt-4 space-y-4 max-h-[60vh] overflow-auto">
          {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {!loading && groups.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No managed URLs found for this session yet — provision a sandbox
              first (and assign a role with the <code>qa-playwright</code>{' '}
              skill to populate the QA family).
            </div>
          )}
          {groups.map((g) => (
            <section key={g.id} className="border rounded-md p-3 text-xs space-y-2">
              <header className="font-medium uppercase tracking-wide text-muted-foreground">
                {g.id === 'MAIN' ? 'main (primary)' : g.id.toLowerCase()}
              </header>
              <UrlRow label="Preview (browser)" value={g.preview} />
              <UrlRow label="Playwright (QA)" value={g.playwright} accent />
              <UrlRow label="Service (internal)" value={g.service} />
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UrlRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | undefined;
  accent?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className={`shrink-0 ${accent ? 'text-foreground' : 'text-muted-foreground'}`}>
        {label}:
      </span>
      <code className="flex-1 break-all text-right font-mono text-[11px]">
        {value ?? <span className="text-muted-foreground italic">not injected</span>}
      </code>
    </div>
  );
}
