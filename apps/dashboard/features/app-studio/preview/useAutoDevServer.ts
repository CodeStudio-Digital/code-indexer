/**
 * Runner automático do App Studio: garante o dev server do projeto de pé
 * sem o leigo saber o que é um dev server. Start one-shot no mount quando
 * parado; re-arma UMA vez se o processo morrer (crash de config etc.) —
 * depois disso o ProjectPreview mostra os controles normais.
 */
import { useEffect, useRef } from 'react';
import { useProjectDevServer } from '../../project/builder/useProjectDevServer.js';

export function useAutoDevServer(projectId: number, pinnedPort?: number): { status: string; url: string | null } {
  const { status, url, start } = useProjectDevServer(projectId, { pinnedPort });
  const attempts = useRef(0);

  useEffect(() => {
    if (status === 'running') return;
    if (attempts.current >= 2) return; // start inicial + 1 retry
    attempts.current += 1;
    void start();
    // `start` é estável o suficiente para o caso; re-executa quando o
    // status transiciona (stopped→exited), não a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return { status, url };
}
