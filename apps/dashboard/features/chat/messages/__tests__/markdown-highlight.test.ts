import { afterEach, expect, it, vi } from 'vitest';
import { codePreview } from '../code-preview.js';
import { highlightMarkdownCode } from '../markdown-highlight.js';

const shiki = vi.hoisted(() => ({ ensureLang: vi.fn(), getHighlighter: vi.fn(), codeToHtml: vi.fn() }));
vi.mock('../../../builder/preview/files/viewer/shiki-client.js', () => shiki);
afterEach(() => vi.resetAllMocks());

it('preserves small code exactly and bounds previews without cutting surrogate pairs', () => {
  expect(codePreview('one\r\ntwo')).toEqual({ text: 'one\r\ntwo', truncated: false });
  const code = `${'x'.repeat(3_499)}😀more`;
  expect(codePreview(code)).toEqual({ text: 'x'.repeat(3_499), truncated: true });
  const manyLines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n');
  expect(codePreview(manyLines).text.split('\n')).toHaveLength(24);
});

it('skips obsolete tokenization after slow grammar initialization', async () => {
  let resolveLanguage!: (lang: string) => void;
  shiki.ensureLang.mockImplementation(() => new Promise(resolve => { resolveLanguage = resolve; }));
  shiki.getHighlighter.mockResolvedValue(shiki);
  const controller = new AbortController();
  const pending = highlightMarkdownCode('obsolete source', 'typescript', 'github-dark', controller.signal);
  await vi.waitFor(() => expect(shiki.ensureLang).toHaveBeenCalled());
  controller.abort(); resolveLanguage('typescript');
  expect(await pending).toBeNull();
  expect(shiki.getHighlighter).not.toHaveBeenCalled();
  expect(shiki.codeToHtml).not.toHaveBeenCalled();
});

it('keeps large expanded fences readable without loading or running the highlighter', async () => {
  expect(await highlightMarkdownCode('x'.repeat(50_001), 'typescript', 'github-dark', new AbortController().signal)).toBeNull();
  expect(shiki.ensureLang).not.toHaveBeenCalled();
  expect(shiki.getHighlighter).not.toHaveBeenCalled();
  expect(shiki.codeToHtml).not.toHaveBeenCalled();
});

it('checks cancellation again after obtaining the highlighter and renders active requests', async () => {
  let resolveHighlighter!: (highlighter: typeof shiki) => void;
  shiki.ensureLang.mockResolvedValue('typescript');
  shiki.getHighlighter.mockImplementationOnce(() => new Promise(resolve => { resolveHighlighter = resolve; }));
  const controller = new AbortController();
  const pending = highlightMarkdownCode('old', 'typescript', 'github-dark', controller.signal);
  await vi.waitFor(() => expect(shiki.getHighlighter).toHaveBeenCalled());
  controller.abort(); resolveHighlighter(shiki);
  expect(await pending).toBeNull();
  expect(shiki.codeToHtml).not.toHaveBeenCalled();
  shiki.getHighlighter.mockResolvedValue(shiki);
  shiki.codeToHtml.mockReturnValue('<pre>current</pre>');
  expect(await highlightMarkdownCode('current', 'typescript', 'github-dark', new AbortController().signal)).toBe('<pre>current</pre>');
});
