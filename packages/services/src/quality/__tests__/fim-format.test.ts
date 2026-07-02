import { describe, it, expect } from 'vitest';
import { fimFlavor, renderFimContext, sanitizeFimText, type FimSnippet } from '../fim-format.js';

const SNIPS: FimSnippet[] = [
  { filePath: 'app/Models/User.php', content: 'class User extends Model {\n  public function posts() {}\n}' },
  { filePath: 'app/Services/Sync.php', content: 'class Sync {\n  public function run() {}\n}' },
];

describe('fimFlavor', () => {
  it('maps model ids to flavors', () => {
    expect(fimFlavor('qwen2.5-coder-32b')).toBe('qwen');
    expect(fimFlavor('codestral-latest')).toBe('codestral');
    expect(fimFlavor('devstral-small')).toBe('codestral');
    expect(fimFlavor('deepseek-chat')).toBe('comment');
  });
});

describe('renderFimContext', () => {
  it('qwen: repo-name + file_sep blocks + current-file header + file_sep stop', () => {
    const r = renderFimContext('qwen', SNIPS, {
      repoName: 'poa-backend', currentFile: 'app/Http/C.php', commentPrefix: '// ', volatileBlock: 'Scope: inside C',
    });
    expect(r.contextText.startsWith('<|repo_name|>poa-backend\n')).toBe(true);
    expect(r.contextText).toContain('<|file_sep|>app/Models/User.php\nclass User');
    expect(r.contextText).toContain('<|file_sep|>app/Http/C.php\n');
    // volatile block rides commented right before the prefix
    expect(r.contextText).toContain('// Scope: inside C');
    expect(r.extraStop).toEqual(['<|file_sep|>']);
  });

  it('codestral: +++++ blocks and the runaway stop', () => {
    const r = renderFimContext('codestral', SNIPS, {
      repoName: 'x', currentFile: 'app/Http/C.php', commentPrefix: '// ',
    });
    expect(r.contextText).toContain('+++++ app/Models/User.php\nclass User');
    expect(r.contextText).toContain('\n\n+++++ app/Http/C.php\n');
    expect(r.extraStop).toEqual(['\n+++++ ']);
  });

  it('comment: Path headers with everything commentized, no extra stops', () => {
    const r = renderFimContext('comment', SNIPS.slice(0, 1), {
      repoName: 'x', currentFile: 'c.py', commentPrefix: '# ', volatileBlock: 'members: run()',
    });
    expect(r.contextText).toContain('# Path: app/Models/User.php');
    expect(r.contextText).toContain('# class User extends Model {');
    expect(r.contextText).toContain('# members: run()');
    expect(r.extraStop).toEqual([]);
  });

  it('volatile-only render works without snippets; empty in → empty out', () => {
    const withVolatile = renderFimContext('qwen', [], {
      repoName: 'x', currentFile: 'c.php', commentPrefix: '// ', volatileBlock: 'Scope: f()',
    });
    expect(withVolatile.contextText).toContain('// Scope: f()');
    expect(withVolatile.extraStop).toEqual([]); // no files → comment fallback, no repo tokens

    const empty = renderFimContext('codestral', [], { repoName: 'x', currentFile: 'c.php', commentPrefix: '// ' });
    expect(empty.contextText).toBe('');
  });

  it('sanitizes FIM control tokens smuggled inside snippet content', () => {
    expect(sanitizeFimText('a <|fim_prefix|> b <[fim-suffix]> c')).toBe('a  b  c');
    expect(sanitizeFimText('+++++ fake header\ncode')).toBe('fake header\ncode');
    const r = renderFimContext('qwen', [{ filePath: 'x.ts', content: 'const a = 1; <|fim_middle|>' }], {
      repoName: 'r', currentFile: 'c.ts', commentPrefix: '// ',
    });
    expect(r.contextText).not.toContain('<|fim_middle|>');
  });
});
