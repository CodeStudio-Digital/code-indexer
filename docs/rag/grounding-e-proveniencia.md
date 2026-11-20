# Grounding e proveniência

## O que é

*Grounding* é sustentar uma resposta em evidências consultadas durante a tarefa. Proveniência é preservar de onde veio cada evidência. Em um agente de código, isso permite localizar a implementação e confirmar o comportamento pelo fonte.

## Como usamos no código

- **Código.** `mcp__search` informa caminho, símbolo, linhas quando disponíveis e sinais da busca. O resultado estruturado indica que os dados vêm do índice e que o conjunto é limitado pelo ranking. `mcp__get_symbol_body` lê o arquivo atual e revalida a localização antes de apresentar o corpo. [Evidência na busca](../../apps/mcp-server/tools/search.ts#L139) · [Leitura do símbolo](../../apps/mcp-server/tools/symbol-body.ts#L22)
- **Documentação.** Cada resultado tem `chunk_id`, `source_uri`, `heading_path` e âncora quando disponível. `rag_read_doc` recupera o trecho correspondente. Com pontuação de reranking disponível, o backend pode descartar candidatos abaixo do limiar e sinalizar que a busca ficou sem um bom resultado. [Metadados dos resultados](../../packages/services/src/services/docs/search.ts#L184) · [Política de relevância](../../packages/services/src/services/docs/relevance-policy.ts)
- **Pesquisa de documentação.** O agente registra o ID, o hash e os intervalos lidos de cada passagem. Confiança alta exige cobertura de leitura e citação das subperguntas. Na conclusão, ele verifica a coleção e a revisão do texto. Os marcadores numerados apontam para a lista de fontes na ordem de citação. [Registro de evidências](../../packages/docs-agent/src/tools/evidence-ledger.ts) · [Verificação ao concluir](../../packages/docs-agent/src/tools/docs-finish.ts) · [Mapeamento de citações](../../packages/docs-agent/src/retrieval/citations.ts)

## Exemplo

Uma busca pode sugerir que `planQuery` encaminha perguntas para o modo híbrido. Para fundamentar a explicação, o agente lê a função e aponta para a condição que usa `QUESTION_RE`. Assim o leitor pode conferir a regra e também ver os demais caminhos. [Regra no fonte](../../packages/indexer/src/search/planner.ts#L76)

[Voltar ao índice](README.md) · [Ver o fluxo com ferramentas](rag-agentico.md)
