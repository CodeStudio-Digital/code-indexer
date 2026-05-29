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
