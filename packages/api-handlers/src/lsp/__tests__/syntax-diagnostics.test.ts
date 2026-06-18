import { describe, expect, it } from 'vitest';
import { syntaxDiagnosticsFor } from '../syntax-diagnostics.js';

describe('syntaxDiagnosticsFor', () => {
  it('returns tree-sitter syntax errors for supported non-TS languages', async () => {
    const diagnostics = await syntaxDiagnosticsFor('broken.php', [
      '<?php',
      'function demo() {',
      '  return [',
      '',
    ].join('\n'));

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.source).toBe('tree-sitter');
  });

  it('returns empty for syntactically valid files', async () => {
    await expect(syntaxDiagnosticsFor('ok.php', '<?php\nstrlen("x");\n')).resolves.toEqual([]);
  });
});
