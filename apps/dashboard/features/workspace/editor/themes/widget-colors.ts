/**
 * UI-chrome colors for Monaco widgets, DERIVED from each theme's palette so
 * all themes get IntelliJ-grade colored completion icons + a polished popup
 * without hand-authoring 30 colors × 8 themes.
 *
 * Two families:
 *  - `symbolIcon.*Foreground` — the color Monaco paints each suggest/outline
 *    icon by kind. Reuses the SAME palette colors as the token rules, so the
 *    method icon matches method syntax, class icon matches class syntax, etc.
 *  - `editorSuggestWidget.* / editorHoverWidget.* / editorWidget.*` — popup,
 *    hover and signature-help chrome. Backgrounds/borders are blended from
 *    (background → foreground), which is lighter on dark themes and darker on
 *    light themes automatically — no per-theme appearance flag needed.
 *
 * Geometry (radius/padding/spacing) lives in index.css; only COLOR here.
 */
import type { Palette } from './types.js';

const hex = (c: string): [number, number, number] => [
  parseInt(c.slice(0, 2), 16),
  parseInt(c.slice(2, 4), 16),
  parseInt(c.slice(4, 6), 16),
];

const toHex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Blend `a` toward `b` by `t` (0..1). Both are 6-digit hex without '#'. */
function blend(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  return `#${toHex(ar + (br - ar) * t)}${toHex(ag + (bg - ag) * t)}${toHex(ab + (bb - ab) * t)}`;
}

/** All `symbolIcon.*Foreground` + widget-chrome color keys for a palette. */
export function widgetColors(p: Palette): Record<string, string> {
  const fg = `#${p.foreground}`;
  const surface = p.widgetBackground ? `#${p.widgetBackground}` : blend(p.background, p.foreground, 0.05);
  const border = p.widgetBorder ? `#${p.widgetBorder}` : blend(p.background, p.foreground, 0.22);
  const selected = p.suggestSelectedBackground ? `#${p.suggestSelectedBackground}` : blend(p.background, p.foreground, 0.14);
  const match = `#${p.matchHighlight ?? p.function}`;

  const icon: Record<string, string> = {
    'symbolIcon.methodForeground': `#${p.method}`,
    'symbolIcon.constructorForeground': `#${p.method}`,
    'symbolIcon.functionForeground': `#${p.function}`,
    'symbolIcon.classForeground': `#${p.klass}`,
    'symbolIcon.structForeground': `#${p.klass}`,
    'symbolIcon.interfaceForeground': `#${p.type}`,
    'symbolIcon.enumeratorForeground': `#${p.type}`,
    'symbolIcon.typeParameterForeground': `#${p.type}`,
    'symbolIcon.enumeratorMemberForeground': `#${p.constant}`,
    'symbolIcon.constantForeground': `#${p.constant}`,
    'symbolIcon.booleanForeground': `#${p.constant}`,
    'symbolIcon.numberForeground': `#${p.number}`,
    'symbolIcon.stringForeground': `#${p.string}`,
    'symbolIcon.propertyForeground': `#${p.property}`,
    'symbolIcon.fieldForeground': `#${p.property}`,
    'symbolIcon.keyForeground': `#${p.property}`,
    'symbolIcon.eventForeground': `#${p.property}`,
    'symbolIcon.variableForeground': `#${p.variable}`,
    'symbolIcon.referenceForeground': `#${p.variable}`,
    'symbolIcon.namespaceForeground': `#${p.namespace}`,
    'symbolIcon.moduleForeground': `#${p.namespace}`,
    'symbolIcon.packageForeground': `#${p.namespace}`,
    'symbolIcon.keywordForeground': `#${p.keyword}`,
    'symbolIcon.operatorForeground': `#${p.keyword}`,
    'symbolIcon.colorForeground': `#${p.number}`,
    'symbolIcon.snippetForeground': fg,
    'symbolIcon.textForeground': fg,
    'symbolIcon.fileForeground': fg,
    'symbolIcon.folderForeground': fg,
    'symbolIcon.arrayForeground': fg,
    'symbolIcon.objectForeground': fg,
    'symbolIcon.nullForeground': fg,
  };

  const chrome: Record<string, string> = {
    'editorSuggestWidget.background': surface,
    'editorSuggestWidget.border': border,
    'editorSuggestWidget.foreground': fg,
    'editorSuggestWidget.selectedBackground': selected,
    'editorSuggestWidget.selectedForeground': fg,
    'editorSuggestWidget.highlightForeground': match,
    'editorSuggestWidget.focusHighlightForeground': match,
    'editorHoverWidget.background': surface,
    'editorHoverWidget.border': border,
    'editorHoverWidget.foreground': fg,
    'editorWidget.background': surface,
    'editorWidget.border': border,
    'editorWidget.foreground': fg,
  };

  return { ...icon, ...chrome };
}
