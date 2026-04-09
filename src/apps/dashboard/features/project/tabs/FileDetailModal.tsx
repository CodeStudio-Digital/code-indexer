import { Badge } from '../../../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { useApi } from '../../../hooks/useApi.js';
import { complexityVariant, type FileDetail } from '../types.js';

interface FileDetailModalProps {
  projectId: number;
  filePath: string;
  onClose: () => void;
}

export function FileDetailModal({ projectId, filePath, onClose }: FileDetailModalProps) {
  const { data: file, loading } = useApi<FileDetail>(`/projects/${projectId}/files/${filePath}`);
  const concepts: string[] = (() => {
    try {
      return file ? JSON.parse(file.concepts) : [];
    } catch {
      return [];
    }
  })();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        {loading || !file ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono text-base break-all pr-6">{file.path}</DialogTitle>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <Badge variant="info">{file.language}</Badge>
                <Badge variant="info">{file.layer}</Badge>
                <Badge variant={complexityVariant(file.complexity)}>{file.complexity}</Badge>
                <Badge variant="muted">{file.line_count} lines</Badge>
                {file.is_entry_point === 1 && <Badge variant="default">entry-point</Badge>}
                {file.is_test === 1 && <Badge variant="warning">test</Badge>}
                {file.is_generated === 1 && <Badge variant="muted">generated</Badge>}
              </div>
            </DialogHeader>

            <div className="space-y-5 mt-2">
              {file.summary && (
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                    Summary
                  </h3>
                  <p className="text-sm text-foreground/90">{file.summary}</p>
                </section>
              )}

              {concepts.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Concepts
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {concepts.map((c) => (
                      <Badge key={c} variant="secondary">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}

              {file.symbols.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Symbols ({file.symbols.length})
                  </h3>
                  <div className="space-y-2">
                    {file.symbols.map((s) => {
                      const tags: string[] = (() => {
                        try {
                          return JSON.parse(s.tags);
                        } catch {
                          return [];
                        }
                      })();
                      return (
                        <div key={s.id} className="p-3 rounded-lg border bg-muted/30">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge variant="outline" className="font-mono">
                              {s.kind}
                            </Badge>
                            <span className="font-mono text-sm font-medium">{s.name}</span>
                            {s.line && <span className="text-xs text-muted-foreground">L{s.line}</span>}
                            {s.parent && (
                              <span className="text-xs text-muted-foreground">parent: {s.parent}</span>
                            )}
                          </div>
                          {s.signature && (
                            <p className="font-mono text-xs text-muted-foreground mb-1">{s.signature}</p>
                          )}
                          {s.comment && <p className="text-xs text-muted-foreground">{s.comment}</p>}
                          {tags.length > 0 && (
                            <div className="flex gap-1 mt-1.5">
                              {tags.map((t) => (
                                <Badge key={t} variant="muted">
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {file.dependencies.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Dependencies ({file.dependencies.length})
                  </h3>
                  <div className="space-y-1">
                    {file.dependencies.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <Badge variant={d.dep_type === 'internal' ? 'success' : 'muted'}>{d.dep_type}</Badge>
                        <span className="font-mono">{d.import_path}</span>
                        {d.target_file_path && (
                          <span className="text-muted-foreground">→ {d.target_file_path}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {file.dependents.length > 0 && (
                <section>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Used by ({file.dependents.length} files)
                  </h3>
                  <div className="space-y-1">
                    {file.dependents.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-primary">{d.source_file_path}</span>
                        <span className="text-muted-foreground">via {d.import_path}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
