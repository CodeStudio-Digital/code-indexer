# Reteste do harness, CPU e prompts — 4 de novembro de 2026

Esta rodada implementa correções sobre a auditoria de 3 de novembro e sobre a recuperação de chats tratada em seguida. O checkout é `D:/MCP`, versão 3.15.7, com alterações locais preexistentes preservadas. A instalação do usuário e seus chats não foram substituídos pelos testes.

## Correções verificáveis

- **Continuidade do chat:** o incidente `TOOL_OUTCOME_UNKNOWN` foi rastreado a trabalho síncrono de `glob` no host, que impedia a entrega de heartbeats e fazia um evaluator saudável parecer morto. A enumeração passou a ceder execução e observar cancelamento; o watchdog usa relógio monotônico e considera atraso do host. Efeitos realmente desconhecidos continuam sem replay cego: um novo turno pode investigar e retomar com aprovação específica para novo efeito, preservando a incerteza original. Recuperação, compactação/restart, permissões e idempotência entraram nos retestes. Evidência do incidente: `.tmp/chat-continuity-2026-11-04/result.json`.
- **Editor TypeScript:** um projeto sintético de dois arquivos, dentro de outra árvore, adotava automaticamente o `tsconfig.json` da pasta pai. A execução carregou 4.199 arquivos e o processo principal chegou a aproximadamente 1,3 GB de RSS. A descoberta agora usa `tsconfig.json` ou `jsconfig.json` na raiz registrada. Referências e `extends` explícitos continuam permitidos. Também foi verificada a análise de JavaScript quando o config da pasta pai o excluiria.
- **Consultas de status:** polling aguarda o término de callbacks assíncronos antes de agendar a próxima consulta, não inicia trabalho em uma janela oculta e remove timer/observador no descarte. Gerenciador de processos, Chrome Service e Supervisor retornam suas promises ao controlador. Callbacks que retornam `void` não oferecem prova de conclusão de IO interno; a interface documenta essa diferença.
- **Git:** a descoberta de submódulos deixa de iniciar um processo Git apenas para descobrir que `.gitmodules` não existe. A criação posterior do arquivo, a invalidação do cache e repositórios com submódulos continuam cobertos.
- **Git e interface:** comandos classificados como leitura iniciam seus processos em um worker reutilizável, com quatro execuções simultâneas e até 64 pedidos pendentes. Mutação/rede mantêm o caminho anterior. Deadline, limite de saída, instrumentação e encerramento são preservados; ownership por PID também sobrevive a falha antes da entrega da mensagem do worker. O worker ocioso fica sem `ref`, sem timer periódico e sem filho Git, mantendo o custo de memória de uma thread. Isso tira o bloqueio de `spawn` da thread principal; não elimina o custo de CPU do Git.
- **Markdown do chat:** blocos recolhidos exibem uma prévia limitada a 24 linhas/3.500 caracteres. Copiar usa o conteúdo integral, e expandir revela o texto completo. Acima de 50 mil caracteres, o bloco expandido usa texto simples para evitar uma tokenização longa. Requisições de highlight obsoletas são descartadas antes do trabalho síncrono, inclusive após aguardar a gramática. Não há interrupção de uma tokenização síncrona que já começou.
- **CPU em todas as telas:** o logo pequeno e permanente da barra superior mantinha animações SVG infinitas com filtros, repintando mesmo sem tarefa. `public/brand/logo-mark.svg` agora é estático, com geometria, gradientes e filtros preservados e traços completos. Splash e indicador reativo do microfone são implementações separadas. A comparação visual cobriu 20/48/256 px nos fundos claro/escuro; somente o `<style>` do asset mudou.
- **Despertar de colaboração:** notificações que não podem iniciar um turno são filtradas antes de consultar recibos. A projeção usa lotes de até 32 operações de IO. Uma fixture com 505 notificações e duas mensagens elegíveis fez quatro leituras de recibos, preservando recuperação de pendências antigas sem truncar o histórico.
- **Estado de validação:** sucesso anterior não prevalece sobre uma falha posterior. Comandos citados por `echo` ou em nomes de arquivos não certificam execução. Um terminal ainda em execução não certifica sucesso; a conclusão precisa corresponder à sessão iniciada, terminar com código zero e continuar válida para as edições verificadas.
- **Providers:** o wrapper de resiliência preserva os metadados de raciocínio do provider, inclusive após troca de modelo.
- **Colaboração na interface:** contratos compartilhados, resposta inválida recuperável e botão de retomada após pausa. O estado `stopped` é retornado pela API. Os cenários incluem vínculo de chats, policy, pausa e retomada com backend local real, sem iniciar modelo.
- **Prompts:** intenção de ação, modos e permissões, efeitos desconhecidos, delegação, compactação, recuperação do Master, skills, DocsAgent, APIs, pré-análise e autocomplete foram revisados. Ver [inventário e testes](2026-11-04-prompts-harness.md). Overrides personalizados e prompts persistidos do usuário não foram reescritos.

## CPU: o que foi observado

O CodeStudio instalado não estava aberto quando a investigação começou. Foram usados perfis isolados, conta fictícia sem tokens, dois arquivos locais, um repositório Git próprio e chat sem chamadas a modelos. A primeira investigação com profiler concorreu com a suíte geral; serve para localizar funções e reproduzir o problema de configuração, não para certificar latência absoluta.

O profiler do editor identificou tempo no início de processos Git e o serviço TypeScript carregando a árvore da pasta pai. A hipótese inicial de um ciclo causado por identidade instável de `useApi.refetch` não se confirmou: o callback é estável.

A primeira comparação após as correções de backend/Markdown reduziu memória, mas não CPU. A investigação continuou: o renderer consumia CPU em trabalho nativo, sem tempo relevante de JavaScript. As capturas antes/depois eram iguais em 1400×900, exceto por 102 pixels no logo; o SVG e as opções de janela tinham hashes idênticos. Portanto, esse custo era preexistente.

O experimento causal usou **o mesmo processo**: logo normal → imagem vazia do mesmo tamanho → logo restaurado, com 10 s de acomodação e 20 s de medição por estado, sem profiler/build/testes concorrentes.

| Estado | CPU Electron / máquina de 32 processadores lógicos | CPU renderer / um núcleo | CPU do processo GPU / um núcleo |
| --- | ---: | ---: | ---: |
| Logo animado | 0,818% | 9,880% | 14,356% |
| Imagem vazia no mesmo espaço | 0,054% | 0,760% | 0,067% |
| Logo animado restaurado | 0,717% | 8,860% | 13,280% |

O custo retornou ao restaurar apenas o logo. A correção mantém o desenho estático; não deixa o espaço vazio usado pelo experimento. Evidências: `logo-causal-comparison.json`, `static-logo/result.json` e `static-logo/comparison.png`. CPU do processo GPU é tempo de CPU desse processo, não utilização percentual do hardware gráfico.

Uma leitura exclusivamente de diagnóstico agregado da execução real de 04/11, entre 08:47 e 11:34 BRT, encontrou 668 amostras em aproximadamente 167 minutos. Nos valores reportados por `app.getAppMetrics`, Browser teve média 0,08, p95 0,2 e pico 1,5; Tab teve média 0,10, p95 0,5 e pico 1,0. Foram registrados quatro freezes do main, 22 do renderer e dez eventos lentos de status Git, chegando a 1.378 ms. Esses dados não demonstram CPU continuamente alta, não identificam todos os intervalos como ociosos e não abrangem todos os processos auxiliares externos ao Electron.

As comparações finais usam consumo acumulado de CPU dividido pelo tempo da janela. O percentual de um núcleo e o percentual da máquina, com 32 processadores lógicos, são apresentados separadamente. Memória do processo principal inclui workers e alocações nativas. Perfis pequenos e sintéticos não certificam desempenho em todo projeto real.

Após o build com o logo estático, os três cenários foram repetidos sem compiladores, testes ou profiler concorrentes, com 15 s de acomodação e 30 s de medição. Não houve `pageerror`.

| Cenário | CPU Electron/máquina antes | CPU final | CPU renderer/um núcleo antes → final | Memória principal antes → final (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Tela inicial | 0,548% | **0,068%** | 6,766% → 0,276% | 251 → 255 |
| Projeto/editor | 0,750% | **0,192%** | 8,522% → 0,493% | **1.207 → 629** |
| Chat parado | 0,550% | **0,036%** | 8,088% → 0,012% | **1.207 → 632** |

Evidência: `idle-comparison.json`, perfis `idle-quiet-baseline` e `idle-quiet-final-static`. A rodada intermediária sem a correção do logo (`idle-quiet-after`) foi preservada, inclusive seus números piores. A medição final registra também foco/visibilidade, bounds e display; os ensaios anteriores não registravam esses campos. São amostras locais únicas, não intervalos de confiança. O A/B no mesmo processo sustenta a atribuição do custo ao logo apesar dessa limitação. A melhora de memória do editor corresponde ao projeto sintético aninhado que antes carregava a configuração da pasta pai.

## Travamentos da interface

O teste A/B de Markdown usou a implementação anterior preservada e a implementação corrigida no mesmo Chromium, com cerca de 422 mil caracteres distribuídos em três fences de 1.500 linhas. Duas execuções por implementação alternaram a ordem para reduzir viés de aquecimento. O conteúdo Markdown montado passou de 54.067 para 931 nós no estado recolhido. O maior atraso observado de digitação passou de aproximadamente 767 ms para 87–88 ms; p95 passou de 104–108 ms para 29–33 ms. Antes houve quatro tarefas longas por execução, somando 754–761 ms; depois não houve tarefa longa nesse cenário. Expandir o bloco também deixou de produzir a tarefa longa de 87–89 ms observada antes. A cópia integral e a última linha do conteúdo foram verificadas, sem `pageerror`.

Evidência: `.tmp/harness-retest-2026-11-04/renderer-freeze/markdown-comparison.json`. A latência mede a ida e volta da digitação automatizada, incluindo o controle do browser; não é uma medição de INP. Esses números medem essa fixture, não o p95 de todas as interações do aplicativo. Os 17 relatórios históricos de freeze do renderer representam 22 ocorrências únicas, mas não contêm URLs/stacks úteis; portanto, não permitem atribuir retroativamente cada freeze a Markdown.

O cenário separado de lista com 5.000 blocos manteve 22 linhas montadas no topo e 24 no fim; 120 frames tiveram p95 de 17,7 ms e máximo de 18,9 ms. Os 12 comandos de digitação tiveram p95/máximo de 7,0 ms, sem erros do renderer. Ele mede `MessageList` isolado em Chromium, sem inicialização do Electron.

As oito regressões de Markdown e o typecheck do dashboard no host passaram. O relatório cumulativo `idle-backend-tests/report.json` registra métodos, resultados, limites e hashes SHA-256; `renderer-freeze/hashes.json` identifica o source e os artefatos medidos. Os runners aguardaram o fechamento de Chromium e dos servidores de preview. Uma checagem posterior encontrou zero runners/Chromium de teste ativos; os PIDs desses dois benchmarks não foram registrados antes da saída. Nas fixtures anteriores de colaboração, os seis PIDs registrados foram verificados como encerrados.

O benchmark local de persistência verificou históricos de 100, 1.000 e 10.000 turnos. Em 10.000 turnos, abertura/projeção inicial levou 108,1 ms e commit/leitura aquecidos tiveram p95 de 4,7 ms em 20 amostras, sem reaplicar o histórico inteiro a cada commit. Quatro leituras independentes de 100 ms foram despachadas com concorrência quatro, terminando em 109,5 ms. Artefato: `harness-performance.json`; execução sintética em Node 22, sem modelo ou serviço externo.

## Evidências

Artefatos desta rodada: `D:/MCP/.tmp/harness-retest-2026-11-04/`. O runtime compilado anterior foi preservado em `baseline-dist`, sem copiar instaladores ou perfis reais. O roteiro de medição está em `profile-idle.mjs`/`run-profile.mjs`; resultados incluem screenshots, métricas por processo e perfis V8 quando habilitados.

Os testes de regressão de LSP, polling e Git foram executados no host. A interface passou nos três tamanhos de janela com backend sintético e real isolado. A rodada exaustiva executou **11.751 testes: 11.680 passaram, 37 falharam e 34 foram ignorados**, em 52 min 28 s. Ela começou antes das correções e atravessou alterações de fontes; por isso não certifica o estado final inteiro verde.

Depois de estabilizar as fontes, a regressão integrada executou **1.505 testes em 172 arquivos: 1.502 passaram e três falharam**. A regra de tradução foi ajustada apenas para a fixture sintética e para os literais exatos “×” e “Ultra”; uma regressão adicional confirma que os componentes de produção continuam cobertos. Os **8/8 testes de i18n** passaram. Os outros dois casos, push e checkout CRLF, excederam o limite durante concorrência com build/empacotamento; repetidos sem essa disputa, **13/13 passaram com os mesmos limites**, sem mudar produção. O caso de push passou de 75,7 s para 2,94 s; o CRLF, do timeout de 60 s para 1,58 s. O `EBUSY` ocorreu no cleanup após timeout e não se repetiu. Esse resultado sustenta separar integração Git de builds pesados; não apagar os logs da rodada falha.

As verificações finais de TypeScript backend/dashboard, boundaries, LOC, ciclos, deadcode e ambiente passaram. O inventário gerado de ambiente foi restaurado byte a byte. O build completo passou e o candidato empacotado passou em closure de módulos, renderer/assets/imagens, deep links, indexador, QuickJS, conversão web, Sharp/FFmpeg, MCP, SQLite, cancelamento, saída Unicode e ownership. O worker Git foi exercitado dentro do ASAR: oito leituras reais, rejeição de comando mutável e registry vazia após encerramento.

Consolidando o último resultado de cada arquivo afetado, são **1.506 testes aprovados em 172 arquivos, zero falhas ou skips**, incluindo os 11 arquivos das 37 falhas originais. Essa consolidação não equivale a uma única rodada exaustiva final verde. Os 12 cenários Playwright de colaboração também passaram, com backend local isolado. Após a rodada integrada, somente o teste de i18n e o estilo do SVG foram alterados; o teste passou novamente e o SVG foi validado visualmente, reconstruído e medido no aplicativo.

As duas dependências críticas foram corrigidas e testadas. O audit de produção agora contém **zero críticos, 75 altos, 83 moderados e 13 baixos**; os 171 achados restantes exigem triagem de exposição. Ver [relatório de dependências](2026-11-04-dependency-security.md).

## Candidato final e rastreabilidade

O candidato final é [CodeStudio Setup 3.15.7.exe](../../dist/electron-harness-retest-20261104-static/CodeStudio%20Setup%203.15.7.exe), em `dist/electron-harness-retest-20261104-static/`, com 340.937.388 bytes. SHA-256: `4204a4782201f7a1f7c4cad4009e974fd7f08d87fe6a43615ce884fc1b503b93`. A assinatura Authenticode reporta `NotSigned`: é um candidato local, não uma distribuição assinada. Ele não foi instalado nem publicado; a instalação e os chats existentes foram preservados.

O pacote final repetiu os smokes com sucesso. A closure encontrou 2.445 módulos alcançáveis e 43 pacotes, sem referências ausentes. O logo dentro do ASAR tem exatamente o SHA-256 do asset medido: `e7f18c023cf6f9499dca0e8fb2b785c5a508bb4c487469033d8dc7a989a56522`. A pasta candidata anterior, sem o sufixo `-static`, é intermediária e foi preservada; não é o artefato final indicado acima.

A [consolidação em JSON](2026-11-04-reteste-evidencias.json) registra fontes, hashes, resultados, reconciliação de falhas, CPU, memória e o pacote. O snapshot de 6.053 arquivos de código/configuração mudou após o freeze somente no teste de i18n; o SVG possui hashes separados. O `git diff --check` canônico passou. Ao encerrar, 52 PIDs registrados foram consultados e nenhum permanecia ativo; os perfis confirmaram fechamento e os smokes verificaram limpeza de processos próprios. Não houve encerramento de processos alheios. Os benchmarks de renderer anteriores não registraram PID antes da saída; essa limitação está explicitada no relatório da frente.

## Comparação e limites

A [auditoria anterior](2026-11-03-validacao-geral-harness.md) contém a comparação documentada com Codex, Claude Code, OpenCode, OpenHands e Aider, os pontos fortes e o backlog. As correções desta rodada atacam confiança de validação, continuidade, custo de tarefas periódicas e coerência de contratos. Não foi executada uma avaliação pareada de eficácia de agentes com o mesmo modelo e orçamento.

Os pontos fortes continuam sendo persistência e recuperação de sessões, contratos tipados entre componentes, ampla integração de providers/ferramentas, virtualização da interface e testes reais do pacote com módulos nativos. Os pontos fracos confirmados nesta rodada foram trabalho pesado dentro das threads interativas, escopo excessivo da análise do editor, consultas periódicas com IO desnecessário e contratos de validação/prompts divergentes.

O comparativo foi revisto nas fontes primárias: [OpenCode](https://opencode.ai/docs/permissions/) documenta regras de aprovação por ferramenta e argumentos; [Aider](https://aider.chat/docs/usage/lint-test.html) explicita o ciclo configurável de lint/test; [OpenHands](https://docs.openhands.dev/sdk/arch/overview) separa SDK, ferramentas, workspace e servidor. Essas referências sustentam melhorias de arquitetura e confiabilidade. Não sustentam a afirmação de que outros harnesses nunca travam.

A metodologia segue a orientação do [Electron de medir o código em execução e separar os processos](https://www.electronjs.org/docs/latest/tutorial/performance). Compilação e testes não comprovam obediência perfeita de todos os modelos. Permanecem decisões arquiteturais da auditoria: confinamento real de plugins de terceiros, isolamento maior do backend em relação ao processo principal, gate completo de distribuição e homologação em projetos reais grandes.

## Tarefas após esta rodada

| Prioridade | Tarefa | Critério de conclusão |
| --- | --- | --- |
| P1 | Triar os 171 alertas restantes e gerar SBOM do artefato | Pacotes alcançáveis identificados; correção ou exceção fundamentada, com testes de compatibilidade. |
| P1 | Confinar plugins não confiáveis | Canários de arquivo, rede, ambiente e subprocessos bloqueados no modo restrito; worker isolado não é sandbox de SO. |
| P1/P2 | Formalizar gate de distribuição | Types, guards, testes e pacote identificados pelo mesmo snapshot; sem publicar quando uma etapa falha. Integração Git executada sem empacotamento concorrente. |
| P2 | Homologar CPU/fluidez em projetos reais grandes | Janelas repetidas de ociosidade e interação, processos auxiliares incluídos, p50/p95 e orçamento de regressão; distinguir main, renderer, GPU e indexação. |
| P2 | Endurecer cleanup das fixtures Git após timeout | Cancelar e aguardar operações antes de remover diretórios, sem deixar processos ou esconder falhas com timeout maior. |
| P2 | Ampliar isolamento do backend e limites de custo | Retirar outros trabalhos pesados da thread interativa com perfis que comprovem a necessidade. |
| P2 | Avaliar eficácia do harness e prompts com modelos reais | Mesmos casos, modelo, orçamento e ambiente; medir acerto, custo, latência e recuperação, com traces revisáveis. |

Na lista da auditoria anterior, T01, T04, T05, T06 e T08 foram tratados nesta rodada. T03 e T14 avançaram com correções e medições; T02, T09–T13 e T15–T16 continuam com trabalho arquitetural ou de homologação. O histórico de T07 foi reconciliado, mas a nova evidência de contenção mantém a melhoria de estabilidade dos testes como tarefa aberta.
