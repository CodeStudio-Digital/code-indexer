/**
 * Reference pane — embeds Scalar's API reference (lazy; heavy bundle) fed by the
 * DocModel's OpenAPI. Same integration as builder/preview ApiReferenceTab.
 */
import React, { Suspense, useMemo } from 'react';
import { Loader2 } from 'lucide-react';

const ScalarApiReference = React.lazy(() =>
  import('@scalar/api-reference-react').then((m) => ({
    default: (m as { ApiReferenceReact: React.ComponentType<{ configuration: unknown }> }).ApiReferenceReact,
  })),
);

function prefersDark(): boolean {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false; } catch { return false; }
}

export function ReferenceSection({ openapi }: { openapi: unknown }) {
  const configuration = useMemo(() => ({
    spec: { content: openapi as Record<string, unknown> },
    hideClientButton: false,
    hideDownloadButton: false,
    darkMode: prefersDark(),
  }), [openapi]);

  return (
    <Suspense fallback={<div className="h-full grid place-items-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
      <ScalarApiReference configuration={configuration} />
    </Suspense>
  );
}
