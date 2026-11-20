/** Compare what Granite actually sees after truncation on large, real TypeScript functions. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import ts from 'typescript';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { resolveBundledEmbeddingPath } from '@mcp/indexer/search/bundled-model-path.js';
import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';
import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';
import { codeBodyTexts, sampledStarts } from '@mcp/indexer/indexer/indexer/code-body-windows.js';

env.allowRemoteModels = false;
const tokenizer = await AutoTokenizer.from_pretrained(resolveBundledEmbeddingPath(), { local_files_only: true });
const encode = (s: string) => tokenizer.encode(s, { add_special_tokens: false });
const decode = (ids: number[]) => tokenizer.decode(ids, { skip_special_tokens: true, clean_up_tokenization_spaces: false });
const output = resolve('.tmp/agent-ide-reliability', 'windows-' + Date.now());
mkdirSync(output, { recursive: true });
const corpus: Array<{ path: string; name: string; body: string }> = [];
for (const root of ['packages/indexer/src', 'packages/services/src', 'packages/code-agent/src', 'apps/http-api/server']) {
  for (const path of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
    if (!path.endsWith('.ts') || path.includes('__tests__')) continue;
    const file = join(root, path), content = readFileSync(file, 'utf8');
    if (content.length < 10000) continue;
    const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false);
    function visit(node: ts.Node) {
      if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body as ts.Node)) {
        const block = node.body as ts.Block;
        const body = content.slice(block.getStart(ast), block.end);
        if (body.length >= 10000) corpus.push({ path: file, name: node.name?.getText(ast) ?? '(anonymous)', body });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
const options = { windowChars: 2500, overlapChars: 250, maxChunks: 4 };
const rows: Array<{ path: string; name: string; hash: string; bodyChars: number; policy: string;
  fraction: number; count: number; seen: boolean; prepareMs: number }> = [];
const selected = corpus.sort((a, b) => a.body.length - b.body.length)
  .filter((_, i) => i % Math.max(1, Math.floor(corpus.length / 24)) === 0).slice(0, 24);
if (!selected.length) throw new Error('No real long functions in the selected corpus');
for (const sample of selected) {
  const header = '[Context: ' + relative('.', sample.path) + ']\nfunction ' + sample.name + '\n---\n';
  const marks = Array.from({ length: 17 }, (_, i) => 'ProbeMark' + String(i).padStart(2, '0') + 'End');
  // Insert each marker separately to keep the original quantile exact.
  for (const [i, marker] of marks.entries()) {
    const fraction = i / (marks.length - 1);
    const pos = Math.floor(sample.body.length * fraction);
    const body = sample.body.slice(0, pos) + ' ' + marker + ' ' + sample.body.slice(pos);
    const methods = {
      legacy: () => slidingWindows(body, options).map((w, j) => header + '(part ' + (j + 1) + '/4)\n' + w),
      sampled: () => codeBodyTexts(body, header, options),
      tokenizer: () => {
        const ids = encode(body), span = Math.max(1, 512 - encode(header).length - 12);
        return sampledStarts(ids.length, span, 4).map(start => header + decode(ids.slice(start, start + span)));
      },
    };
    for (const [policy, format] of Object.entries(methods)) {
      const started = performance.now();
      const windows = format();
      const prepareMs = performance.now() - started;
      const visible = windows.map(w => decode(tokenizer.encode(w).slice(0, BUNDLED_EMBEDDING_TARGET.maxTokens)));
      rows.push({ path: sample.path, name: sample.name, hash: createHash('sha256').update(sample.body).digest('hex'),
        bodyChars: sample.body.length, policy, fraction, count: windows.length, seen: visible.some(text => text.includes(marker)), prepareMs });
    }
  }
}
const summary = Object.fromEntries(['legacy', 'sampled', 'tokenizer'].map(policy => {
  const cases = rows.filter(row => row.policy === policy);
  return [policy, { seen: cases.filter(row => row.seen).length, total: cases.length, vectors: Math.max(...cases.map(r => r.count)),
    startMiddleEnd: [0, .5, 1].map(fraction => cases.filter(r => r.fraction === fraction && r.seen).length),
    prepareMs: cases.reduce((n, r) => n + r.prepareMs, 0) / cases.length }];
}));
writeFileSync(join(output, 'results.json'), JSON.stringify({ revision: BUNDLED_EMBEDDING_TARGET.revision, samples: selected.length, rows, summary }));
console.log(JSON.stringify({ output, samples: selected.length, summary }, null, 2));
