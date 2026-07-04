export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb` (leading `#` optional). Throws on anything else. */
export function parseHexColor(hex: string): RgbColor {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}
