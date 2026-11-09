import { expect, it } from 'vitest';
import { localRerankQueryBlockReason } from '../rerank-query-policy.js';

it('skips known English/Chinese local models for Portuguese prose only', () => {
  for (const model of ['auto', 'Xenova/bge-reranker-base', 'mixedbread-ai/mxbai-rerank-xsmall-v1']) {
    for (const query of ['Onde fica o cache?', 'Como abrir arquivo', 'sessão expirada usuário', 'entrada para uma fila']) {
      expect(localRerankQueryBlockReason(model, query)).toContain(':pt');
    }
    for (const query of ['Where is session expiry?', 'SessionPolicy', 'cache invalidation', '如何查找用户']) {
      expect(localRerankQueryBlockReason(model, query)).toBeNull();
    }
  }
  expect(localRerankQueryBlockReason('custom/multilingual', 'Onde fica o cache?')).toBeNull();
});
