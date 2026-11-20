# Avaliação da recuperação

## O que é

A avaliação usa perguntas acompanhadas de fontes esperadas, chamadas de conjunto de referência ou *gold set*. O teste compara o que cada estratégia encontrou e em que ordem. Isso permite medir separadamente a busca e, quando pertinente, o tempo de resposta.

| Métrica | O que mede |
| --- | --- |
| `Success@K` | Se algum resultado relevante apareceu entre os primeiros `K`. |
| `Recall@K` | A fração das fontes relevantes esperadas que aparece entre os primeiros `K`. |
| `MRR` | A média do inverso da posição do primeiro resultado relevante. Uma consulta sem acerto contribui com zero. |
| `nDCG@K` | A qualidade da ordem até `K` em relação à ordem ideal, dando mais peso às primeiras posições. |

## Como usamos no código

- **Código.** `src/benchmarks/search-quality.ts` compara modos como FTS, vetorial e híbrido. O projeto tem um conjunto de consultas anotadas e um modo com limiar mínimo de Recall@10. O motor da matriz de modelos calcula também `nDCG@10` e percentis de latência. [Avaliador de código](../../src/benchmarks/search-quality.ts) · [Motor de avaliação](../../packages/indexer/src/benchmarks/engine.ts) · [Consultas anotadas](../../evals/queries.jsonl)
- **Documentação.** `scripts/docs-rag-eval.ts` compara FTS, híbrido e híbrido com reranking. Usa o perfil `docs` da aplicação. Cada alvo é creditado uma vez. Os negativos têm seu próprio denominador e uma falha de cobertura não conta como abstenção correta. O relatório indica a execução efetiva do reranker e as consultas que o dispensaram. [Avaliador de documentação](../../scripts/docs-rag-eval.ts) · [Denominadores e cortes](../../scripts/docs-rag-evaluation.ts) · [Métricas](../../packages/services/src/services/docs/eval-metrics.ts)

## Exemplo

Para aprovar uma consulta positiva nos modos semânticos, o avaliador verifica se a busca retornou vizinhos vetoriais e conseguiu carregar o arquivo ou símbolo correspondente. Um projeto com as pastas semânticas vazias ainda pode responder pela busca textual. O diagnóstico identifica essa condição e a rodada semântica é reprovada. [Verificação da recuperação](../../packages/indexer/src/search/hybrid.ts) · [Regressão de escopo vazio](../../packages/indexer/src/search/__tests__/hybrid-cache-revision.test.ts)

Se esperamos duas fontes e só uma aparece nas cinco primeiras, `Recall@5` é 0,5. Se a primeira fonte relevante está na segunda posição, o recíproco dessa consulta é 0,5 e entra na média do `MRR`. As métricas avaliam os resultados da busca. A fidelidade da resposta final depende também de como o agente usa e cita os trechos.

[Voltar ao índice](README.md) · [Ver o conjunto de referência de exemplo para documentação](../../packages/services/src/services/docs/__tests__/eval/gold-set.example.jsonl)
