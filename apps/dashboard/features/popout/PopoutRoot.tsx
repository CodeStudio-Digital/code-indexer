/**
 * Shell da janela popout (rota /popout/:kind) — renderiza uma surface
 * destacável SEM o chrome do AppShell. Como as janelas do createAppWindow são
 * frameless (`titleBarStyle:'hidden'`), este shell traz a própria caption:
 * faixa arrastável (`.drag`) + WindowControls (min/max/close; no macOS são os
 * traffic-lights nativos). O corpo lê `:kind` + query e renderiza a surface do
 * registry full-window.
 */
import { Suspense, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { WindowControls } from '../../components/WindowControls.js';
import { useStoredTheme } from '../../hooks/useStoredTheme.js';
import { DETACHABLE_SURFACES, type SurfaceParams } from './registry.js';

export function PopoutRoot() {
  // O popout monta fora do AppShell, que é quem normalmente aplica o tema —
  // sem isto o Monaco/diff sairia sem as cores corretas.
  useStoredTheme();

  const { kind = '' } = useParams<{ kind: string }>();
  const [search] = useSearchParams();
  const def = DETACHABLE_SURFACES[kind];

  const params = useMemo<SurfaceParams>(() => {
    const out: SurfaceParams = {};
    search.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }, [search]);

  const title = def ? def.titleFor(params) : 'CodeStudio';
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      <header className="drag h-9 shrink-0 border-b bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-3 gap-2">
        <span className="text-[12px] text-muted-foreground truncate select-none">{title}</span>
        <div className="no-drag ml-auto flex items-center self-stretch">
          <WindowControls />
        </div>
      </header>

      <main className="flex-1 min-h-0">
        {def ? (
          <Suspense
            fallback={
              <div className="h-full grid place-items-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <def.Surface params={params} />
          </Suspense>
        ) : (
          <div className="h-full grid place-items-center text-muted-foreground text-sm px-6 text-center">
            Unknown surface: {kind}
          </div>
        )}
      </main>
    </div>
  );
}
