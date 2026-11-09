# CodeStudio 3.15.8 — correções do front-end e comparação de desempenho

## Resultado e escopo

Os onze achados F01–F11 da [auditoria React](2026-11-04-react-front-end-audit.md) foram tratados. O candidato incorpora também as correções anteriores de harness, prompts, índice, memória e notas de contexto presentes no checkout. A árvore de trabalho anterior foi preservada; nenhum perfil real foi migrado ou alterado pelos testes.

As maiores interrupções reproduzidas estavam no histórico consolidado em uma única linha virtual e no parsing/renderização de Markdown longo. Nas duas execuções finais de cada versão, o histórico de 2.000 mensagens passou de **22.031 para 245 elementos DOM**; as tarefas de **737–745 ms** desapareceram. Na carga de Markdown, a maior interação automatizada caiu de **364–392 ms para 16–22 ms** e as **25–28 tarefas longas passaram a zero**.

Isso demonstra a correção nos cenários exercitados. Não constitui uma garantia de ausência de travamentos em qualquer projeto, extensão, driver ou provedor.

## Correções entregues

| Achado | Implementação | Preservação e validação |
| --- | --- | --- |
| F01 — stream Electron | Iterator com encerramento idempotente, liberação de fila/waiters, fechamento de porta e cancelamento por renderer/requestId. O reader SSE pendente também é cancelado. | Retorno antes da transferência, frames tardios, falha de transferência e isolamento entre renderers cobertos. Unsubscribe remove a observação sem matar o PTY; reattach reproduz a saída. |
| F02 — histórico | Agrupamento linear e segmentos de até quatro blocos por linha virtual, inclusive uma única mensagem com milhares de blocos. | Ordem, IDs, resultados, uso agregado, cópia integral, resumo final e seleção nativa preservados. |
| F03 — patches repetidos | Cache fraco por entrada/conteúdo, bloco de edição memoizado e nenhuma varredura de edições enquanto a rodada está em streaming. | Entrada alterada invalida o cache; resultados/paths finais continuam atualizando. |
| F04 — plugins | Streams pertencem ao frame e à instalação do bridge. Fechar, remover, substituir ou desmontar encerra o iterator. | Resolução atrasada e IDs repetidos não ressuscitam assinaturas; namespace continua validado. |
| F05 — SSH | Polling serial pelo scheduler compartilhado, com guarda após await e pausa do documento oculto. | Resposta tardia não atualiza React nem recria timeout; o túnel continua sendo uma operação independente. |
| F06 — cache | Expiração por um único timer, teto de 64 entradas e orçamento estimado de 256 KiB/entrada e 2 MiB total. | Requests em andamento continuam deduplicadas; consumidor individual não aborta os demais. Invalidação impede repovoamento por resposta antiga. |
| F07 — superfícies ocultas | Contexto de visibilidade pausa assinaturas, consultas, polling e relógio usados pela apresentação. | Transporte/store continuam ativos. Teste real de hide/reveal confirmou a última atualização ao voltar. |
| F08 — capítulos | Uma página de 100 mensagens por navegação, Anterior/Próxima, até três capítulos abertos e descarte/abort ao recolher. | Respostas tardias ignoradas. Endpoint fornece resultados de ferramentas e `preceding_user_seq` nas fronteiras de página, preservando status e referências de desfazer. |
| F09 — Company | Preview limitado a 81 caracteres por agente, assinatura individual e shell separado dos deltas. | Texto canônico da conversa permanece no armazenamento apropriado; o preview apresentado é equivalente. |
| F10 — Markdown | Documentos acima de 12 mil caracteres usam parser em worker compartilhado e viewport virtual. Divisão recursiva limita descendentes das linhas, incluindo listas aninhadas, parágrafos com muitos links e células grandes. | Documento inteiro é analisado para preservar referências/fences/tabelas. Cópia integral, seleção interna, links, segurança de URLs, substituição de texto e descarte do worker cobertos. Fences isolados grandes usam o preview de código sem construir a AST. |
| F11 — prevenção | ESLint 10 com preset oficial de hooks, `check:react`, teste do detector de regressões e baseline explícita. | Zero novos diagnósticos. Permanecem **478 diagnósticos legados** documentados; quatro corrigidos foram removidos da baseline. Compiler e StrictMode global não foram ativados sobre o Monaco. |

Respostas muito longas passam a ter uma área de leitura com rolagem própria, de até 480 px. Fragmentos extensos preservam conteúdo e formatação, embora possam apresentar quebras entre partes. O botão de copiar usa sempre o texto completo. A divisão de tabelas mantém células/colunas e repete cabeçalhos comuns; um cabeçalho excepcionalmente grande recebe partes próprias para respeitar o orçamento.

## Comparação controlada

Dados completos e hashes: [comparison.json](../../.tmp/react-fixes-2026-11-04/comparison.json).

| Cenário/medida | Antes | Depois |
| --- | --- | --- |
| Histórico de 500 mensagens: elementos DOM | 5.531 | 245 |
| Histórico de 500: maior tarefa da montagem | 219–235 ms | Nenhuma tarefa acima de 50 ms |
| Histórico de 2.000: elementos DOM | 22.031 | 245 |
| Histórico de 2.000: maior tarefa da montagem | 737–745 ms | Nenhuma tarefa acima de 50 ms |
| Histórico de 2.000: maior render React | 379–385 ms | 6,5–8,5 ms |
| Histórico de 2.000: heap do renderer após GC | 25,23 MiB | 9,14 MiB |
| Markdown de 100 mil caracteres: elementos DOM | 5.322 | 62 |
| Markdown: tarefas longas em 24 atualizações | 25–28 | 0 |
| Markdown: maior interação automatizada de input | 364–392 ms | 16–22 ms |
| Chat oculto: commits em 120 atualizações | 171–175 | 1 atualização residual da montagem |
| Controle vivo com 2.000 blocos: p95 dos intervalos de frame | 17,9 ms | 17,8 ms |

No teste funcional que aguarda a estabilização antes de esconder, 20 atualizações ocultas produziram **zero commits**, e o retorno mostrou o último texto. O controle vivo já era leve e continuou leve; sua latência máxima de input variou de 26–27 ms para 25–29 ms, sem tarefas longas. Não se afirma melhora em todas as medidas.

Microbenchmarks separados, executando as funções reais com os mesmos dados:

- Agrupar 5.000 mensagens: **83,92 → 1,10 ms**, mediana de sete passagens.
- Reconsultar 200 patches de mil linhas: **15,93 → 0,022 ms**, mediana com cache aquecido. A primeira análise continua tendo custo; durante streaming a varredura visual é omitida.
- Preview Company em 10 mil deltas: **308,14 → 0,92 ms** cumulativos na prova pura, com texto de apresentação equivalente.

Esses tempos não são latência de um frame ou percentual de CPU do aplicativo. Evidências: `pure-comparison.json` e `company-preview-cost.json` em `.tmp/react-fixes-2026-11-04/`.

## Método e limites

- Duas execuções seriais por versão, React 19.2.5 em produção com profiling, Chromium 149 e viewport 1.280 × 800. O profiling adiciona custo; intervalos apresentados são mínimo/máximo das duas execuções, não intervalos de confiança.
- A fonte anterior foi copiada antes das alterações para `.tmp/react-fixes-2026-11-04/before/`. O baseline final foi reconstruído dessa cópia usando a mesma fixture corrigida para ambas as versões, com deltas que acrescentam texto e a identidade de blocos usada pelo projetor real.
- A fixture monta componentes reais com providers/CSS e viewport limitados. Usa dados sintéticos e nenhuma chamada a modelo. A entrada normal do chat continua usando uma cauda pequena; o histórico grande representa scrollback/capítulo/importação.
- Input mede o trajeto de automação até o texto observado, **não INP**. Heap informado é somente do renderer; não soma heap do worker. O trace de GC pode incluir workers. Mover parsing para o worker não elimina suas alocações.
- As montagens preliminares que encontraram o decoder dependente de DOM no worker ou a identidade incorreta de blocos da fixture foram excluídas da comparação. O decoder portátil oficial é usado em dev/build; testes posteriores exigem worker pronto e texto visível correto.
- Há verificações de cópia dos 100 mil caracteres, leitura até o fim, listas aninhadas, edição sem AST anterior, seleção ao rolar, hide/reveal e encerramento do último worker.

## Testes e pacote

**1.578 testes distintos aprovados**, sem somar reexecuções: 1.576 testes Vitest em 271 arquivos e dois testes Node do detector de regressões React. Isso inclui toda a suíte do dashboard (**239 arquivos / 1.423 testes**), 151 testes de Electron/API afetados e dois testes adicionais de encerramento SSE. Não representa a execução de toda a suíte do monorepo. Inventário deduplicado: [validation.json](../../.tmp/react-fixes-2026-11-04/validation.json).

Os dois typechecks passaram. O gate React analisou 1.453 arquivos: zero novos diagnósticos e 478 legados explicitamente registrados. O build completo de produção e o empacotamento NSIS terminaram com código zero. A primeira passagem do dashboard encontrou dois problemas durante as últimas alterações; ambos foram corrigidos, e a suíte inteira passou novamente com a fonte estabilizada.

O mesmo candidato empacotado foi exercitado com perfis e dados sintéticos:

- **Chat real:** 1.002 mensagens persistidas, sete páginas HTTP 200 e resposta Markdown completa de 105.188 caracteres. O worker veio da ASAR; o fim do documento ficou acessível, com 24 linhas de transcript e 14 de Markdown montadas. Digitação, navegação do histórico e retorno ao fim passaram, sem erro de página ou CSP.
- **Ciclo de vida:** 100 aberturas/fechamentos reais de stream Electron, incluindo retorno antes da transferência e leitura pendente, passaram. A variação de heap após GC foi +29.620 bytes nessa amostra curta. Isso confirma o encerramento exercitado, sem certificar ausência de qualquer vazamento em sessões longas.
- **Memória/notas:** paginação de 42 notas, criação, edição imutável, fixar, arquivar, restaurar e recarregar passaram. A importação de uma nota legada foi idempotente e preservou o original, histórico e tags; os indicadores concordaram com as 44 notas finais.
- **Runtime nativo:** SQLite, sqlite-vec, busca/inserção/exclusão, isolamento por namespace, referências e cobertura passaram no Electron empacotado. A verificação de recursos, MCP por stdio, code_exec, cancelamento, paginação Unicode, consultas Git e descarte dos processos também passou.

O teste funcional do aplicativo completo observou **uma tarefa longa de 91 ms**. Portanto, o resultado de zero tarefas acima de 50 ms pertence aos cenários A/B específicos da tabela, e não a toda interação possível no aplicativo. Evidência do chat e do encerramento dos processos: [frontend-smoke-results.md](../../.tmp/react-fixes-2026-11-04/packaged/frontend-smoke-results.md).

### CPU ociosa do aplicativo empacotado

A comparação usa os executáveis 3.15.7 e 3.15.8, em sequência, com perfis novos e o mesmo projeto sintético pequeno. Cada cenário aguarda 15 segundos e mede os 30 seguintes. A janela fica visível, não minimizada e sem foco; o teste rejeita qualquer ganho de foco durante a amostra. Não havia build ou teste pesado próprio em paralelo. Trata-se de uma amostra por cenário, sem certificação de uso prolongado em projetos reais.

A medida soma o tempo cumulativo de CPU dos processos Electron reportados por `app.getAppMetrics()`. Probes externos não entram nessa soma. O percentual de um processador lógico é dividido por 32 para obter o percentual da máquina; não se deve confundir as duas unidades. Ambos os candidatos já incluem as correções anteriores de CPU em idle, portanto este comparativo não reproduz o estado do aplicativo instalado antes de todas as correções.

Dados completos: [idle-comparison.json](../../.tmp/react-fixes-2026-11-04/idle-comparison.json). A primeira passagem tinha foco desigual entre versões no editor/chat e foi excluída do comparativo final, sendo preservada em `idle-comparison-preliminary-focus-mismatch.json`.

| Cenário | Antes: % da máquina | Depois: % da máquina | Antes/depois: % de um processador lógico |
| --- | --- | --- | --- |
| Tela inicial | 0,078% | 0,080% | 2,50% / 2,57% |
| Projeto/editor aberto | 0,091% | 0,078% | 2,90% / 2,50% |
| Chat vazio aberto | 0,044% | 0,042% | 1,41% / 1,35% |

O consumo ficou baixo nas duas versões. Essa amostra curta não demonstra uma redução geral de CPU ociosa; a tela inicial oscilou para cima e os outros dois cenários para baixo. Os ganhos consistentes desta entrega estão nos cenários pesados de histórico/Markdown apresentados acima. As seis amostras finais mantiveram o mesmo estado de foco; ambas as instâncias encerraram sem processos remanescentes.

### Instalador

- Arquivo: [CodeStudio Setup 3.15.8.exe](../../dist/electron-react-fixes-20261104/CodeStudio%20Setup%203.15.8.exe).
- Tamanho: **340.955.311 bytes**; Electron **42.5.0**.
- SHA-256: `9d5b622362f2f241fc68b27f857cbe7751759d5a778ed576371c82a110b23a97`.
- ASAR testada: `5984bc089f967713f77fc168bab3b3b869881a6a8e82edef08035541d529ecfa`.
- Assinatura Authenticode: `NotSigned`. Instalador gerado localmente; não instalado nem publicado automaticamente.

As evidências permanecem em `.tmp/react-fixes-2026-11-04/`; o instalador anterior está preservado em `dist/electron-knowledge-fixes-20261104/`, com SHA-256 confirmado sem alteração. A inspeção final de processos encontrou zero processos dos candidatos/scripts de teste; os sete processos CodeStudio externos a esta validação foram preservados. Manifesto final: [delivery.json](../../.tmp/react-fixes-2026-11-04/delivery.json).

## Referências técnicas

A implementação mantém a separação entre assinatura, renderização e estado durável. O [Profiler oficial do React](https://react.dev/reference/react/Profiler) explica a instrumentação usada; as [regras oficiais de hooks](https://react.dev/reference/eslint-plugin-react-hooks) fundamentam o novo gate. O pipeline do [react-markdown](https://github.com/remarkjs/react-markdown) foi preservado no worker, incluindo o tratamento seguro de URLs e HTML literal. A distinção entre alocações, retenção e vazamento segue a [documentação de memória do Chrome](https://developer.chrome.com/docs/devtools/memory-problems).
