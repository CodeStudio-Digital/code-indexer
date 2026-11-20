# RAG por ferramentas (agentic RAG)

## O que é

No RAG por ferramentas, o agente decide quais fontes consultar e pode fazer novas leituras com base no que encontrou. A próxima consulta pode usar os nomes, caminhos e IDs descobertos nas etapas anteriores.

## Como usamos no código

- **Investigação de código.** O agente tem acesso a `mcp__search` para descoberta, `mcp__grep_code` para termos literais e ferramentas como `mcp__read_file` e `mcp__get_symbol_body` para ler a implementação. As ferramentas são registradas em níveis de descoberta e navegação. [Catálogo de ferramentas](../../packages/code-agent/src/tools/tiers.ts) · [Leitura de arquivo](../../apps/mcp-server/tools/read-file.ts)
- **Consulta de documentação.** `rag_search_docs` localiza trechos, `rag_doc_outline` lista fontes ou títulos e `rag_read_doc` recupera o conteúdo pelo ID. Por padrão, a busca usa as coleções vinculadas ao projeto quando existem. Sem vínculo, consulta o corpus global. [Busca](../../packages/code-agent/src/tools/rag-search-docs.ts) · [Navegação por títulos](../../packages/code-agent/src/tools/rag-doc-outline.ts) · [Escopo no backend](../../apps/http-api/server/docs/search-backend.ts#L83)
- **Pesquisa com várias etapas.** `runDocsAgent` cria um agente com ferramentas para buscar, ler, listar fontes, sintetizar e finalizar. O resultado guarda a síntese e os trechos citados. [Orquestração da pesquisa](../../packages/docs-agent/src/index.ts#L71) · [Ferramentas da pesquisa](../../packages/docs-agent/src/tools/index.ts)

## Exemplo

Para responder a uma pergunta sobre comportamento de uma API, o agente busca em uma coleção indexada, recebe um `chunk_id` e abre o trecho com `rag_read_doc`. Se o primeiro resultado mencionar um método relacionado, ele pode buscar esse método e só então elaborar a resposta com as duas fontes.

[Voltar ao índice](README.md) · [Ver grounding e proveniência](grounding-e-proveniencia.md)
