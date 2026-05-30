/**
 * Apply a plugin-contributed theme by injecting a single <style> that
 * overrides the shadcn CSS variables on :root, and toggling the `.dark`
 * variant. One style element (replaced on each apply) so themes don't stack.
 */
const STYLE_ID = 'mcp-plugin-theme';

export function applyPluginTheme(
  tokens: Record<string, string>,
  appearance: 'dark' | 'light',
): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const decls = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  el.textContent = `:root {\n${decls}\n}`;
  document.documentElement.classList.toggle('dark', appearance === 'dark');
}

export function clearPluginTheme(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

/** Host CSS-variable names a plugin iframe should inherit (null-origin frames
 *  can't read the parent `:root`, so we snapshot + inject these into srcDoc). */
const INHERITED_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input',
  '--ring',
  '--destructive',
  '--radius',
  '--font-sans',
  '--font-mono',
];

/** Snapshot the live theme tokens so a sandboxed iframe can mirror the host look. */
export function currentThemeTokens(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const s = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const v of INHERITED_VARS) {
    const val = s.getPropertyValue(v).trim();
    if (val) out[v] = val;
  }
  out['color-scheme'] = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  return out;
}
