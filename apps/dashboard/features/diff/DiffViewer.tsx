import React from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../hooks/useApi.js';

interface DiffEntry {
  path: string;
  language: string;
  summary: string;
}

interface DiffModified {
  path: string;
  language: string;
  summary_before: string;
  summary_after: string;
  symbols_added: Array<{ name: string; kind: string }>;
  symbols_removed: Array<{ name: string; kind: string }>;
  concepts_added: string[];
  concepts_removed: string[];
}

interface RunDiff {
  files_added: DiffEntry[];
  files_removed: DiffEntry[];
  files_modified: DiffModified[];
  total_symbols_added: number;
  total_symbols_removed: number;
  concepts_added: string[];
  concepts_removed: string[];
}

interface DiffViewerProps {
  projectId: number;
}

export default function DiffViewer({ projectId }: DiffViewerProps) {
  const { t } = useTranslation('projects');
  const { data: diff, loading, error } = useApi<RunDiff>(`/projects/${projectId}/diff`);

  if (loading) return <div className="text-muted-foreground text-sm">{t('diff.loading')}</div>;
  if (error) return <div className="text-muted-foreground text-sm">{t('diff.notEnoughRuns')}</div>;
  if (!diff) return <div className="text-muted-foreground text-sm">{t('diff.noData')}</div>;

  return (
    <div className="space-y-6">
      <div className="flex gap-6 text-sm flex-wrap">
        <span className="text-success">{t('diff.added', { count: diff.files_added.length })}</span>
        <span className="text-destructive">{t('diff.removed', { count: diff.files_removed.length })}</span>
        <span className="text-warning">{t('diff.modified', { count: diff.files_modified.length })}</span>
        <span className="text-muted-foreground">
          {t('diff.symbolsAdded', { added: diff.total_symbols_added })} / {t('diff.symbolsRemoved', { removed: diff.total_symbols_removed })}
        </span>
      </div>

      {diff.files_added.length > 0 && (
        <Section title={t('diff.addedFiles')} color="green">
          {diff.files_added.map((f) => (
            <FileRow key={f.path} path={f.path} language={f.language} summary={f.summary} />
          ))}
        </Section>
      )}

      {diff.files_removed.length > 0 && (
        <Section title={t('diff.removedFiles')} color="red">
          {diff.files_removed.map((f) => (
            <FileRow key={f.path} path={f.path} language={f.language} summary={f.summary} />
          ))}
        </Section>
      )}

      {diff.files_modified.length > 0 && (
        <Section title={t('diff.modifiedFiles')} color="yellow">
          {diff.files_modified.map((f) => (
            <div key={f.path} className="py-2 border-b last:border-0">
              <p className="font-mono text-sm">
                {f.path} <span className="text-muted-foreground">({f.language})</span>
              </p>
              {f.symbols_added.length > 0 && (
                <p className="text-xs text-success mt-1">
                  + {f.symbols_added.map((s) => s.name).join(', ')}
                </p>
              )}
              {f.symbols_removed.length > 0 && (
                <p className="text-xs text-destructive">
                  - {f.symbols_removed.map((s) => s.name).join(', ')}
                </p>
              )}
            </div>
          ))}
        </Section>
      )}

      {diff.concepts_added.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-1">{t('diff.newConcepts')}</h4>
          <div className="flex flex-wrap gap-1">
            {diff.concepts_added.map((c) => (
              <span key={c} className="px-2 py-0.5 rounded-md text-xs bg-success/15 text-success">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
  const borderColor =
    color === 'green'
      ? 'border-l-success'
      : color === 'red'
        ? 'border-l-destructive'
        : 'border-l-warning';
  return (
    <div className={`border-l-4 ${borderColor} pl-4`}>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      {children}
    </div>
  );
}

function FileRow({ path, language, summary }: { path: string; language: string; summary: string }) {
  return (
    <div className="py-1">
      <span className="font-mono text-sm">{path}</span>
      <span className="text-muted-foreground text-xs ml-2">({language})</span>
      <p className="text-xs text-muted-foreground">{summary.slice(0, 120)}</p>
    </div>
  );
}
