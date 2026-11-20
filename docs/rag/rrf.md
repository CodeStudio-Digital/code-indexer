# Reciprocal Rank Fusion (RRF)

## O que é

RRF combina listas usando a posição dos itens em cada uma. Um item na posição `r` contribui com `1 / (K + r)` para a pontuação final, contando a primeira posição como 1. O mesmo item soma contribuições das listas em que aparece. Isso permite combinar rankings com escalas diferentes, como o rank de FTS e a distância vetorial. [Artigo de Cormack, Clarke e Büttcher](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf)

## Como usamos no código

- `rrfMerge` usa `K = 60` por padrão e agrupa por `candidateId`. Em documentação, o candidato é identificado pelo `chunk_id` e a fusão reúne as listas das fontes e das variantes. Com uma única lista de documentação, o código preserva a ordem original. [Função compartilhada](../../packages/candidate-pipeline/src/scorers/rrf.ts#L21) · [Fusão em documentação](../../packages/services/src/services/docs/search.ts#L161)
- No código, `RrfFusionScorer` soma as posições das fontes para cada identidade de arquivo ou símbolo. O braço vetorial também pode usar RRF para unir as listas de duas versões da consulta. [Fusão geral de código](../../packages/indexer/src/search/hybrid-pipeline.ts#L548) · [Fusão das variantes](../../packages/indexer/src/search/hybrid-pipeline.ts#L319)
- Na memória, o serviço combina as posições de FTS e da busca vetorial usando o ID da entrada. [Fusão de memória](../../packages/services/src/memory/agent-memory-service.ts#L392)

## Exemplo

Com `K = 60`, um trecho no primeiro lugar lexical e no quarto lugar vetorial recebe `1/61 + 1/64 ≈ 0,0320`. Outro, presente só no primeiro lugar vetorial, recebe `1/61 ≈ 0,0164`. A pontuação expressa a ordem relativa nessa consulta. O corte de relevância em documentação usa a pontuação do reranker quando disponível. [Política de relevância](../../packages/services/src/services/docs/relevance-policy.ts)

[Voltar ao índice](README.md) · [Ver reranking](reranking.md)
