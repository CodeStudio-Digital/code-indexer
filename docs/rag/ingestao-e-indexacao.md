# Ingestão e indexação

## O que é

Ingestão é coletar e preparar as fontes que o sistema vai consultar. Indexação cria as estruturas para encontrar partes dessas fontes rapidamente, como um índice de palavras ou um conjunto de vetores ligados aos textos originais. O trabalho de preparar as fontes acontece antes da busca e pode ser repetido de forma incremental quando elas mudam.

## Como usamos no código

1. **Código.** `runStructuralIndex` usa o scanner para identificar arquivos novos, alterados e removidos. `prepareFileStructural` prepara conteúdo e extração com Tree-sitter. A publicação estrutural alimenta arquivos, símbolos, dependências, referências e busca textual. Essa etapa já oferece busca lexical sem precisar carregar um modelo de embeddings. [Indexação estrutural](../../packages/indexer/src/indexer/structural.ts#L95) · [Preparação e persistência do arquivo](../../packages/indexer/src/indexer/indexer/process-file-structural.ts#L41)
2. **Índice semântico de código.** `buildEmbeddingCandidates` transforma arquivos e símbolos em textos apropriados para embeddings. Compara os hashes do texto e a identidade do modelo com os itens aceitos na geração de destino para pular trabalho repetido. [Construção dos candidatos](../../packages/indexer/src/indexer/indexer/embedding-candidates.ts#L26)
3. **Documentação.** `indexPdf`, `indexUrl` e `indexFolder` recebem fontes cadastradas em coleções. `runIngest` prepara os trechos e persiste o texto antes da etapa vetorial. Se falhar a geração de vetores, a busca textual continua disponível. [Pontos de entrada](../../packages/services/src/services/docs/index-doc-use-case/strategies.ts) · [Ordem das etapas](../../packages/services/src/services/docs/index-doc-use-case/run-ingest.ts#L88)

## Exemplo

Ao alterar uma função em `planner.ts`, a indexação estrutural atualiza o arquivo e seus símbolos. A etapa semântica recalcula os candidatos desse arquivo e gera novamente os vetores cujo texto mudou.

[Voltar ao índice](README.md) · [Ver como os trechos são divididos](chunking.md)
