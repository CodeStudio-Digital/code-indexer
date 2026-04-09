import { useState } from 'react';
import { Badge } from '../../../components/ui/badge.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { useApi } from '../../../hooks/useApi.js';
import type { CircularDep, Dependency, Dependent } from '../types.js';

interface DependenciesTabProps {
  projectId: number;
}

type DepMode = 'deps' | 'dependents' | 'circular';

export function DependenciesTab({ projectId }: DependenciesTabProps) {
  const [filePath, setFilePath] = useState('');
  const [mode, setMode] = useState<DepMode>('deps');
  const [queryPath, setQueryPath] = useState('');

  const { data: deps } = useApi<Dependency[]>(
    queryPath && mode === 'deps'
      ? `/projects/${projectId}/dependencies?file=${encodeURIComponent(queryPath)}`
      : '',
  );
  const { data: dependents } = useApi<Dependent[]>(
    queryPath && mode === 'dependents'
      ? `/projects/${projectId}/dependents?file=${encodeURIComponent(queryPath)}`
      : '',
  );
  const { data: circular } = useApi<CircularDep[]>(
    mode === 'circular' ? `/projects/${projectId}/circular-deps` : '',
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <Select value={mode} onValueChange={(v) => setMode(v as DepMode)}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deps">Dependencies (imports)</SelectItem>
            <SelectItem value="dependents">Dependents (who imports)</SelectItem>
            <SelectItem value="circular">Circular Dependencies</SelectItem>
          </SelectContent>
        </Select>
        {mode !== 'circular' && (
          <>
            <Input
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="src/store/db.ts"
              onKeyDown={(e) => e.key === 'Enter' && filePath.trim() && setQueryPath(filePath.trim())}
              className="flex-1 font-mono"
            />
            <Button onClick={() => filePath.trim() && setQueryPath(filePath.trim())}>Search</Button>
          </>
        )}
      </div>

      {mode === 'deps' && deps && (
        <div className="space-y-1">
          {deps.length === 0 ? (
            <p className="text-muted-foreground text-sm">No dependencies found.</p>
          ) : (
            deps.map((d, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md border text-sm">
                <Badge variant={d.dep_type === 'internal' ? 'success' : 'muted'}>{d.dep_type}</Badge>
                <span className="font-mono text-xs">{d.import_path}</span>
                {d.target_file_path && (
                  <span className="text-muted-foreground text-xs">→ {d.target_file_path}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {mode === 'dependents' && dependents && (
        <div className="space-y-1">
          {dependents.length === 0 ? (
            <p className="text-muted-foreground text-sm">No dependents found.</p>
          ) : (
            dependents.map((d, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md border text-sm">
                <span className="font-mono text-xs">{d.source_file_path}</span>
                <span className="text-muted-foreground text-xs">via {d.import_path}</span>
              </div>
            ))
          )}
        </div>
      )}

      {mode === 'circular' && circular && (
        <div className="space-y-1">
          {circular.length === 0 ? (
            <p className="text-muted-foreground text-sm">No circular dependencies found.</p>
          ) : (
            circular.map((d, i) => (
              <div
                key={i}
                className="flex items-center gap-2 p-2 rounded-md border border-destructive/40 bg-destructive/5 text-sm"
              >
                <span className="font-mono text-xs">{d.file_a}</span>
                <span className="text-destructive">↔</span>
                <span className="font-mono text-xs">{d.file_b}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
