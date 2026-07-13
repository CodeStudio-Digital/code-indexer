import { parentPort } from 'node:worker_threads';
import { readFolderEntry } from '../folder-reader.js';
import { chunkMarkdown } from '../section-chunker.js';
import type { DocExtractionRequest, DocExtractionResponse } from './extraction-worker-protocol.js';

if (!parentPort) throw new Error('doc extraction worker must run inside worker_threads');

interface Envelope { reqId: number; body: DocExtractionRequest }

parentPort.on('message', (message: Envelope) => {
  void (async () => {
    const started = performance.now();
    try {
      const result = await readFolderEntry(message.body.entry, message.body.rootPath, message.body.sourceId);
      const sections = typeof result === 'string'
        ? []
        : result.map((page) => ({
            candidateId: page.candidateId,
            chunks: chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Document' }),
          }));
      const response: DocExtractionResponse = { result, sections, durationMs: performance.now() - started };
      parentPort!.postMessage({ reqId: message.reqId, ok: true, result: response });
    } catch (error) {
      const value = error as Error & { code?: string };
      parentPort!.postMessage({
        reqId: message.reqId,
        ok: false,
        error: { message: value.message, code: value.code },
      });
    }
  })();
});

parentPort.postMessage({ kind: 'ready' });
