/**
 * Endpoint detail in the doc shell: method+path, markdown description, parameter
 * docs, multi-language code samples (tabs), and saved real examples (req+resp).
 * Pure render of one DocEndpoint.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import { ResearchMarkdown } from '../../docs/research/ResearchMarkdown.js';
import { METHOD_COLOR } from '../collection/row-format.js';
import { DocBodyViewer } from './DocBodyViewer.js';
import type { DocEndpoint } from './types.js';

function statusTone(s: number | null): string {
  if (s == null) return 'text-muted-foreground';
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

export function EndpointView({ endpoint }: { endpoint: DocEndpoint }) {
  const { t } = useTranslation('apiClient');
  const [sample, setSample] = useState(endpoint.samples[0]?.target ?? '');
  const active = endpoint.samples.find((s) => s.target === sample) ?? endpoint.samples[0];

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-5">
      <div>
        <h1 className="text-lg font-semibold">{endpoint.name}</h1>
        <div className="mt-1 flex items-center gap-2 font-mono text-xs">
          <span className={cn('font-semibold', METHOD_COLOR[endpoint.method] ?? '')}>{endpoint.method}</span>
          <span className="text-muted-foreground break-all">{endpoint.path}</span>
        </div>
      </div>

      {endpoint.description
        ? <ResearchMarkdown text={endpoint.description} />
        : <p className="text-xs text-muted-foreground italic">{t('docs.noDescription')}</p>}

      {endpoint.paramDocs.length > 0 && (
        <section>
          <h2 className="text-sm font-medium mb-1.5">{t('docs.parameters')}</h2>
          <table className="text-xs w-full">
            <tbody>
              {endpoint.paramDocs.map((p) => (
                <tr key={`${p.in}:${p.name}`} className="border-b border-border/30 align-top">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">{p.name}<span className="ml-1 text-[10px] text-muted-foreground">{p.in}</span></td>
                  <td className="py-1 text-muted-foreground">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {active && (
        <section>
          <div className="flex items-center gap-1 mb-1.5">
            {endpoint.samples.map((s) => (
              <button key={s.target} type="button" onClick={() => setSample(s.target)}
                className={cn('text-[11px] px-2 py-0.5 rounded', s.target === active.target ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60')}>
                {s.language}
              </button>
            ))}
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-muted/40 border rounded p-2 max-h-72 overflow-auto">{active.code}</pre>
        </section>
      )}

      {endpoint.examples.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{t('docs.examples')}</h2>
          {endpoint.examples.map((ex, i) => (
            <div key={i} className="border rounded">
              <div className="flex items-center gap-2 px-2 py-1 border-b text-xs">
                <span className="font-medium">{ex.name}</span>
                {ex.status != null && <span className={cn('font-mono', statusTone(ex.status))}>{ex.status} {ex.statusText}</span>}
                {ex.contentType && <span className="ml-auto text-[10px] text-muted-foreground">{ex.contentType}</span>}
              </div>
              {ex.body && <DocBodyViewer body={ex.body} contentType={ex.contentType} />}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
