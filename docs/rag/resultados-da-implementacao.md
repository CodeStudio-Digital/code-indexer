# Implementação e resultados do RAG do CodeStudio

CodeStudio 3.16.55, branch `codex/remove-rust-runtime`. Os ensaios começaram em `b7a7184dd085`. A branch recebeu `62809c76c7bb` durante a implementação e a verificação final inclui as alterações locais de RAG. Os ensaios foram executados em 19 de novembro de 2026 no Windows, com Ryzen 9 7950X3D e RTX 4070 Ti. Os índices de teste usam diretórios próprios. [Plano original](plano-de-aprimoramento.md) · [Guias das 17 técnicas](README.md)

## Correções prioritárias

| Falha reproduzida | Comportamento implementado e verificação |
| --- | --- |
| Uma raiz desconectada era interpretada como um conjunto de exclusões | O scanner confirma a cobertura por raiz e verifica o caminho físico antes de inferir remoção. A fila conserva eventos pendentes e a revisão publicada sobrevive à desconexão. Os testes cobrem duas raízes, reconexão, exclusão confirmada, desvinculação e o executor alternativo usado pelo host. [Scanner](../../packages/indexer/src/indexer/scanner.ts) · [Regressões](../../packages/indexer/src/indexer/__tests__/scanner-stat-first.test.ts) |
| Uma exceção do catálogo ampliava uma busca de projeto para o acervo global | Host, worker e MCP compartilham a resolução de escopo. Um catálogo indisponível interrompe a consulta. Uma consulta global explícita ou um projeto comprovadamente sem vínculos seguem a política existente. Cancelamento é propagado e falhas vetoriais identificam as coleções afetadas. [Resolução](../../packages/services/src/services/docs/search-scope.ts) · [Busca](../../packages/services/src/services/docs/search.ts) |
| O reranker podia descartar uma resposta correta em português mesmo dispensando a inferência | A busca registra quando o modelo efetivamente pontuou candidatos e por qual motivo pulou uma consulta. O corte exige pontuações calibradas. O mesmo contrato cobre modelo indisponível e poucos candidatos. [Adaptador](../../packages/services/src/services/docs/cross-encoder-reranker.ts) · [Regressões em português e com escores baixos](../../packages/services/src/services/docs/__tests__/search-threshold.test.ts) |
| O avaliador usava o perfil aposentado e misturava positivos com negativos | O avaliador usa o perfil `docs`, conserva negativos explícitos, rejeita rótulos malformados e informa modos solicitados, executados, inferência e cobertura. O aceite de código tem piso de 0,90 e exige a geração semântica ativa do projeto. [Avaliador de Docs](../../scripts/docs-rag-evaluation.ts) · [Avaliador de código](../../src/benchmarks/search-quality.ts) |

## Indexação, leitura e evidência

- **Granite embarcado.** Pesos Q8, 384 dimensões e limite efetivo de 512 tokens no tokenizador da sessão. A preferência é DirectML no Windows, CUDA no Linux x64 e CoreML no macOS. Falhas de criação da sessão ou de inferência no acelerador acionam a CPU. O pacote Windows carregou os pesos de `resources/semantic-models` em CPU e em DirectML. Pelo dashboard, o teste criou um projeto, selecionou as pastas e aguardou a primeira geração. A consulta híbrida em português retornou o arquivo esperado pelo IPC com dois candidatos vetoriais recuperados. Na GPU, duas entradas com prefixo igual e caudas diferentes além do limite tiveram diferença máxima zero. Um texto independente teve diferença máxima de 0,129. A execução física de GPU desta rodada foi em DirectML. [Runtime](../../packages/indexer/src/search/local-embeddings.ts) · [Teste no pacote](../../scripts/bench-rag-packaged.mjs) · [Modelo IBM](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2) · [DirectML no ONNX Runtime](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)
- **Corpos longos.** Em 24 funções reais, inserimos um marcador de cada vez em 17 posições e observamos o texto visível ao tokenizador Granite. Com quatro vetores por corpo, a política anterior preservou 223 de 408 marcadores, incluindo 24 inícios, 16 meios e nenhum fim. A amostragem implementada preservou 231 de 408 e os 72 alvos de início, meio e fim. O corte pelo tokenizador completo preservou 236, com custo médio de preparação de 6,71 ms por amostra, contra 0,084 ms da política escolhida. Isso mede cobertura do texto de entrada. [Janelas](../../packages/indexer/src/indexer/indexer/code-body-windows.ts) · [Experimento](../../scripts/bench-rag-windows.ts)
- **Símbolos e gerações.** O filtro de arquivos ou símbolos entra antes do limite de vizinhos em `sqlite-vec`. Assinatura, corpo e grupo do mesmo símbolo recebem um voto por variante. A busca de Docs hidrata o ID na coleção solicitada e verifica o hash disponível para a geração consultada. Coleções em espaços vetoriais diferentes são combinadas pela posição nas respectivas listas. O formato novo de entrada ganha versão própria na geração. O worker do aplicativo e a CLI reconhecem as duas identificações históricas do mesmo ONNX normalizado. A comparação continua verificando o modelo, a revisão, o protocolo e o contexto do backend. [Vizinhos de código](../../packages/indexer/src/search/code-vector-matches.ts) · [Gerações](../../apps/http-api/server/semantic-coordinator-generations.ts) · [Busca em Docs](../../packages/services/src/services/docs/search.ts)
- **Markdown, HTML e PDF.** Blocos cercados protegem comentários que começam por `#`. Referências de API curtas sobrevivem ao filtro inicial e ao empacotamento. Uma página de PDF sem texto gera uma lacuna explícita. Duas páginas com o mesmo número em PDFs diferentes de uma pasta têm localizadores próprios. Reordenar passagens idênticas conserva os IDs usados nas citações. Mudanças de conteúdo e exclusões são reconciliadas em transação. [Divisão por seção](../../packages/services/src/services/docs/section-chunker.ts) · [PDF](../../packages/services/src/services/docs/pdf-parser.ts) · [Persistência dos trechos](../../packages/store/src/doc/chunks.ts) · [Teste com os três formatos](../../packages/services/src/services/docs/__tests__/folder-reader.test.ts)
- **Memória e agente.** Os testes temporais acertaram as 160 verificações de versão e projeto. A sequência controlada de ferramentas resolveu 40 de 40 tarefas com um símbolo movido, incluindo 20 com histórico indisponível. A primeira busca isolada nunca reuniu todas as evidências da tarefa. O agente paginou leituras, manteve os IDs das coleções da sessão e verificou o hash das passagens ao concluir. [Memória](../../packages/services/src/memory/agent-memory-retriever.ts) · [Livro de evidências](../../packages/docs-agent/src/tools/evidence-ledger.ts) · [Ensaio temporal](../../scripts/bench-rag-temporal.ts)

## Recuperação medida

O corpus sintético de código contém 40 tópicos em TypeScript, C# e PHP. São 200 perguntas em cinco modos, com consultas exatas, literais, conceituais em inglês e português e consultas em projeto vazio. A separação por tópico reservou 128 positivos e 32 negativos para o aceite. Em Docs, são 160 perguntas em três modos, com 96 positivos e 32 negativos reservados. Cada conjunto real de código foi reindexado a partir de arquivos do repositório. As métricas abaixo têm denominadores distintos.

| Conjunto reservado | FTS | Vetorial | Híbrido | Com reranking |
| --- | ---: | ---: | ---: | ---: |
| Código sintético, Recall@10 na GPU | 85,2% | 75,8% | 96,1% | 96,1% |
| Documentação sintética, Recall@5 | 57/96 | — | 79/96 | 53/96 |
| Código real, arquivo esperado no top 10, 18 perguntas | 13/18 | 16/18 | 15/18 | 17/18 |

**Código.** A rodada anterior à seleção automática de GPU registrou 96,9% dos positivos sintéticos. Na rodada com verificação dos candidatos vetoriais, o híbrido recuperou 123/128 positivos e respeitou 32/32 consultas no projeto vazio. O p95 medido foi 124 ms para o híbrido e 3,91 s para o braço com reranking. Nesse último braço, o modelo pontuou 96 positivos e a política de idioma dispensou os 32 positivos em português. Nos dois módulos reais foram indexados 54 arquivos de busca e 78 de documentação. O grep literal acertou 6/18. Com as sementes lexicais do grafo, o híbrido atingiu nDCG@10 de 0,567. Com o grafo desligado, atingiu 0,628 e os mesmos 15 acertos. Nos dois modos, os 18 arquivos apareceram até a posição 50. Um e dois saltos a partir das sementes híbridas acertaram 12/18 e 14/18 no top 10. O reranking obteve 0,682 e 17/18. Contra o híbrido sem grafo, o intervalo de 95% para o ganho de nDCG foi de −0,074 a +0,202. A fusão por arquivo atingiu 15/18 com RRF e 14/18 com escores normalizados. O piso de 90% continua aberto para a configuração padrão nos arquivos reais. [Perguntas com caminhos e evidências](../../evals/rag/repository-queries.jsonl) · [Comparação em código real](../../scripts/bench-rag-repository.ts)

**Documentação.** O nDCG@10 foi 0,561 com FTS, 0,748 com o híbrido e 0,531 com reranking. O cross-encoder executou em 64 das 128 consultas de aceite, incluindo casos em que havia mais de um candidato. Os três modos acertaram as 16 consultas em coleção vazia e devolveram trechos nas 16 perguntas sobre preços que os manuais não informavam. Com cortes de 0,45, 0,55 e 0,75, o Recall@5 do reranking foi 55,2%, 54,2% e 46,9%, com os mesmos 16 negativos corretos. Uma passagem sobre um produto pode ser recuperada mesmo quando o preço procurado está ausente. [Experimento de evidência](../../scripts/bench-rag-evidence.ts) · [Cortes e reformulações](../../scripts/bench-rag-doc-options.ts)

## Decisões de configuração e remoção

| Decisão | Motivo medido ou contrato preservado |
| --- | --- |
| Manter Granite, FTS e busca híbrida por padrão | A remoção do conteúdo lexical reduziu o Recall@10 sintético de 96,1% para 81,3%. E5-small FP32 alcançou 99,2%, com ganho de 0,015 em nDCG sobre Granite Q8, abaixo do mínimo de 0,02 proposto para uma troca mais cara. E5 continua disponível para perfis administrados. |
| Tornar o reranker de Docs opcional na ferramenta do agente de código | O híbrido localizou 26 passagens corretas a mais nos 96 positivos. A diferença de Recall@5 favoreceu o híbrido em 27,1 pontos percentuais, com IC pareado de 95% entre 20,8 e 33,3 pontos. `DOCS_RAG_RERANK=1` permite repetir ou ativar o ranqueador. |
| Manter recentes e grafo configuráveis e preservar o padrão de código | Marcar três distratores como recentes reduziu o nDCG sintético de 0,847 para 0,761. As perguntas reais em dois módulos mostraram variação entre semeaduras. A amostra de distratores não mede a frequência com que um arquivo recente é realmente o alvo de um usuário. |
| Conservar a pergunta original e limitar HyDE a uma geração | A busca vetorial e a híbrida compartilham o orçamento, o cancelamento e a recuperação em falha. A variante determinística atingiu 96,9% de Recall@10 e ganho de 0,012 em nDCG. Nas 30 perguntas documentais do agente, acrescentar a primeira reformulação registrada preservou os mesmos 45/45 alvos no top 5. Esse replay testa consultas formuladas pelo agente. A geração hipotética de código com um LLM próprio continua opcional. |
| Retirar lógica sem uso e manter compatibilidade pública | Foram retirados o acumulador de fusão sem leitores e a referência ao perfil `knowledge` no avaliador. O ranqueador legado de Docs via LLM ficou marcado como descontinuado. A exportação preserva consumidores existentes. A entrada pública `searchExpanded` delega à expansão compartilhada. |

## Contexto e respostas do agente

No ensaio de montagem do contexto, quatro estratégias receberam a mesma lista de passagens e um limite de 540 tokens para o prompt completo, medidos com o tokenizador embarcado. Contamos os fatos esperados que chegaram ao texto preparado pela função de síntese em 128 tarefas reservadas. O top-k bruto preservou todos os fatos em 64 tarefas (160/224 fatos). Eliminar duplicatas da mesma fonte e seção manteve os 160 fatos e reduziu a média de 450 para 389 tokens. Consultar a seção inteira resolveu 96 tarefas. Incluir um vizinho de cada lado e eliminar duplicatas resolveu 128, com 224/224 fatos em média de 447 tokens. O corpus sintético continha deliberadamente continuações e evidência em duas fontes. Mantivemos a opção `include_neighbors: 1` para recuperar continuações sob demanda. Este ensaio mede a entrada preparada para o modelo. [Montagem e avaliação do prompt](../../scripts/bench-rag-context.ts) · [Leitura utilizada pelo DocsAgent](../../packages/docs-agent/src/tools/docs-read-chunk.ts)

O GLM-5 da AWS Bedrock recebeu exclusivamente manuais e perguntas sintéticas. Foram 30 tarefas pareadas em português e inglês por configuração, 15 com a versão anterior disponível e 15 sem ela. Cada tarefa pedia módulo, política, comparação de versão e informação de preço. O modelo escolheu os argumentos de busca, leitura e conclusão. O orçamento do ensaio foi de seis rodadas por tarefa. O segundo braço usou o prompt do DocsAgent e a ferramenta de planejamento. [Harness com limite de gasto](../../scripts/bench-rag-live.ts)

| Métrica | Fluxo direto | Com planejamento |
| --- | ---: | ---: |
| Respostas concluídas | 30/30 | 28/30 |
| Tarefas aprovadas na rubrica automática | 30/30 | 27/30 |
| Citações de passagem pertinente / todas as citações | 45/56 (80,4%) | 42/44 (95,5%) |
| Passagens esperadas citadas | 45/45 | 42/45 |
| Respostas com notas numeradas válidas no texto entregue | 23/30 | 28/28 |
| Tempo de tarefa p95 | 19,49 s | 11,64 s |

Duas tarefas planejadas esgotaram o limite de rodadas e uma omitiu a informação de mensalidade. O fluxo direto incluiu passagens extras em respostas que satisfizeram a rubrica. A verificação automática confrontou caminhos, identificadores, ausência de valor monetário e IDs dos trechos. A precisão acima mede pertinência ao gabarito por passagem. Uma avaliação humana cega de cada afirmação exigiria outro julgamento.

A AWS informou 737.624 tokens de entrada e 32.973 de saída em 280 chamadas. Pelas tarifas verificadas de US$ 1,00 e US$ 3,20 por milhão de tokens, o custo estimado foi **US$ 0,84314** no total, dentro do limite autorizado de US$ 10. O primeiro braço usou cerca de US$ 0,40810 e o segundo US$ 0,43504. Duas tentativas iniciais falharam na resolução local de credenciais antes do envio. [Preços do Amazon Bedrock](https://aws.amazon.com/bedrock/pricing/)

## Latência e frescor

| Caminho medido | Escala e amostra | p95 |
| --- | --- | ---: |
| Tecla até pintura da lista lexical | 10 mil caminhos, 200 medições | 123 ms |
| Tecla até pintura da lista lexical | 150 mil caminhos, 200 medições | 124 ms |
| Tecla até resultado conceitual útil, inglês | 10 mil arquivos e 20 mil vetores, 200 medições | 631 ms |
| Tecla até resultado conceitual útil, português | Mesma escala, 200 medições | 610 ms |
| Gravação em disco até encontrar o símbolo atualizado, watcher live | 10 mil arquivos físicos, 200 gravações | 1,805 s |
| Mesma operação, watcher live habilitado para o ensaio | 50 mil arquivos físicos, 200 gravações | 1,909 s |
| Mesma operação com verificação periódica do arquivo aberto | 50 mil arquivos físicos, 200 gravações | 6,472 s |

O ensaio de interface mediu o evento de entrada, o debounce, o acesso ao índice e dois quadros de animação. Usou o renderer do produto e uma ponte HTTP de teste para o backend real. Na busca conceitual, 150/160 consultas reservadas tiveram um acerto no top 10 em cada idioma. O p95 dessa linha considera as consultas com resultado útil. Construir o índice semântico da fixture levou 404 s. A aferição do pacote portátil, com preload e IPC reais, consta na seção do Granite. [Teste lexical da interface](../../apps/dashboard/e2e/ide-search-latency.spec.ts) · [Teste híbrido da interface](../../apps/dashboard/e2e/ide-semantic-latency.spec.ts)

No ensaio de frescor, cada gravação mudou um símbolo de fato. A consulta precisou encontrar a versão nova e a versão anterior precisou sair do arquivo. O debounce foi de 1.000 ms. O p99 descritivo ficou em 3,294 s no projeto médio e 2,392 s no grande em modo live. O limite padrão do watcher é de 20 mil entradas. O ensaio live grande elevou o limite apenas no processo da fixture. Na modalidade periódica, o p99 foi 13,528 s. Durante a primeira varredura grande, o watcher excedeu a espera inicial de 30 s. O serviço agora agenda uma nova reconciliação quando a cobertura live começa, para recuperar mudanças ocorridas nesse intervalo. Em uma execução com atraso do watcher, todas as 26 gravações foram recuperadas. O p95 de 13,09 s nessa condição de inicialização ficou acima da meta de operação aquecida. [Benchmark de frescor](../../scripts/bench-rag-freshness.ts) · [Reconciliação do watcher](../../packages/services/src/services/project-index/service-watchers.ts)

## Reprodução

Os scripts nativos usam o Electron do projeto com `ELECTRON_RUN_AS_NODE=1` para carregar a ABI correta de `better-sqlite3`. O Granite vem nos recursos do projeto. Os comparativos de reranking e E5 também usam os pesos locais descritos nos manifestos. Estes comandos são para PowerShell, na raiz do repositório.

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$electron = node -p "require('electron')"
& $electron --import tsx scripts/bench-agent-retrieval.ts
& $electron --import tsx scripts/bench-rag-evidence.ts
& $electron --import tsx scripts/bench-rag-repository.ts
& $electron --import tsx scripts/bench-rag-windows.ts
& $electron --import tsx scripts/bench-rag-context.ts
& $electron --import tsx scripts/bench-rag-freshness.ts 10000 200
& $electron --import tsx scripts/bench-rag-freshness.ts 50000 200 --live
$env:RUN_LOCAL_RAG_SMOKE = '1'
$env:MCP_RAG_SMOKE_OFFLINE = '1'
& $electron node_modules/vitest/vitest.mjs run packages/indexer/src/search/__tests__/local-rag-smoke.test.ts
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Cada programa informa a pasta da rodada em `.tmp/agent-ide-reliability`. `bench-rag-alternatives.ts` recebe a pasta da rodada de código. `bench-rag-doc-options.ts` recebe a de documentação e, para o replay das reformulações, a do ensaio de respostas. `bench-rag-report.mjs` recebe as pastas de código, documentação, repositório, respostas, alternativas e montagem do contexto, nessa ordem. Ele calcula as diferenças pareadas com 10 mil reamostragens, semente fixa e agrupamento por tópico no corpus bilíngue. Nas duas subárvores reais, o agrupamento é por pergunta. Os intervalos descrevem essa amostra de um único repositório. [Análise reproduzível](../../scripts/bench-rag-report.mjs) · [Métricas e intervalos registrados](../../evals/rag/resultados-2026-11-19.json)

O ensaio pago é opt-in. `bench-rag-live.ts` exige teto de gasto e pasta de saída, registra uma reserva antes de cada requisição e confere o destino AWS. O gerador de dados cria os manuais e as perguntas. O manifesto público do benchmark contém métricas agregadas. O estudo FreshStack orientou a rotulagem por evidência e a separação entre encontrar o texto e sustentar a resposta. [Script de avaliação paga](../../scripts/bench-rag-live.ts) · [FreshStack, NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/e6b5bcc872666d37c469e5c5ba723669-Abstract-Datasets_and_Benchmarks_Track.html)

## Verificação do aplicativo e dos avaliadores

Passaram 899 testes em 97 arquivos da suíte de RAG, incluindo o smoke offline do Granite, as regressões das quatro prioridades e a compatibilidade entre o worker e a CLI nas gerações ONNX. A suíte usou Electron 42.5.0 e os limites normais de 20 segundos. Houve expirações na preparação de bancos quando o temporário ficou no volume do repositório durante as medições. Os 105 testes das suítes afetadas passaram isoladamente, e a rodada consolidada passou no temporário normal do Windows.

No projeto descartável criado pelo pacote, o avaliador público de código executou FTS, vetorial, híbrido e expansão sobre a geração publicada. Para a consulta exata e a pergunta conceitual em português, Recall@10 foi 1/2 em FTS e 2/2 nos três modos semânticos. Em outro índice descartável, a CLI de Docs executou as 160 consultas lexicais. As 480 medições documentais comparativas passaram pelo mesmo avaliador e pela busca de produção com Granite e cross-encoder locais. [CLI de código](../../src/benchmarks/search-quality.ts) · [CLI de Docs](../../scripts/docs-rag-eval.ts) · [Compatibilidade de gerações](../../packages/indexer/src/search/__tests__/semantic-profile-runtime.test.ts)

O benchmark de código real registra os hashes dos arquivos usados em cada subárvore. Uma rodada anterior recuperou 14/18 com o padrão. Na medição final, com os arquivos atualizados e as pastas selecionadas explicitamente, o resultado foi 15/18. Essa variação inclui a mudança do corpus entre as rodadas. [Manifesto e resultados](../../evals/rag/resultados-2026-11-19.json)

## Evolução no projeto instalado

Em 19 de novembro, o catálogo de `CodeStudio/MCP-CodeBase` tinha `active_generation_id = null`. O conjunto sintético cumpriu o piso de recuperação e a configuração padrão encontrou 15 dos 18 arquivos rotulados na amostra real.

Em 20 de novembro, a geração 9 entrou em operação nas duas pastas avaliadas do projeto instalado. A busca com os modelos Nemotron e peso vetorial 1,5 encontrou os 18 arquivos esperados, além dos oito arquivos do conjunto reservado. O estudo registra a cobertura do índice, o resultado por consulta e a participação efetiva do reranker. [Validação no CodeStudio/MCP-CodeBase](nemotron-no-codestudio.md)

A avaliação das respostas dos agentes é uma etapa distinta. Os testes de 19 de novembro encontraram perda de completude em três tarefas com planejamento. A revisão cega das afirmações por avaliadores independentes continua pendente.
