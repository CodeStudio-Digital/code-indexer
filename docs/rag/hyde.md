# Hypothetical Document Embeddings (HyDE)

## O que é

HyDE pede a um modelo de linguagem que escreva um trecho hipotético parecido com o material que queremos encontrar. O embedding desse trecho ajuda a buscar fontes reais que usam vocabulário ou estrutura semelhantes. [Artigo de Gao et al. sobre HyDE](https://aclanthology.org/2023.acl-long.99/)

## Como usamos no código

1. `HyDEService.generate` resolve a configuração `indexer_search / hyde`. Quando há um modelo vinculado, monta um prompt com a pergunta e pode incluir a linguagem predominante e termos do projeto. Guarda a geração em cache após uma verificação de compatibilidade com a linguagem do projeto. [Geração e cache](../../packages/indexer/src/search/hyde.ts#L32)
2. Se a geração produzir um trecho válido, `VectorSource` consulta tanto com a pergunta original quanto com o trecho hipotético. As listas de vizinhos são combinadas por RRF. [Construção das variantes](../../packages/indexer/src/search/hybrid-pipeline.ts#L360) · [Fusão das variantes](../../packages/indexer/src/search/hybrid-pipeline.ts#L319)
3. Sem o vínculo do pipeline ou com falha de geração, a pergunta original segue para a busca. Consultas que o roteador classifica como lexicais pulam essa etapa por padrão, inclusive quando o modo híbrido foi pedido explicitamente. [Configuração do buscador](../../packages/indexer/src/bootstrap/search-bundle.ts#L47) · [Condições da expansão](../../packages/indexer/src/search/hybrid-pipeline.ts#L360)

## Exemplo

Para “Onde reutilizamos o vetor de uma consulta?”, o modelo pode produzir um esboço que use termos como `queryVectorCache` e `embeddingFingerprint`. Isso dá outro ponto de partida para localizar código existente. A evidência da resposta vem dos arquivos encontrados e lidos.

[Voltar ao índice](README.md) · [Ver a reescrita em documentação](reescrita-de-consulta.md)
