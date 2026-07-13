import { describe, expect, it } from 'vitest';
import {
  markdownCell,
  markdownCode,
  markdownTable,
  renderStructuredMarkdown,
  structuredResult,
} from '../model-output.js';

describe('model-facing structured output', () => {
  it('renders deterministic compact tables and escapes dangerous cells', () => {
    const out = markdownTable([
      { id: 'a|b', note: 'line 1\nline 2' },
      { id: 'c', note: null },
    ]);
    expect(out).toBe([
      'id | note',
      '--- | ---',
      'a\\|b | line 1<br>line 2',
      'c | null',
    ].join('\n'));
    expect(markdownCell('C:\\tmp')).toBe('C:\\\\tmp');
    expect(markdownCell('**bold** [link](x) <tag>')).toBe('\\*\\*bold\\*\\* \\[link\\](x) \\<tag\\>');
  });

  it('uses a safe fence when code contains backticks', () => {
    expect(markdownCode('const x = ```;', 'ts')).toContain('````ts');
  });

  it('renders heterogeneous table rows with explicit null cells', () => {
    expect(markdownTable([{ id: 'a', note: 'x' }, { id: 'b', extra: 2 }])).toBe([
      'id | note | extra',
      '--- | --- | ---',
      'a | x | null',
      'b | null | 2',
    ].join('\n'));
  });

  it('keeps structured data hidden and supports the rollback switch', () => {
    const data = { rows: [{ id: 1, name: 'one' }] };
    const markdown = renderStructuredMarkdown(data, 'Rows');
    const enabled = structuredResult(data, markdown, { env: {} });
    expect(enabled).toMatchObject({ content: markdown, contentFormat: 'markdown', structuredData: data });
    const disabled = structuredResult(data, markdown, { env: { MCP_TOOL_RESULT_MARKDOWN: '0' } });
    expect(disabled.contentFormat).toBe('json');
    expect(JSON.parse(disabled.content)).toEqual(data);
  });

  it('beats pretty JSON by at least 20% on a representative repeated-row corpus', () => {
    const data = Array.from({ length: 40 }, (_, id) => ({ id, status: 'pending', owner: 'frontend' }));
    const markdown = renderStructuredMarkdown(data);
    const pretty = JSON.stringify(data, null, 2);
    expect(markdown.length).toBeLessThanOrEqual(pretty.length * 0.8);
  });

  it('reduces a representative App Studio snapshot by at least 25% without changing canonical data', () => {
    const data = {
      revision: { id: 17, number: 4, status: 'draft' },
      counts: { capabilities: 36, scenarios: 48, open_decisions: 3 },
      current_group: { id: 'checkout', status: 'in_progress', depends_on: ['catalog'] },
      tasks: Array.from({ length: 30 }, (_, index) => ({
        id: `task-${index}`,
        group_id: index < 15 ? 'catalog' : 'checkout',
        status: index < 12 ? 'complete' : 'pending',
        depends_on: index === 0 ? null : `task-${index - 1}`,
        evidence_id: index < 12 ? `evidence-${index}` : null,
      })),
    };
    const result = structuredResult(data, renderStructuredMarkdown(data, 'App build plan'), { env: {} });
    const pretty = JSON.stringify(data, null, 2);
    expect(result.content.length).toBeLessThanOrEqual(pretty.length * 0.75);
    expect(result.structuredData).toEqual(data);
    expect(JSON.stringify(result.structuredData)).toContain('evidence-11');
    expect(JSON.stringify(result.structuredData)).toContain('task-29');
  });
});
