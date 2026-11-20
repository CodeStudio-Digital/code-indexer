# Reescrita de consulta

## O que é

Reescrita cria formulações alternativas para a mesma pergunta. Uma variante pode usar terminologia da documentação, outra pode deixar explícito um aspecto implícito na consulta. Buscar por várias formulações pode encontrar trechos que uma formulação isolada deixaria de fora.

## Como usamos no código

- No backend de `rag_search_docs`, `shouldRewrite` avalia se a consulta se beneficia da etapa. Uma pergunta aberta pode passar. Uma referência qualificada como `Rigidbody.AddForce` preserva a consulta original. `DOCS_RAG_REWRITE=0` desativa a etapa nessa ferramenta. [Política do backend](../../apps/http-api/server/docs/search-backend.ts#L71) · [Heurística](../../apps/http-api/server/docs/search-backend.ts#L195)
- `QueryRewriter.rewrite` resolve o vínculo `doc_search / rewriter`. O retorno tem até quatro formulações no total, com a original sempre na primeira posição. Reformulações válidas podem ser reaproveitadas por cache. O serviço preserva a pergunta original se o vínculo estiver ausente ou o modelo falhar. [Implementação](../../packages/services/src/services/docs/query-rewriter.ts#L107)
- `DocHybridSearch` busca cada variante por FTS e por vetor, conforme os serviços disponíveis, e combina as listas por RRF. [Busca por variante](../../packages/services/src/services/docs/search.ts#L117)

## Exemplo

“Como variar a força aplicada a um corpo?” pode ganhar uma variante como “modos de força no Rigidbody”. Cada variante ainda é uma consulta. O agente recebe trechos reais das coleções pesquisadas.

[Voltar ao índice](README.md) · [Ver HyDE para código](hyde.md)
