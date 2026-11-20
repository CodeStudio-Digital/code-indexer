# Busca híbrida

## O que é

A busca híbrida reúne candidatos vindos de mais de um método. Aqui, as duas fontes principais são a busca lexical, que aproveita os termos presentes, e a busca vetorial, que aproveita a proximidade entre a consulta e o conteúdo.

## Como usamos no código

| Fonte | Como a busca combina os caminhos |
| --- | --- |
| Código | O `CandidatePipeline` reúne FTS de arquivos e símbolos, vizinhos vetoriais e, quando aplicável, conteúdo bruto, arquivos recentes e vizinhos no grafo. Aplica fusão, deduplicação e seleção. O reranking só entra quando o perfil e a consulta permitem. [Montagem do pipeline](../../packages/indexer/src/search/hybrid-pipeline.ts#L914) |
| Documentação | `DocHybridSearch` consulta FTS5 e vetores em paralelo para cada versão da pergunta. Funde as listas disponíveis e carrega os trechos pelos IDs. [Busca e fusão](../../packages/services/src/services/docs/search.ts#L135) |
| Memória | `AgentMemoryService.search` consulta FTS e, com backend semântico disponível, busca vetores no escopo escolhido. Funde as posições, deduplica entradas e pode reranquear antes de devolver a lista. [Busca de memória](../../packages/services/src/memory/agent-memory-service.ts#L318) |

Se a parte vetorial falhar, os caminhos textuais continuam atendendo a busca. No código, `searchWithDiag` registra a degradação e sua causa. [Diagnóstico do modo híbrido](../../packages/indexer/src/search/hybrid.ts#L623)

## Exemplo

“Como o CodeStudio escolhe entre FTS e busca semântica?” contém o termo literal `FTS` e descreve uma intenção. O braço lexical pode encontrar comentários com `FTS`. O braço semântico pode localizar candidatos relacionados ao planejamento da consulta. O ranking combinado junta os dois sinais.

[Voltar ao índice](README.md) · [Ver a fusão RRF](rrf.md)
