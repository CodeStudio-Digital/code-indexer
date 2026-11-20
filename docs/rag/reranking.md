# Reranking

## O que é

Reranking é uma segunda ordenação sobre candidatos já encontrados. Um *cross-encoder* avalia a consulta e cada candidato juntos, levando em conta a relação entre os dois textos. O custo cresce com o número de pares avaliados, então a busca limita o conjunto enviado ao modelo. [Passage Re-ranking with BERT, de Nogueira e Cho](https://arxiv.org/abs/1901.04085)

## Como usamos no código

- **Código.** `RerankerHydrator` monta textos dos candidatos, incluindo dados estruturais e trechos do fonte conforme o caso, e reordena a lista selecionada. Se o serviço falhar, a ordem de recuperação é preservada. A política bloqueia o modo ONNX automático para código após a avaliação registrada no código. Modelos escolhidos explicitamente continuam elegíveis. [Etapa do pipeline](../../packages/indexer/src/search/hybrid-pipeline.ts#L744) · [Política por perfil](../../packages/indexer/src/search/semantic-profile-runtime.ts#L129)
- **Documentação.** `CrossEncoderReranker` usa o modelo do perfil `docs` e avalia um conjunto ampliado antes de devolver os melhores trechos. A busca do agente de código mantém a ordem híbrida por padrão. Para ativar o reranker no host, configure `DOCS_RAG_RERANK=1`. O agente de documentação também pode pedi-lo por consulta com `use_rerank`. O corte exige escores produzidos de fato. Os diagnósticos distinguem idioma bloqueado, poucos candidatos, perfil desabilitado e falha de inferência. [Backend da ferramenta](../../apps/http-api/server/docs/search-backend.ts) · [Adaptador](../../packages/services/src/services/docs/cross-encoder-reranker.ts) · [Política de relevância](../../packages/services/src/services/docs/relevance-policy.ts)
- **Memória.** O serviço pode avaliar pares da consulta com nome, descrição e conteúdo das entradas. O recuperador de memória ainda aplica critérios próprios, como importância, recência e estado das referências. [Reranking das entradas](../../packages/services/src/memory/agent-memory-service.ts#L411) · [Seleção para o agente](../../packages/services/src/memory/agent-memory-retriever.ts)

## Exemplo

Para “Como aplicar força em um Rigidbody?”, a busca inicial pode trazer uma introdução de física e uma seção de referência de `Rigidbody.AddForce`. O reranker pode colocar a seção que explica a operação primeiro. O agente lê essa seção antes de usar a informação.

[Voltar ao índice](README.md) · [Ver como comparamos os rankings](avaliacao-da-recuperacao.md)
