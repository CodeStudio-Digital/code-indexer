/**
 * useElementWidth — largura em px do elemento referenciado, via
 * ResizeObserver (rAF-debounced). Usado para decisões de layout que
 * dependem da largura REAL de um container (não do viewport) — ex.: a
 * barra de sessões que colapsa quando o painel de chat aperta.
 *
 * Retorna 0 até a primeira medição. Callback do RO é agendada em
 * requestAnimationFrame para não thrash-ar durante o arrasto do resize.
 */
import { useEffect, useRef, useState } from 'react';

export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let raf: number | null = null;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(Math.round(w)));
    });
    ro.observe(el);
    // Medição inicial síncrona (antes do primeiro RO tick).
    setWidth(Math.round(el.clientWidth));

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return [ref, width];
}
