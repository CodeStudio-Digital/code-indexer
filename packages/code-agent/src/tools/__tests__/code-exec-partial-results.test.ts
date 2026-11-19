import { describe, expect, it } from 'vitest';
import { completedReadResults } from '../code-exec-partial-results.js';

const read = (content: string) => ({ name: 'read_file', args: { path: 'src/body.ts' }, content, status: 'succeeded', delivered: true, readOnly: true });

describe('failed batch completed reads', () => {
  it('keeps complete small reads and their paths, excluding effects and failed or undelivered reads', () => {
    const text = completedReadResults([
      read('usable source'),
      { ...read('mutating output'), readOnly: false },
      { ...read('failed output'), status: 'failed' },
      { ...read('undelivered output'), delivered: false },
    ]);
    expect(text).toContain('usable source');
    expect(text).toContain('src/body.ts');
    expect(text).not.toContain('mutating output');
    expect(text).not.toContain('failed output');
    expect(text).not.toContain('undelivered output');
  });

  it('does not truncate a large read into an apparently complete file and bounds the added context', () => {
    expect(completedReadResults([read('x'.repeat(2401))])).toBe('');
    const text = completedReadResults(Array.from({ length: 20 }, (_, i) => read(`entry${i}\n${'x'.repeat(2300)}`)));
    expect(text.length).toBeLessThan(8200);
    expect(text).toContain('entry2');
    expect(text).not.toContain('entry3');
  });
});
