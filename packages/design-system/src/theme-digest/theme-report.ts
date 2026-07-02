/**
 * THEME.md renderer — the human/agent-readable face of the theme digest.
 * Every table row carries the evidence (counts, file:line refs) so the
 * agent can open the exact source instead of guessing from memory.
 */
import type { ThemeDigest, ThemeDigestComponent } from './theme-digest.js';
import type { CountedValue, ScannedColor } from './css-token-scan.js';

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '_none found_\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

function colorRows(colors: ScannedColor[]): string[][] {
  return colors.map((c) => [c.hex, String(c.count), c.roles.join(', ') || '—']);
}

function valueRows(values: CountedValue[]): string[][] {
  return values.map((v) => [`\`${v.value}\``, String(v.count)]);
}

function componentRows(components: ThemeDigestComponent[]): string[][] {
  return components.map((c) => {
    const props = c.derived_props
      ? Object.entries(c.derived_props)
          .map(([key, entry]) => `${key}: ${entry.values.join('/')}`)
          .join('; ')
      : '—';
    return [
      c.name,
      c.suggested_kind,
      String(c.frequency),
      props,
      c.source_refs.slice(0, 3).join('<br>') || '—',
    ];
  });
}

export function renderThemeReport(digest: ThemeDigest): string {
  const lines: string[] = [
    '# Theme analysis',
    '',
    `Generated ${digest.generated_at} from ${digest.totals.files} files ` +
      `(${digest.totals.pages} pages, ${digest.totals.stylesheets} stylesheets).`,
    '',
    'Deterministic scan of `import/` — counts are real occurrences in the theme source.',
    'Use these values as the ground truth when writing `pkg/src/tokens.css`;',
    'high-frequency colors are usually neutrals (backgrounds/text), the saturated',
    'ones with `button`/`link` roles are the brand palette.',
    '',
    '## Colors (top, weighted by design-intent properties)',
    '',
    table(['Hex', 'Weight', 'Roles'], colorRows(digest.tokens.colors)),
    '## Typography',
    '',
    '### Font families',
    '',
    table(['Family', 'Count'], valueRows(digest.tokens.fonts)),
    '### Type scale (font-size)',
    '',
    table(['Value', 'Count'], valueRows(digest.tokens.font_sizes)),
    '### Weights',
    '',
    table(['Value', 'Count'], valueRows(digest.tokens.font_weights)),
    '## Shape',
    '',
    '### Border radius',
    '',
    table(['Value', 'Count'], valueRows(digest.tokens.radii)),
    '### Shadows',
    '',
    table(['Value', 'Count'], valueRows(digest.tokens.shadows)),
    '### Spacing' +
      (digest.tokens.spacing.base_px ? ` (base unit: ${digest.tokens.spacing.base_px}px)` : ''),
    '',
    table(['Value', 'Count'], valueRows(digest.tokens.spacing.values)),
    '### Breakpoints',
    '',
    digest.tokens.breakpoints.length > 0
      ? digest.tokens.breakpoints.map((b) => `- \`${b}\``).join('\n') + '\n'
      : '_none found_\n',
  ];

  const varEntries = Object.entries(digest.tokens.css_variables);
  if (varEntries.length > 0) {
    lines.push(
      '## CSS variables declared by the theme',
      '',
      table(['Variable', 'Value'], varEntries.slice(0, 40).map(([k, v]) => [`\`${k}\``, `\`${v}\``])),
    );
  }

  lines.push(
    '## Component candidates (by frequency × confidence)',
    '',
    'Open the `source refs` to see the real markup before porting a component.',
    '',
    table(
      ['Name', 'Kind', 'Freq', 'Derived props (from CSS evidence)', 'Source refs'],
      componentRows(digest.components),
    ),
    '## Pages',
    '',
    digest.pages.length > 0
      ? digest.pages.map((p) => `- \`${p.path}\`${p.title ? ` — ${p.title}` : ''}`).join('\n') + '\n'
      : '_none found_\n',
    '## Detected dependencies',
    '',
    `- CSS frameworks: ${digest.dependencies.css_frameworks.join(', ') || '—'}`,
    `- Icon fonts: ${digest.dependencies.icon_fonts.join(', ') || '—'}`,
    `- JS libs: ${digest.dependencies.js_libs.join(', ') || '—'}`,
    `- Fonts: ${digest.dependencies.fonts.join(', ') || '—'}`,
    '',
  );

  if (digest.warnings.length > 0) {
    lines.push('## Warnings', '', ...digest.warnings.map((w) => `- ${w}`), '');
  }
  return lines.join('\n');
}
