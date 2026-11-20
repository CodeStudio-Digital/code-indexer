# Busca lexical com FTS5

## O que é

A busca lexical encontra resultados a partir dos termos da consulta. Em SQLite, o FTS5 mantém um índice textual e oferece operações como `MATCH` e ordenação por relevância BM25 por padrão. Essa busca é útil para nomes de funções, termos de API e palavras raras que aparecem na fonte. [Documentação do SQLite FTS5](https://www.sqlite.org/fts5.html)

## Como usamos no código

- **Código.** `files_fts` indexa caminhos. `symbols_fts` indexa nome, assinatura, comentário, caminho e outros atributos. O índice `file_contents_fts` permite buscar dentro do fonte. Em `mode: "fts"`, o buscador usa o índice de conteúdo para completar a lista quando cabem mais arquivos do tipo solicitado. [Tabelas FTS](../../packages/store/src/db/schema/fts.ts) · [Índice de conteúdo](../../packages/store/src/db/schema/content-fts.ts) · [Execução do modo FTS](../../packages/indexer/src/search/hybrid.ts#L590)
- **Documentação.** `searchChunks` consulta `doc_chunks_fts`, respeita as coleções pedidas e abre a consulta de `AND` para `OR` se a versão mais restrita ficar vazia. [Busca textual dos trechos](../../packages/store/src/doc/fts.ts)
- **Memória.** O índice `agent_memory_fts` permite recuperar por termos. A leitura filtra as entradas ativas no escopo solicitado. [Índice de memória](../../packages/store/src/migrations/181_agent_memory.ts) · [Consulta das entradas](../../packages/store/src/db/agent-memory.ts#L281)

## Exemplo

`mcp__search` com `query: "planQuery"` e `mode: "auto"` tende a encontrar a declaração pelo nome, pois o roteador escolhe FTS para esse identificador. Para confirmar a ocorrência literal de uma string, existe `mcp__grep_code` com `literal: true`, que inspeciona conteúdo e retorna ocorrências. [Roteador](../../packages/indexer/src/search/planner.ts#L65) · [Ferramentas MCP de busca](../../apps/mcp-server/tools/search.ts#L204)

[Voltar ao índice](README.md) · [Ver como FTS entra na busca híbrida](busca-hibrida.md)
