/**
 * Color literal extraction/normalization shared by the theme digest and
 * (later) the studio fidelity audit: every hex/rgb()/hsl() literal found in
 * a CSS value is normalized to lowercase #rrggbb so frequencies and
 * palette comparisons operate on one canonical form.
 */

const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/g;
const HSL_RE = /hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/g;

// Alpha é DESCARTADO de propósito em toda forma (#rgba → #rrggbb, #rrggbbaa
// → #rrggbb): a forma canônica compara matiz para paleta/fidelidade, e
// transparência não muda a identidade da cor da marca.
function expandHex(raw: string): string | null {
  const h = raw.toLowerCase();
  if (h.length === 3 || h.length === 4) {
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
  return null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/** `#rrggbb` → [r,g,b]; null para formatos inesperados. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Distância RGB ponderada (verde pesa mais — percepção), escala 0..~441. */
export function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return Number.POSITIVE_INFINITY;
  return Math.sqrt(
    2 * (ra[0] - rb[0]) ** 2 + 4 * (ra[1] - rb[1]) ** 2 + 3 * (ra[2] - rb[2]) ** 2,
  );
}

/** Saturação HSL 0..1 — neutros (cinzas/branco/preto) ficam perto de 0. */
export function saturationOf(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (l > 0.5 ? 2 - max - min : max + min);
}

/** Extract every color literal in a declaration value, normalized to #rrggbb. */
export function extractColors(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(HEX_RE)) {
    const hex = expandHex(m[1]);
    if (hex) out.push(hex);
  }
  for (const m of value.matchAll(RGB_RE)) {
    out.push(rgbToHex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  for (const m of value.matchAll(HSL_RE)) {
    out.push(hslToHex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}
