# Chunking

## O que é

Chunking divide uma fonte em unidades que podem ser indexadas, encontradas e lidas separadamente. O tamanho e os limites do trecho afetam o que a busca consegue encontrar e quanto contexto o agente recebe.

## Como usamos no código

- **Documentação.** `chunkMarkdown` separa por títulos Markdown e mantém a hierarquia em `heading_path`, a posição em `ord` e a âncora quando presente. O empacotador divide seções longas usando parágrafos e trata tabelas e blocos de código cercados como unidades. Um desses blocos pode passar do limite de 4.800 caracteres para permanecer inteiro. [Divisão por seção](../../packages/services/src/services/docs/section-chunker.ts) · [Empacotamento de blocos](../../packages/services/src/services/docs/chunk-packer.ts#L25)
- **Código.** `buildEmbeddingCandidates` parte da estrutura do arquivo e gera representações para o arquivo, a assinatura e o corpo do símbolo. Em corpos que excedem a capacidade das janelas, amostra início, meio, fim e uma região intermediária. A parte selecionada entra no começo da representação para alcançar o tokenizador mesmo com um símbolo muito longo. O orçamento padrão é de até quatro vetores por corpo. [Candidatos de código](../../packages/indexer/src/indexer/indexer/embedding-candidates.ts) · [Amostragem das janelas](../../packages/indexer/src/indexer/indexer/code-body-windows.ts)
- **Leitura.** A busca de documentação devolve um trecho curto e o `chunk_id`. `rag_read_doc` pode buscar os vizinhos ou paginar os trechos do mesmo título com `mode: "section"`. [Ferramenta de leitura](../../packages/code-agent/src/tools/rag-read-doc.ts)

## Exemplo

Um manual pode ter um título “Inscrição” com vários parágrafos e uma tabela. Se essa seção for dividida, seus trechos continuam com o mesmo caminho de título. O agente pode encontrar o trecho da tabela primeiro e depois ler o texto que explica as colunas.

[Voltar ao índice](README.md) · [Ver como um trecho vira um vetor](embeddings.md)
