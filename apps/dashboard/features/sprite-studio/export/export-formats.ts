/**
 * Export format registry — each format declares its id, an i18n label key, and
 * the option fields the dialog should surface. The dialog renders generic
 * controls from `optionSchema`; the backend re-packs full-res with the same
 * params (the params are the contract). MVP ships three formats.
 */
export type ExportOptionType = 'number' | 'boolean';

export interface ExportOption {
  key: string;
  type: ExportOptionType;
  /** i18n key suffix under `export.options.` */
  labelKey: string;
  default: number | boolean;
  min?: number;
  max?: number;
}

export interface ExportFormat {
  id: string;
  /** i18n key suffix under `export.format.` */
  labelKey: string;
  options: ExportOption[];
}

/** Options common to grid/atlas formats (padding/extrude/scale). */
const SHEET_OPTIONS: ExportOption[] = [
  { key: 'padding', type: 'number', labelKey: 'padding', default: 2, min: 0, max: 16 },
  { key: 'extrude', type: 'number', labelKey: 'extrude', default: 2, min: 0, max: 8 },
  { key: 'scale', type: 'number', labelKey: 'scale', default: 1, min: 1, max: 8 },
];

const TRIM: ExportOption = { key: 'trim', type: 'boolean', labelKey: 'trim', default: false };

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  {
    id: 'png-individual',
    labelKey: 'pngIndividual',
    options: [{ key: 'scale', type: 'number', labelKey: 'scale', default: 1, min: 1, max: 8 }],
  },
  {
    id: 'spritesheet-json',
    labelKey: 'spritesheetJson',
    options: [
      ...SHEET_OPTIONS,
      TRIM,
    ],
  },
  { id: 'unity', labelKey: 'unity', options: [...SHEET_OPTIONS, TRIM] },
  { id: 'godot', labelKey: 'godot', options: [...SHEET_OPTIONS, TRIM] },
  { id: 'babylon', labelKey: 'babylon', options: [...SHEET_OPTIONS, TRIM] },
  { id: 'defold', labelKey: 'defold', options: [
    { key: 'extrude', type: 'number', labelKey: 'extrude', default: 2, min: 0, max: 8 },
    { key: 'scale', type: 'number', labelKey: 'scale', default: 1, min: 1, max: 8 },
    TRIM,
  ] },
  { id: 'cocos', labelKey: 'cocos', options: [...SHEET_OPTIONS, TRIM] },
  {
    id: 'phaser',
    labelKey: 'phaser',
    options: [
      ...SHEET_OPTIONS,
      { ...TRIM, default: true },
    ],
  },
];

/** Default option values for a format (used to seed the dialog form). */
export function defaultOptions(format: ExportFormat): Record<string, number | boolean> {
  return Object.fromEntries(format.options.map((o) => [o.key, o.default]));
}

export function findFormat(id: string): ExportFormat {
  return EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0];
}
