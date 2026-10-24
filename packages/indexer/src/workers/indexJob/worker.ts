import { parentPort } from 'node:worker_threads';
import { TreeSitterExtractor } from '@mcp/indexer/indexer/tree-sitter/index.js';
import { computeSourceHash } from './source-hash.js';
import type { IndexJobReq, IndexJobRes } from '@mcp/indexer/workers/indexJob/protocol.js';

if (!parentPort) {
  throw new Error('indexJob worker: must run inside worker_threads');
}

// Lazy: instantiate the extractor on first 'extract' job. Each worker owns
// its own parsers map; grammars are loaded on-demand per language.
let extractor: TreeSitterExtractor | null = null;

interface InboundEnvelope {
  reqId: number;
  body: IndexJobReq;
}

parentPort.on('message', (msg: InboundEnvelope) => {
  void (async () => {
    try {
      const req = msg.body;
      let result: IndexJobRes;
      switch (req.kind) {
        case 'extract': {
          if (!extractor) extractor = new TreeSitterExtractor();
          const ts = await extractor.extract(req.filePath, req.content);
          result = { kind: 'extract', result: ts };
          break;
        }
        case 'hashTree': {
          const digest = await computeSourceHash(req.pkgDir, { excludeDirs: req.excludeDirs });
          result = { kind: 'hashTree', digest };
          break;
        }
        default: {
          const k = (req as { kind: string }).kind;
          throw new Error(`unknown indexJob req kind: ${k}`);
        }
      }
      parentPort!.postMessage({ reqId: msg.reqId, ok: true, result });
    } catch (err) {
      const e = err as Error & { code?: string };
      parentPort!.postMessage({
        reqId: msg.reqId,
        ok: false,
        error: { message: e.message, code: e.code },
      });
    }
  })();
});

parentPort.postMessage({ kind: 'ready' });
