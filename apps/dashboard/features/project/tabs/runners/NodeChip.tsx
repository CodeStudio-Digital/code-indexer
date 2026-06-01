/**
 * Quick Node-version switcher shown in the Runners tab header. Reflects
 * the project's chosen runtime and lets the user change it inline (writes
 * `node_version` via PATCH). Applies to NEW terminals/runs only — existing
 * PTYs keep their PATH.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hexagon } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { apiCall } from '../../../../lib/api-client.js';
import { apiPatch } from '../../../../hooks/useApi.js';
import { NodeVersionSelect } from '../../runtime/NodeVersionSelect.js';

interface NodeChipProps {
  projectId: number;
}

export function NodeChip({ projectId }: NodeChipProps) {
  const { t } = useTranslation(['projects']);
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void apiCall<Project>('projects.get', { id: projectId })
      .then((p) => {
        if (alive) setNodeVersion(p.node_version ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId]);

  const change = useCallback(
    (id: string | null) => {
      setNodeVersion(id);
      void apiPatch(`/projects/${projectId}`, { node_version: id });
    },
    [projectId],
  );

  return (
    <div className="flex items-center gap-1.5" title={t('runtime.nodeHint')}>
      <Hexagon className="h-3.5 w-3.5 text-emerald-400" />
      <NodeVersionSelect value={nodeVersion} onChange={change} className="h-7 w-44 text-xs" />
    </div>
  );
}
