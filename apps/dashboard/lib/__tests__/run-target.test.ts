import { describe, expect, it } from 'vitest';
import { snippetRunFor } from '@mcp/api-bus';
import { fileRunCommand, findCodeBlocks, findPythonMainLine, findScriptLines, runnableForFile } from '../run-target.js';

describe('runnableForFile', () => {
  it('maps supported extensions to a runtime', () => {
    expect(runnableForFile('a.php')).toEqual({ runtime: 'php', manager: 'php' });
    expect(runnableForFile('b.py')).toEqual({ runtime: 'python', manager: 'python' });
    expect(runnableForFile('c.js')).toEqual({ runtime: 'node', manager: 'node' });
    expect(runnableForFile('d.mjs')).toEqual({ runtime: 'node', manager: 'node' });
    expect(runnableForFile('e.cjs')).toEqual({ runtime: 'node', manager: 'node' });
  });
  it('returns null for unsupported / extension-less', () => {
    expect(runnableForFile('f.ts')).toBeNull(); // needs a loader
    expect(runnableForFile('README.md')).toBeNull();
    expect(runnableForFile('Makefile')).toBeNull();
  });
});

describe('fileRunCommand', () => {
  it('quotes the path and prefixes the binary', () => {
    expect(fileRunCommand('src/x.php', 'php')).toBe('php "src/x.php"');
    expect(fileRunCommand('a/b c.py', 'python')).toBe('python "a/b c.py"');
    expect(fileRunCommand('s.js', 'node')).toBe('node "s.js"');
  });
});

describe('findScriptLines (package.json)', () => {
  it('maps each script name to its 1-based line, ignoring keys outside scripts', () => {
    const pkg = [
      '{',
      '  "name": "x",',
      '  "scripts": {',
      '    "dev": "vite",',
      '    "build": "vite build",',
      '    "test": "vitest"',
      '  },',
      '  "dependencies": {}',
      '}',
    ].join('\n');
    expect(findScriptLines(pkg)).toEqual(new Map([[4, 'dev'], [5, 'build'], [6, 'test']]));
  });

  it('keeps array values, drops object-valued keys and nested keys (composer-style)', () => {
    const composer = [
      '{',
      '  "scripts": {',
      '    "post-install-cmd": ["@php artisan"],',
      '    "group": { "nested": "y" },',
      '    "test": "phpunit"',
      '  }',
      '}',
    ].join('\n');
    // 'group' is object-valued → not runnable (composer run group would error);
    // 'nested' is depth 2 → never recorded.
    expect(findScriptLines(composer)).toEqual(
      new Map([[3, 'post-install-cmd'], [5, 'test']]),
    );
  });

  it('returns empty when there is no scripts object', () => {
    expect(findScriptLines('{ "name": "x" }').size).toBe(0);
  });
});

describe('findPythonMainLine', () => {
  it('finds the __main__ guard line (double or single quotes)', () => {
    const src = ['import sys', '', 'def main():', '    pass', '', 'if __name__ == "__main__":', '    main()'].join('\n');
    expect(findPythonMainLine(src)).toBe(6);
    expect(findPythonMainLine("if __name__ == '__main__':")).toBe(1);
  });
  it('returns null without a main guard', () => {
    expect(findPythonMainLine('print("hi")')).toBeNull();
  });
});

describe('snippetRunFor', () => {
  it('maps runnable fence languages to {ext,bin,manager}', () => {
    expect(snippetRunFor('bash')).toEqual({ ext: 'sh', bin: 'bash', manager: 'shell' });
    expect(snippetRunFor('SH')).toEqual({ ext: 'sh', bin: 'bash', manager: 'shell' });
    expect(snippetRunFor('php')).toEqual({ ext: 'php', bin: 'php', manager: 'php' });
    expect(snippetRunFor('py')).toEqual({ ext: 'py', bin: 'python', manager: 'python' });
    expect(snippetRunFor('javascript')).toEqual({ ext: 'js', bin: 'node', manager: 'node' });
  });
  it('returns null for unsupported / empty', () => {
    expect(snippetRunFor('typescript')).toBeNull(); // needs a loader
    expect(snippetRunFor('json')).toBeNull();
    expect(snippetRunFor('')).toBeNull();
    expect(snippetRunFor(null)).toBeNull();
  });
});

describe('findCodeBlocks (markdown)', () => {
  it('finds each runnable block: opening-fence line, language, body', () => {
    const md = [
      '# Title',                  // 1
      '',                         // 2
      'Setup:',                   // 3
      '```bash',                  // 4  ← ▶
      'npm install',              // 5
      'npm run dev',              // 6
      '```',                      // 7
      '',                         // 8
      'Then:',                    // 9
      '```python',                // 10 ← ▶
      'print("hi")',              // 11
      '```',                      // 12
    ].join('\n');
    expect(findCodeBlocks(md)).toEqual([
      { line: 4, language: 'bash', code: 'npm install\nnpm run dev' },
      { line: 10, language: 'python', code: 'print("hi")' },
    ]);
  });

  it('supports ~~~ fences and skips unsupported / language-less blocks', () => {
    const md = [
      '~~~js',          // 1 ← ▶
      'console.log(1)', // 2
      '~~~',            // 3
      '```json',        // 4  (not runnable)
      '{"a":1}',        // 5
      '```',            // 6
      '```',            // 7  (no language)
      'plain text',     // 8
      '```',            // 9
    ].join('\n');
    expect(findCodeBlocks(md)).toEqual([
      { line: 1, language: 'js', code: 'console.log(1)' },
    ]);
  });

  it('skips an unterminated fence (mid-edit) — no glyph', () => {
    const md = ['```bash', 'echo hi'].join('\n'); // never closed
    expect(findCodeBlocks(md)).toEqual([]);
  });

  it('does not mistake a fence INSIDE a block for a new block', () => {
    const md = [
      '```bash',          // 1 ← ▶
      'echo "```not a fence inside"', // 2 (still code)
      'echo done',        // 3
      '```',              // 4
    ].join('\n');
    expect(findCodeBlocks(md)).toEqual([
      { line: 1, language: 'bash', code: 'echo "```not a fence inside"\necho done' },
    ]);
  });

  it('returns empty for markdown with no fenced code', () => {
    expect(findCodeBlocks('# Hello\n\njust prose.')).toEqual([]);
  });

  it('handles CRLF line endings (Windows files) — block still detected', () => {
    const md = ['```bash', 'echo hi', '```', ''].join('\r\n');
    expect(findCodeBlocks(md)).toEqual([{ line: 1, language: 'bash', code: 'echo hi' }]);
  });
});
