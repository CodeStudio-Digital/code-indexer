/**
 * Row-virtualized thumbnail grid (pattern: db-client VirtualResultGrid).
 * Virtualizes by ROW — each virtual item is a row of N cards, where N comes
 * from a ResizeObserver on the scroll container (so panel resizes reflow the
 * columns live). Only visible rows mount, so 500+ assets stay smooth.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SpriteAsset } from '../types.js';
import { AssetCard } from './AssetCard.js';

const CARD_MIN_W = 118;
const ROW_H = 152; // 96px thumb + 2-line caption + row gap
const GAP = 8;

export function AssetGrid({
  assets,
  activeAssetId,
  onSelect,
  onOpen,
}: {
  assets: SpriteAsset[];
  activeAssetId: string | null;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(2);

  // Column count follows the container width (panel drag, window resize).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth - GAP * 2;
      setCols(Math.max(1, Math.floor((w + GAP) / (CARD_MIN_W + GAP))));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: SpriteAsset[][] = [];
    for (let i = 0; i < assets.length; i += cols) out.push(assets.slice(i, i + cols));
    return out;
  }, [assets, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 4,
  });

  if (assets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {t('library.empty')}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto" style={{ padding: GAP }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            className="absolute left-0 grid w-full"
            style={{
              top: 0,
              transform: `translateY(${v.start}px)`,
              height: v.size - GAP,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: GAP,
            }}
          >
            {rows[v.index]?.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                active={asset.id === activeAssetId}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
