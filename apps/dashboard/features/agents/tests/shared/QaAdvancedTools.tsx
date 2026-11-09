import React, { useState } from 'react';
import { QaDiagnosticsPanel } from '../live/LiveRunView.js';
import { useQaDiagnostics } from '../live/useQaDiagnostics.js';
import { RestoreQaConfigButton } from './RestoreQaConfigButton.js';
import { UrlsDrawer } from './UrlsDrawer.js';

/** One optional area for legacy regression controls, below the QA content. */
export function QaAdvancedTools({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const diagnostics = useQaDiagnostics(sessionId, expanded);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="mx-3 mb-3 shrink-0 max-h-[45%] overflow-auto rounded border px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Regressão Playwright · opções avançadas</summary>
      <p className="my-2">Opcional para suítes repetíveis e CI. Configuração, URLs e diagnóstico ficam reunidos aqui.</p>
      <div className="flex items-center gap-2"><RestoreQaConfigButton sessionId={sessionId} onRestored={() => void diagnostics.refresh()} /><UrlsDrawer sessionId={sessionId} /></div>
      {expanded && <QaDiagnosticsPanel diagnostics={diagnostics.data} loading={diagnostics.loading} error={diagnostics.error} />}
    </details>
  );
}
