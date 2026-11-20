# Roteamento de consultas

## O que é

Roteamento escolhe a estratégia de busca adequada ao formato da consulta. Um nome de função costuma ser resolvido pelo índice textual. Uma pergunta em linguagem natural se beneficia de combinar termos e significado.

## Como usamos no código

`mcp__search` oferece `auto`, `fts`, `vector` e `hybrid`. Em `auto`, `HybridSearch.searchWithDiag` chama `planQuery` e registra o motivo da escolha. O planejador usa o formato do texto e regras para identificadores, perguntas, caminhos e palavras comuns. A decisão é feita por heurísticas locais. [Ferramenta MCP](../../apps/mcp-server/tools/search.ts#L67) · [Aplicação do modo](../../packages/indexer/src/search/hybrid.ts#L477) · [Regras do planejador](../../packages/indexer/src/search/planner.ts#L65)

| Consulta | Modo escolhido em `auto` |
| --- | --- |
| `planQuery` | `fts` por ter formato de identificador |
| `packages/indexer/src/search/planner.ts` | `fts` por ter formato de caminho |
| “Como o sistema escolhe a estratégia de busca?” | `hybrid` por ter formato de pergunta |
| “política de cache vetorial” | `hybrid` por conter termos conceituais |

O chamador pode forçar um modo para investigar resultados ou comparar estratégias. Se o processo MCP ficar sem acesso ao serviço semântico do desktop, ele usa FTS local e informa o modo efetivo. [Fallback no MCP](../../apps/mcp-server/tools/search.ts#L100)

## Exemplo

Para investigar a própria escolha de busca, começamos pela pergunta em `auto`, que seleciona o modo híbrido. Com o nome `planQuery` em mãos, uma consulta lexical ou a leitura direta do símbolo basta para inspecionar a regra.

[Voltar ao índice](README.md) · [Ver o fluxo híbrido](busca-hibrida.md)
