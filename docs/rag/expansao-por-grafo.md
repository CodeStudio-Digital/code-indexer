# Expansão por grafo de código

## O que é

A expansão por grafo usa relações entre itens já indexados para encontrar outros candidatos. Neste projeto, as relações são chamadas e imports do código. Um salto visita somente os vizinhos diretos de um arquivo ou símbolo.

## Como usamos no código

1. A indexação estrutural extrai dependências e referências. O grafo reaproveita esses registros da base relacional. [Indexação estrutural](../../packages/indexer/src/indexer/structural.ts) · [Persistência de relações](../../packages/indexer/src/indexer/indexer/process-file-structural.ts#L96)
2. `GraphSource` parte de um conjunto pequeno de resultados lexicais. A partir de um símbolo, `expandGraph` busca os arquivos que o chamam. A partir de um arquivo, busca o que ele importa e quem o importa. A função limita a expansão e ordena pela frequência com que os vizinhos aparecem entre as sementes, usando a ordem da semente como desempate. [Fonte do grafo](../../packages/indexer/src/search/hybrid-pipeline.ts#L508) · [Expansão e ordenação](../../packages/indexer/src/search/graph-expansion-source.ts#L43)
3. O pipeline híbrido recebe esses vizinhos como candidatos de arquivo e incorpora suas posições na fusão. A etapa está habilitada por padrão para buscas híbridas que aceitam arquivos. `MCP_PIPELINES_GRAPH_EXPANSION=0` desativa a etapa. [Regra de ativação](../../packages/indexer/src/search/hybrid-pipeline.ts#L516) · [Fusão](../../packages/indexer/src/search/hybrid-pipeline.ts#L598)

## Exemplo

Se `planQuery` for uma semente em uma busca híbrida que aceita arquivos, a expansão pode trazer um módulo que chama a função. O agente pode ler os dois arquivos para conectar a regra de roteamento ao ponto em que ela é aplicada.

[Voltar ao índice](README.md) · [Ver como o grafo entra no híbrido](busca-hibrida.md)
