/**
 * Generated plugin icon — a tinted square with the plugin's initials, in the
 * spirit of the provider tiles (`providers/ProviderTile`). We don't ship brand
 * SVGs; the color comes from the market `brandColor` when present, otherwise a
 * deterministic hue hashed from the namespace so installed plugins (which carry
 * no `brandColor`) still read distinct at a glance.
 */
import { cn } from '../../../lib/utils.js';

interface PluginIconProps {
  name: string;
  displayName?: string;
  brandColor?: string;
  /** Square edge in px. */
  size?: number;
  className?: string;
}

function initialsOf(label: string): string {
  const words = label.replace(/[@/_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  return letters || '?';
}

/** Normalize `#rgb` / `#rrggbb` / `rrggbb` to `#rrggbb`, else null. */
function normalizeHex(input?: string): string | null {
  if (!input) return null;
  const h = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `#${h}`;
  return null;
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function colorsFor(brandColor: string | undefined, seed: string): { fg: string; bg: string } {
  const hex = normalizeHex(brandColor);
  if (hex) return { fg: hex, bg: `${hex}26` }; // 0x26 ≈ 15% alpha (mirrors bg-…/15)
  const hue = hashHue(seed);
  return { fg: `hsl(${hue} 55% 45%)`, bg: `hsl(${hue} 55% 45% / 0.15)` };
}

export function PluginIcon({ name, displayName, brandColor, size = 40, className }: PluginIconProps) {
  const initials = initialsOf(displayName ?? name);
  const { fg, bg } = colorsFor(brandColor, name);
  return (
    <div
      aria-hidden
      className={cn('rounded-md flex items-center justify-center font-semibold shrink-0', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials}
    </div>
  );
}
