# Nemotron no CodeStudio/MCP-CodeBase

Em 20 de novembro de 2026, a geração 9 do projeto encontrou o arquivo correto entre os dez resultados públicos em **18 de 18 perguntas originais** e em **8 de 8 perguntas adicionais**. O ajuste foi escolhido exclusivamente com as 18 originais. Cada pergunta tem um arquivo rotulado e uma evidência verificável no código. A amostra adicional cobre oito outros arquivos do mesmo repositório. [Rótulos originais](../../evals/rag/repository-queries.jsonl) · [Perguntas adicionais](../../evals/rag/code-project-holdout.jsonl) · [Dados por pergunta](../../evals/rag/nemotron-codebase-2026-11-20.json)

## Escopo da geração

O catálogo instalado tinha 6.645 arquivos estruturais. As duas pastas selecionadas foram `packages/indexer/src/search` e `packages/services/src/services/docs`. Elas continham **130 arquivos no catálogo**. A aplicação conferiu as identidades e os hashes dos itens esperados e confirmou **1.667 de 1.667 vetores físicos**, com zero falhas, antes de servir a geração em `code:p1`. As consultas puderam recuperar candidatos lexicais dos demais arquivos do projeto. Os quatro outros projetos com geração ativa e o projeto com uma geração em construção conservaram seus modelos.

O embedding foi `nvidia/nemotron-3-embed-1b:free`, com 2.048 dimensões. O adaptador usa `query: ` para perguntas e `passage: ` para documentos no protocolo compatível com OpenAI. A geração persiste o formato para manter a compatibilidade com vetores antigos. O segundo modelo foi `nvidia/nemotron-3.5-rerank-8b:free`, chamado na rota de reranking. A ativação consumiu 35 requisições e 682.775 tokens informados pelo OpenRouter, com custo total informado de US$ 0. [Ficha técnica do embedding](https://huggingface.co/nvidia/Nemotron-3-Embed-1B-BF16) · [Modelo de reranking](https://openrouter.ai/nvidia/nemotron-3.5-rerank-8b:free)

## As três perdas anteriores

Na métrica histórica, o avaliador pedia 50 resultados mistos e considerava os dez primeiros caminhos distintos. A última coluna usa o limite público de dez resultados mistos no catálogo instalado. Ausente indica que o arquivo ficou fora dos candidatos devolvidos pelo canal.

| Evidência buscada | Lexical anterior | Vetorial anterior | Híbrido anterior | Vetorial Nemotron nas subárvores | Híbrido instalado com dez resultados |
|---|---:|---:|---:|---:|---:|
| Deduplicação em `semantic-profile-runtime.ts` | 16 | Ausente | 12 | 1 | **1** |
| Identidade estável em `incremental-metadata.ts` | 3 | Ausente | 11 | 8 | **5** |
| Consumidor em `index-doc-use-case/embed-upsert.ts` | Ausente | 3 | 12 | 2 | **3** |

A pergunta sobre concorrência descreve por que duas requisições compartilham o mesmo cálculo. O código materializa isso em `queryInflight`. O canal lexical deixou o arquivo na posição 16 e o vetor anterior não o trouxe de volta. Na atualização incremental, o lexical já encontrava `stableChunkKey` na posição 3. Ao somar posições por candidato, a fusão promovia concorrentes presentes em mais de um canal. No terceiro caso, mencionar `buildEmbeddingText` trouxe evidências relacionadas ao símbolo sem priorizar o arquivo que o chama e envia o trecho ao armazenamento. O canal denso já o encontrava na posição 3, mas o híbrido o deslocava para a 12. Ligar e desligar o grafo anterior manteve as três posições. [Medições dos canais](../../evals/rag/nemotron-codebase-2026-11-20.json)

## Escolha do peso

No catálogo instalado, a fusão RRF de pesos iguais e o par Nemotron acertaram **14/18** com o limite público de dez resultados. Repetimos a recuperação com os mesmos vetores, seis combinações de peso e constante e o reranker desligado para isolar o efeito da fusão.

| Constante RRF | Peso vetorial 1 | Peso vetorial 1,5 | Peso vetorial 2 |
|---|---:|---:|---:|
| 60 | 14/18 | **18/18** | 18/18 |
| 10 | 14/18 | 16/18 | 18/18 |

O projeto usa a constante 60 e o menor peso testado que atingiu a meta, **1,5 para o canal vetorial em perguntas de linguagem natural**. Os demais canais e as consultas por identificador têm peso 1. O peso integra a chave de cache de resultados e pode ser alterado sem reindexar. Na execução do fluxo de produção, o nDCG@10 passou de 0,554 para 0,768 nas perguntas originais e de 0,633 para 0,954 nas adicionais. [Fusão](../../packages/indexer/src/search/hybrid-pipeline.ts) · [Busca e cache](../../packages/indexer/src/search/hybrid.ts)

O reranker devolveu pontuações para **9 das 26 perguntas** na validação final. Nas outras 17, o OpenRouter havia respondido HTTP 422 por triagem de conteúdo. O avaliador registrou essa decisão e preservou a ordem da fusão. Todos os 26 casos entraram no denominador. Os diagnósticos confirmaram a geração e a recuperação de vizinhos vetoriais em cada consulta. A qualidade observada vale para esse conjunto e para a cobertura semântica selecionada.

## Reprodução

O benchmark de subárvores reconstrói os arquivos atuais do checkout em índices isolados. A rodada final continha 132 arquivos e 1.722 vetores. Com o peso ajustado, acertou 18/18 tanto pela métrica histórica quanto pelo limite público de dez resultados. Os hashes no manifesto permitem identificar diferenças entre a estrutura instalada e o checkout.

No Windows, use o Electron da árvore para carregar o SQLite nativo. O primeiro comando avalia as duas subárvores. O segundo avalia a geração ativa do projeto instalado. Ambos exigem o provedor OpenRouter já configurado e gravam as medições em `.tmp/agent-ide-reliability`. A cache local identifica cada resposta pelo hash do corpo e do endpoint. Repetições com cache têm latência diferente da primeira chamada remota.

```powershell
$electron = node -p "require('electron')"
$env:ELECTRON_RUN_AS_NODE = '1'
& $electron --import tsx scripts/bench-rag-repository.ts --openrouter-free
& $electron --import tsx scripts/bench-rag-installed.ts --openrouter-free
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

O administrador pode salvar ou reverter um par por projeto em `PUT /api/admin/semantic/projects/:id/targets`. A rota exige os probes normais do catálogo e pastas selecionadas. O corpo `{"inherit":true}` volta a herdar os modelos globais. Em buscas globais, projetos com destinos de reranking diferentes preservam a ordenação da fusão. [Configuração administrativa](../../apps/http-api/admin/semantic-router.ts) · [Modelos por projeto](../../packages/indexer/src/search/semantic-profile-runtime.ts)
