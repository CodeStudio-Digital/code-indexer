# Busca vetorial

## O que é

A busca vetorial seleciona os vetores mais próximos do embedding da consulta. O limite `topK` define quantos vizinhos procurar. O sistema usa os identificadores desses vizinhos para recuperar o texto e os metadados correspondentes.

## Como usamos no código

1. `VectorSource` gera o vetor da consulta para o namespace de código do projeto e passa o vetor, a geração e o limite à busca. Variantes de consulta, quando presentes, geram listas próprias que são fundidas. [Fonte vetorial de código](../../packages/indexer/src/search/hybrid-pipeline.ts#L256)
2. `SqliteVecVectorStore.search` usa `embedding MATCH ?` com `k` para executar a consulta de vizinhos. O código recebe distância L2 e calcula `1 / (1 + distância)` para ordenar do maior para o menor score. [Consulta em sqlite-vec](../../packages/store/src/sqlite-vec-store.ts#L265)
3. A busca de código lê os registros de arquivo ou símbolo pelos identificadores guardados nos metadados. A de documentação faz buscas nos namespaces das coleções selecionadas. A de memória revalida o escopo e o estado ativo da entrada ao recuperar o registro. [Recuperação de registros de código](../../packages/indexer/src/search/hybrid-pipeline.ts#L384) · [Busca por coleção](../../packages/services/src/services/docs/search.ts#L298) · [Busca de memória](../../packages/services/src/memory/agent-memory-service.ts#L318)

## Exemplo

“Onde reaproveitamos o vetor de uma pergunta repetida?” pode localizar o componente que mantém `queryVectors` pelo significado da descrição. A lista é ordenada por semelhança e a leitura de `SemanticProfileRuntime` confirma como a chave de cache é montada. [Cache associado ao modelo](../../packages/indexer/src/search/semantic-profile-runtime.ts#L323)

[Voltar ao índice](README.md) · [Ver os modelos e o armazenamento local](recuperacao-local.md)
