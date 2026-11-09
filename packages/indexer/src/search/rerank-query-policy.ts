/** Known local models are English-only or English/Chinese, not Portuguese.
 * References: https://huggingface.co/BAAI/bge-reranker-base and
 * https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1 .
 * This is a conservative prose heuristic, not general language detection.
 * Unknown/custom models keep their configured behavior.
 */
export function localRerankQueryBlockReason(model: string, query: string): string | null {
  if (model !== 'auto' && !/(?:^\/|\/)(?:bge-reranker-(?:base|large)|mxbai-rerank-(?:xsmall|base|large)-v1)$/.test(model)) return null;
  const words = query.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const portuguese = /^(?:onde|como|qual|quais|quando|por\s+que)\b/i.test(query.trim())
    || words.some(word => /[ãõç]/i.test(word))
    || words.filter(word => ['para', 'uma', 'pelo', 'pela', 'dos', 'das', 'não', 'nao', 'também', 'tambem', 'após', 'apos'].includes(word)).length >= 2;
  return portuguese ? 'local_reranker_language_not_supported:pt' : null;
}
