import type { QaPreviewCriterion } from '@mcp/services/qa/types.js';

export function parsePreviewTarget(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('target_url must be an HTTP(S) URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('target_url must be HTTP(S), without embedded credentials');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) throw new Error('Native preview requires a loopback target (localhost, 127.0.0.1 or [::1])');
  return url.href;
}

export function parsePreviewCriteria(value: unknown): QaPreviewCriterion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new Error('criteria must contain 1–30 acceptance checks');
  const names = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Each criterion requires name and selector');
    const { name, selector, text, visible } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || names.has(name)) throw new Error('Criterion names must be nonempty, unique, and at most 200 characters');
    if (typeof selector !== 'string' || !selector.trim() || selector.length > 1000) throw new Error('Criterion selector must be nonempty and at most 1000 characters');
    if (text !== undefined && (typeof text !== 'string' || text.length > 2000)) throw new Error('Criterion text must be a string of at most 2000 characters');
    if (visible !== undefined && typeof visible !== 'boolean') throw new Error('Criterion visible must be boolean');
    names.add(name);
    return { name, selector, ...(text === undefined ? {} : { text: text as string }), visible: visible !== false };
  });
}

/** No caller-supplied code is evaluated: selectors/text are JSON literals. */
export function previewAssertionScript(criteria: QaPreviewCriterion[]): string {
  return `(() => ({url: location.href, title: document.title, checks: ${JSON.stringify(criteria)}.map(c => {
    try {
      const elements = Array.from(document.querySelectorAll(c.selector));
      const matches = elements.filter(e => c.text === undefined || (e.innerText ?? e.textContent ?? '').includes(c.text));
      const visible = e => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; };
      const passed = c.visible ? matches.some(visible) : !matches.some(visible);
      return {name:c.name, selector:c.selector, passed, matched:matches.length, expectedVisible:c.visible,
        observed:matches.slice(0,3).map(e => (e.innerText ?? e.textContent ?? '').slice(0,2000))};
    } catch(e) { return {name:c.name, passed:false, error:String(e)}; }
  })}))()`;
}
