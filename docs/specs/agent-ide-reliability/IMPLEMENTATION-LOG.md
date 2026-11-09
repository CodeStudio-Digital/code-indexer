# Implementação e evidências — registro cronológico

> **Proveniência.** Conteúdo integral do `IMPLEMENTATION.md` de 26/10/2026 10:55, escrito pelo agente implementador. Foi movido para cá em 26/10/2026, quando o `IMPLEMENTATION.md` passou a ser o relatório por requisito exigido pelo capítulo 07 §10.
>
> O texto foi preservado. As únicas alterações são correções de referência marcadas com *[corrigido]* e linhas em branco antes de títulos. As afirmações abaixo são do implementador. A verificação independente está em [AUDIT.md](./AUDIT.md) e o estado consolidado em [IMPLEMENTATION.md](./IMPLEMENTATION.md).

Atualizado em 26/10/2026. Workspace D:\MCP. Baseline: 448d526dd2e24247617938721c0d8cf18ce850cf. Escopo autorizado B00–B22, runtime TypeScript, avaliações externas exclusivamente GLM 5.3/Z.ai.

## Estado

Implementação em validação. Não houve commit, push, publicação ou substituição da instalação ativa. Os capítulos 01–07 preservam diagnóstico e critérios originais; este registro distingue código, testes, medições e gates de release.

## Implementação por frente

| Requisitos | Implementação | Prova |
|---|---|---|
| IDX-01/02/03 | Journal durável path/versão, CAS no ack, revisão transacional, staging/publicação atômica e cache por revisão | project-index-service, structural-generation, hybrid-cache-revision, upgrade/restart |
| IDX-04/05/06/08/09, MCP-09 | Grep do disco atual/arquivos novos, aquisição limitada, cobertura/revisão/hits estruturados e preview limitado | bounded-grep, text-grep, truncation-metadata, semantic-search-delegation |
| IDX-07 | Signal/supersession API→HyDE→embedding→vector direto/híbrido→owner | 59 testes de busca/cancel; sem nova consulta vetorial/cache após abort |
| IDX-10/11 | FTS column compatível, normalização PT/EN, dedupe de chunks, diversidade, guarda PT do reranker; buscas independentes paralelas na IDE | ablação 200 queries/600 linhas e input→paint |
| IDX-12 | Migração, reinício, leitura antiga e restauração de backup em perfil descartável; candidato empacotado | upgrade-1792955740496/report.json; release smokes |
| DSC-01/03/04/09 | Catálogo compartilhado da attempt, cache selado, aliases, prioridade exata e ranking PT/EN | corpus congelado de 200 consultas |
| DSC-02/05/06/07 | Autorização separada de visibilidade, abstenção, expansão pendente, receipt derivado da projeção e hard limits do adapter | 200 estados de descoberta e testes de assembly/projection/provider decorators |
| DSC-08/10 | Limites de listagem/describe, nomes públicos preservados e eventos por tool | contratos de find_tools/expand_toolset/catalog/list_tools |
| MCP-01/02/03/04/08/10 | Paginação/budgets, validação por tool, refresh por fonte, configuração/revisão e snapshot da attempt | catálogo, cursor repetido, schema inválido, fonte lenta e SDK instalado |
| MCP-05/06/07 | Adapter estruturado/multimodal, lost ack/unknown, hints remotos conservadores | bridges, host/worker, nested e ledger |
| EXE-01/02/04/05 | Dispatcher comum, RPC estruturado, budgets, identidade e fences compartilhados | contratos direta/nested, fan-out e resultado cíclico |
| EXE-03 | Avaliador em processo descartável com watchdog externo | loop síncrono/pós-await; host responsivo e candidato |
| EXE-06/07/08/10 | CommandSpec argv/shell, ownership, admissão, poll/input/stop, drain e árvore | exec-command, persistent-command-port, Node process fixtures |
| EXE-09/11 | Spool UTF-8 limitado, cursores vinculados ao dono, quota/TTL e recovery sem replay | process-output e smoke empacotado |
| EXE-12 | Windows/pipe no executável candidato; executor e cleanup de grupo POSIX em Linux | `packaged-runtime-final/report.json`, `posix-runtime/report.json`; SSH/adapters remotos not_run |
| DB-01/05/08 | Scanner SQL por dialeto, outcomes e capacidades reais | corpus adversarial, DDL e commit/rollback incertos |
| DB-02/06/11/14 | Identidade projeto/conexão/database/revisão, leases/drain e autoridade comum | manager, handlers e tools/db; unknown sem replay |
| DB-03/04/12 | Rows/bytes/célula na aquisição, cursor/stream, cancel fora do pool saturado e SQLite filho | PostgreSQL milhão de linhas; fila/cancel/host responsivo |
| DB-07/09 | Catálogo progressivo na origem/cursor assinado e edição otimista com PK completa | catalog-export, checked edits e grid |
| DB-10 | Export keyset, import limitado, jobs duráveis, UI de progresso/cancel/recovery | cancel race, poll tardio, import confirmado e export sem fechamento confirmado |
| DB-13 | Tempos por operação, fila, aquisição e execução/fetch combinadas; etapas não medidas explícitas | query-timing sentinela sem conteúdo sensível |
| CTR-01/02/03/04/05/06/07 | Evidence v2, revisões independentes, budgets/owners/signal/deadline, efeitos e omissões explícitos, whitelist de telemetria | testes diferenciais e de contratos nas cinco frentes |

## Medições concluídas

Hardware: Ryzen 9 7950X3D, 32 threads lógicas, ~95 GiB RAM, Windows 10.0.26300, Electron 42.5.0/ABI 146. Rodadas simultâneas podem aumentar latência.

Artefatos sob `.tmp/agent-ide-reliability/`:

- `quality/{manifest,summary}.json` e `quality/metrics.jsonl` *[corrigido]*: 32.000 medições de paths/ranking; nenhum gate do script falhou.
- `discovery-state.json`: 200 estados; nenhuma ativação bloqueada/ausente e receipts coerentes.
- `ide-path-latency-1440x900-dark.json`: 200 amostras por escala; p95 162,7 ms em 10k arquivos e 171,5 ms em 150k.
- `retrieval-1792954616464/`: recall positivo FTS 0,6875, híbrido 0,96875, rerank com guarda PT 0,953125. Conceitual: 0,375 / 0,9375 / 0,90625.
- `database-performance.json`: 200 linhas retornadas/201 observadas de fonte PostgreSQL com milhão de linhas, cursor/bytes limitados e cancelamento sob saturação.
- `upgrade-1792955740496/report.json`: schema 270→273, journal/CAS, restart, leitura por versão anterior e backup restaurado.
- `packaged-runtime/report.json`: code_exec, loop pós-await, SQLite filho, cancel, Unicode e isolamento de owner; verificar conclusão do smoke antes de promoção.

IDE mede renderer+debounce+ponte HTTP Playwright+SQL+dois frames; exclui auth/IPC completos. A nova fixture semântica tem 10 mil arquivos, 20 mil embeddings e 80 consultas distintas repetidas em 400 amostras medidas. São 40 arquivos comportamentais autorais e 9.960 distratores numéricos, todos indexados. Não representa diversidade de 10 mil arquivos reais nem 200 consultas conceituais independentes. As consultas foram inspecionadas durante o diagnóstico: o conjunto rotulado acceptance não é um holdout intocado. Não mede semântica em 150k arquivos. Negativas não inflam recall positivo.

## Validação final em andamento

- Rodada final após correção do cache e cleanup: 11.634 testes Electron passaram, 31 ignorados; 86 testes Node e três testes dos scripts de build passaram (`workspace-tests-routing-final.txt`). Typecheck backend/dashboard passou (`typecheck-routing-final.txt`).
- Após mapa/configuração e catálogo sincronizado: 11.636 testes Electron passaram, 33 ignorados; 86 Node e três scripts passaram (`workspace-tests-context-final.txt`). O incremento de skips inclui integrações opt-in já exercitadas separadamente. Redis posterior tem validação focada e visual descrita abaixo.
- Inicialização em processo filho, preservação de legado, timeout/cleanup e política semântica: 46 testes focados passaram. Typecheck backend e dashboard passou após essa alteração.
- Busca/cancelamento: 59 testes passaram. DB timing/SQLite/batch: sete passaram. UI jobs cobre recovery/cancel race/unknown/poll tardio.
- Boundaries: zero novas violações; 862 históricas e 272 removíveis (`boundaries-final.txt`). Baseline não ampliado. `git diff --check` passou, com avisos de conversão LF/CRLF.
- Typecheck e pacote repetidos após alterações. Candidato: `.tmp/agent-ide-reliability/candidate/win-unpacked/CodeStudio.exe`.
- GLM 5.3: 30 cenários × cinco repetições concluídos, incluindo falhas e interrupções; a versão corrigida tem medição separada nas cinco jornadas integradas.
- O corpus do agente contém cinco jornadas integradas e 25 microtarefas, não homologação de todos os fluxos MCP/DB/UI. Erros e ambiguidades do roteiro permanecem visíveis. Os critérios de correção foram preservados; a revisão V2 corrige falsos negativos gramaticais do verificador, com reavaliação uniforme e resultados originais preservados, conforme auditoria abaixo. Custo estimado não equivale a fatura nem demonstra redução de 20%.

## Matriz e gates

PostgreSQL 17: oito testes reais + benchmark local descartável. MariaDB 10.11.19: seis testes reais. MongoDB 7.0.45 e Redis 7.4.8: sete testes reais, incluindo cursor/célula limitados e isolamento entre bancos lógicos (`integration-mongo-redis.txt`). SQLite/Windows/Electron: contratos e candidato. Linux/Node 24.21.0: evaluator, watchdog pós-await, grupo de processos e controle externo preservado (`posix-runtime/report.json`). SQL Server/Oracle reais, outros providers e SSH/adapters remotos: not_run, sem alegação de homologação. Os testes Redis não homologam consumo de memória de comandos arbitrários ou de coleções enormes.

Gates ainda abertos: meta de custo do agente, generalização de qualidade fora do corpus diagnóstico, jornada visual autenticada no aplicativo instalado e upgrade instalado. As 150 tentativas das 30 jornadas verificáveis terminaram, mas o gate de sucesso do primeiro snapshot falhou. A candidata final melhorou o sucesso nas cinco jornadas integradas pareadas, sem atingir a meta de custo; a comparação não intercalada limita a inferência. O conjunto semântico independente e a integração empacotada real preload/IPC/backend passaram. Engines/adapters não executados permanecem not_run. Nenhuma promoção global é afirmada.

## Reprodução e encerramento

Scripts (ainda não versionados; todos untracked): `scripts/bench-agent-ide-reliability.ts`, `scripts/bench-agent-retrieval.ts`, `scripts/bench-agent-discovery-state.ts`, `scripts/bench-agent-database.ts`, `scripts/bench-agent-reliability-live.ts`, `scripts/verify-agent-reliability-upgrade.ts` e `scripts/release/reliability-smoke.cjs` *[corrigido]*. SQLite exige Electron + ELECTRON_RUN_AS_NODE=1 + --import tsx. test-workspace separa runtimes. O build verifica compatibilidade do addon antes de recompilar.

Antes de encerrar: confirmar limpeza de PIDs próprios, remover chaves copiadas dos perfis descartáveis com secure_delete/checkpoint WAL e parar somente contêineres com label codex.task=agent-ide-reliability. Não parar VM Podman nem processos alheios por nome. O launcher limpa chave no exit normal; interrupção abrupta exige auditoria. Artefatos .tmp não devem ser publicados com credenciais.

## Rodada de correções de 25/10, continuação

- A seleção final do pipeline e o wrapper público reordenavam novamente por score bruto, desfazendo a diversidade entre arquivos. Ambos preservam agora a ordem selecionada; regressão percorre o pipeline público completo.
- As expansões inglesas genéricas da consulta foram removidas. HyDE continua opcional. Conceitos PT/EN recebem expansão lexical limitada a vocabulário de programação; paths e identificadores exatos conservam o caminho literal.
- Em 10k arquivos, diagnóstico sem reranker: recall EN 0,90625 / PT 1,0. BGE local explícito: EN 0,84375 / PT 1,0. O modelo BGE respondeu corretamente a um controle semântico simples, mas piorou esse corpus de código.
- Por esse resultado, reranking local automático para code fica fora da promoção (`code_auto_reranker_not_promoted`). Escolhas explícitas de modelo e outros propósitos semânticos continuam disponíveis. Não houve migração destrutiva de preferências.
- `ide-semantic-latency-1440x900-dark-lexical-v2-no-rerank.json`: 200 medições EN + 200 PT; p95 600,8 / 569,6 ms. Recall do alvo nos dez primeiros, nos casos rotulados acceptance: 0,90625 / 1,0. Houve um pico EN de 18.169,9 ms durante trabalho concorrente, preservado no arquivo. A rodada anterior que falhou também permanece disponível.
- A inicialização real apresentou bloqueio intermitente em worker nativo, reproduzido com renderer aberto. Migrações agora executam em processo próprio, mantendo deduplicação por caminho, recusa de legado, receipt após close e prazo de término. O teste de todo o aplicativo continua necessário; smokes de componentes não o substituem.
- Corrigidas duas janelas de rejeição não observada em cancelamento: promise já criada com signal abortado e iterator.next que aborta de forma síncrona. A falha de timeout do benchmark não foi atribuída exclusivamente a elas.
- Baseline GLM 5.3 concluído: 18/25 corretos, 25/25 guardrails, 17/25 corretos e eficientes, 893.902 tokens de entrada + 9.347 de saída. Relatório `../agent-effectiveness/reports/agent-effectiveness-2026-10-25T20-14-51-843Z.json` relativo à pasta de artefatos.
- Candidato usa snapshot imutável. Shard 3 interrompido após quatro casos; a quinta tentativa permanece falha. O supervisor retoma somente casos restantes, registra hash do runtime/harness, limita cada processo e limpa perfis inclusive após falha. Casos anteriores invalidados por alteração de código durante execução não entram na comparação.

## Cache entre conexões e conjunto independente

O canary completo encontrou `structural_ready`, um arquivo e um símbolo no worker, mas `items: []` e `revision: empty` na IDE. A causa foi cache permanente da decisão central/projeto em `CodeIndexDB.useProjectDb`. O cache agora acompanha `PRAGMA data_version`; commit em outra conexão invalida as decisões antes da próxima leitura. O teste de dois handles em `project-db-integration.test.ts` falhou antes e passou depois, inclusive na transição inversa. Busca, revisão e roteamento: 51 testes passaram.

A suíte ampla intermediária teve 11.631 testes Electron aprovados e uma falha em cleanup de writer; 86 Node e três scripts passaram. O cleanup consultava a segurança do diretório de eventos antes de tratar ENOENT, embora um worker possa sair antes de criá-lo. A ausência agora significa que não existe lease para recuperar; links e owners divergentes continuam rejeitados. A regressão dedicada e o pool passaram em 75 testes; a rodada ampla final passou conforme os números acima.

Novo conjunto independente: `evals/agent-ide-reliability/semantic-holdout.json` e `scripts/bench-agent-semantic-holdout.mjs`. Hash congelado antes da primeira execução, sem ajustes posteriores das consultas. Artefato `semantic-holdout-1792962577747/report.json`, sourceStable=true: 200 consultas distintas × lexical/híbrido = 400 medições. Híbrido: conceitos EN 40/40, PT 40/40, paths 40/40, símbolos 40/40, negativas 40/40. Lexical: EN 40/40, PT 37/40; demais classes 40/40. Usa a mesma distribuição documental sintética de 10k arquivos, portanto não é avaliação em um repositório real inédito.

Os benchmarks GLM registraram falhas adicionais de lease de sessão expirado durante carga concorrente de build/testes. A proteção recusou persistir sem lease válido. Essas falhas não são descartadas e não demonstram por si só qual recurso causou o atraso. O snapshot de runtime do benchmark é anterior às correções finais de cache entre conexões e de cleanup; o relatório deve identificar essa diferença.

## Aplicativo empacotado e reinício

Mesmo executável final em `candidate/win-unpacked`: `packaged-runtime-final/report.json` passou code_exec com RPC, loop infinito pós-await contido, SQLite nativo cancelado/reaberto e spool Unicode isolado por owner. PIDs dos avaliadores encerrados.

`desktop-canary-1792963429535/report.json`: aplicação real, preload e IPC; criação/ativação de projeto, path indexado com revisão publicada, FTS, arquivo novo encontrado pelo grep, SQLite com página truncada e timings, catálogo e disconnect. Saída graciosa, nenhum PID próprio restante. Perfil novo: startup 86.728 ms. A primeira tentativa com prazo de 60 s falhou e permanece em `desktop-canary-1792963260832`; não foi apagada nem contada como sucesso.

`desktop-canary-1792963690125/report.json`: reabertura do mesmo perfil, startup 8.659 ms, projeto e índice anteriores preservados, nova jornada IPC aprovada e saída graciosa. São amostras de cold/warm, não p95 de startup.

A captura `desktop.png` mostra a tela de login do perfil descartável. As operações de produto foram verificadas pela API real do preload; a captura não comprova navegação autenticada no editor ou no grid. Smokes de componentes com contexto controlado permanecem evidência separada. A instalação ativa e a conta cloud do usuário não foram alteradas.

`scripts/summarize-agent-reliability.mjs` combina somente checkpoints nomeados no manifesto, rejeita tentativas duplicadas e inclui interrupções como falhas. Distingue correção do artefato, término esperado e guardrails. A interrupção de `submit_plan` é um resultado controlado do harness original; demais aborts/erros não contam como sucesso. Baseline/candidato não foram intercalados e tiveram cargas concorrentes diferentes; bootstrap é descritivo, sem atribuição causal de latência. Custos incompletos são explicitados.

## Configuração visível no contexto e integridade dos benchmarks

O diagnóstico GLM encontrou uma omissão determinística: o SQL do mapa selecionava funções/classes/tipos, excluindo constantes públicas; o construtor do contexto descartava arquivos sem esses símbolos. Configurações exportadas e caminhos JSON/YAML podiam desaparecer do contexto inicial. O mapa agora inclui constantes/variáveis exportadas e mantém caminhos sem símbolos, dentro dos mesmos limites de arquivos e caracteres. Variáveis privadas continuam fora dessa seleção adicional. A regressão falhou antes e passou depois (`repo-map-configuration-red.txt`, `repo-map-configuration-green.txt`: 28 testes em três arquivos). Typecheck passou (`typecheck-context-final.txt`).

Quando grep não encontra conteúdo, reaproveita o inventário limitado para oferecer até cinco nomes de arquivo correspondentes, explicitamente separados de hits. Esses nomes não afirmam existência de conteúdo nem ausência conclusiva; o truncamento dos hints tem metadados próprios. O catálogo MCP gerado acompanha a descrição atualizada.

Os prompts explore/plan passaram a exigir configuração e consumidores quando relevantes, mantendo os budgets existentes (46 testes em `prompt-coverage-tests.txt`). O experimento somente de prompt (`supervised-1792964668199-10596/report.json`) não melhorou explore: 0/5; plan teve 3/4 resultados corretos e uma falha de setup. Ele não é prova de ganho. A variante seguinte mede contexto/recuperação sobre esse mesmo corpus diagnóstico; não é holdout intocado.

A primeira preparação dessa variante foi rejeitada por divergência entre catálogo gerado e servidor, antes do provider (`supervised-1792965555405-39748`). Cinco falhas de setup e uma interrupção de setup permanecem registradas; nenhum resultado pago é inferido dessa rodada. O supervisor agora valida o catálogo congelado antes de criar perfis ou iniciar jobs. Checkpoints precisam ter data posterior ao lançamento e corresponder a caso/modelo/repetição, impedindo reutilização de resultado por PID reciclado. O launcher grava ownership e registra cleanup antes de criar o banco e copiar a credencial autorizada. O perfil interrompido sem marcador foi auditado: zero credenciais persistidas.

## Resultado do primeiro snapshot: 150 tentativas

`agent-benchmark-summary.json`: fonte congelada estável, 150/150 tentativas registradas, nenhuma pendente. Artefato correto em 137; tarefa corretamente concluída em 131; 121 também passaram guardrails/eficiência. Quatro processos falharam/interromperam e sete resultados tiveram terminal inesperado. A falha de `git add` no setup é distinguível dos erros do agente nos logs. Uso reportado: 6.154.133 tokens de entrada + 43.275 de saída, estimativa US$ 8,8062; 11 tentativas têm custo potencialmente incompleto.

Nas 25 tentativas pareadas das cinco jornadas integradas: baseline 18 concluídas corretamente; primeiro candidato 15. Diferença −12 pontos percentuais; bootstrap pareado descritivo de 95% [−28; +4] pontos, sem inferência causal pelas cargas/ordens distintas. Tokens reportados por tarefa correta: 50.180,5 → 55.825,6; custos incompletos impedem comparação definitiva. O snapshot inicial **não passa** o gate de não regressão nem demonstra a meta de redução de 20%. Correções posteriores e variantes não substituem silenciosamente esses resultados.

`context-v4-summary.json`: variante de mapa/grep com fonte estável, dez tentativas (explore e plan, cinco cada), sete concluídas corretamente e com guardrails/eficiência, contra três no mesmo subconjunto do baseline. Nenhuma falha de processo/terminal; custo estimado reportado US$ 0,36147. É diagnóstico positivo de uma correção concreta, ainda com três respostas incompletas e sem generalização para o conjunto inteiro.

## Redis: prévia limitada e edição parcial

A revisão final encontrou `get` usando HGETALL/SMEMBERS/LRANGE completo. A prévia agora executa um script fixo somente de leitura que limita a resposta RESP a 200 elementos e 64 KiB de valores antes de chegar ao ioredis. Strings usam GETRANGE; coleções têm limite adicional de resposta independente do hint COUNT. Redis pode reter seus próprios buffers ao executar comandos; essa garantia é da prévia no cliente, não um limite de memória/tempo do servidor. Sem permissão de scripting, a prévia falha; não há fallback materializante. O console raw e SCAN continuam sujeitos aos buffers do protocolo, com limitação declarada, sem alegação de streaming. A [documentação de SCAN](https://redis.io/docs/latest/commands/scan/) e de [scripts Lua](https://redis.io/docs/latest/develop/programmability/eval-intro/) fundamenta essa distinção.

O editor bloqueia salvar uma string parcial e as ações de edição de elementos parciais. Leitura que falha também não permite substituir o valor por um draft vazio. Renomear, TTL e excluir a chave continuam operações explícitas independentes. O console informa que o limite de exibição não limita a aquisição de comandos arbitrários.

`redis-preview-tests.txt`: 11 testes passaram, incluindo quatro integrações Redis reais; quatro testes Mongo opt-in ignorados nessa rodada, já executados anteriormente. A fixture verifica string de 160 mil bytes, coleções de 800 elementos, hash com célula grande, todas as formas de valor e preservação da origem. `redis-preview-ui-final.txt`: três cenários Playwright passaram (parcial, falha e valor completo). A primeira preparação visual falhou por inicialização de i18n na fixture e foi corrigida; logs preservados. Typecheck backend/dashboard passou (`typecheck-redis-final.txt`).

## Pacote final e fonte congelada

`build-release-final.txt`: backend e dashboard compilados, catálogo verificado, addon SQLite ABI 146 preservado e pacote Windows gerado. `candidate-build-manifest.json` vincula os hashes do executável/ASAR à fonte congelada `candidate-release-frozen`: 6.050 arquivos, SHA-256 `fcca272cc870fa554967845bc7a5d7d439aab4820e1e47de647ea279d14e0e37`. Sem alteração da instalação ativa.

`packaged-runtime-release-v2/report.json`: mapa com constante pública e JSON sem símbolos, paridade do catálogo com servidor MCP real, hints de caminhos sem falsos hits, code_exec e loop pós-await, SQLite cancelado/reaberto, spool Unicode e ownership passaram. PIDs próprios 47528/47792/19352 encerrados. O primeiro smoke novo usava a asserção incorreta `isError === false`; o contrato permite ausência do campo no sucesso. Corrigida a asserção para recusar `true`, preservando as verificações de conteúdo/estrutura e o log anterior.

Canários do mesmo pacote: `desktop-canary-1792966972233/report.json` abriu perfil novo em 6.261 ms e aprovou os fluxos reais de preload/IPC/backend; `desktop-canary-1792967056393/report.json` reabriu em 2.719 ms, preservou projeto/índice e aprovou nova jornada. Ambos encerraram graciosamente sem PIDs próprios restantes. Essas duas amostras não são p95 nem homologação visual autenticada. A captura permanece na tela de login do perfil descartável.

`profile-cleanup-before-release.json`: 89 perfis de avaliação com marcador de ownership, 171 bancos/backups, zero credenciais remanescentes nesse conjunto antes da rodada final. A auditoria ampliada posterior também inclui perfis antigos sem marcador; portanto esse primeiro resultado não cobria todos os perfis históricos. Servidor Vite próprio encerrado e contêineres descartáveis parados.

## Resultado da candidata final e auditoria do verificador

`supervised-1792967108320-15600/report.json`: 25 tentativas concluídas, cinco repetições de cada jornada integrada, GLM 5.3/Z.ai fixo. Runtime congelado com o mesmo SHA-256 do pacote final. Não houve build/testes concorrentes nessa rodada. O plano prévio registra teto estimado de US$ 5/90 minutos por rodada e US$ 1/oito minutos por tentativa. Não houve falha de processo ou término inesperado; o uso de todas as tentativas foi reportado.

O verificador V1 classificou 20/25 como corretas. A inspeção encontrou dois falsos negativos em explore: as respostas diziam "não utilizada" e "não é consumido", mas a expressão reconhecia apenas algumas flexões. `evals/agent-effectiveness/disconnected-config.mjs` passa a reconhecer essas formas e copulas, com testes positivos e negativos. Os requisitos de identificar a configuração desconectada, citar arquivos e explicar TTL/limite, além de preservar o escopo sem edições, continuam obrigatórios. As outras três respostas explore permanecem incorretas por omissão real.

`scripts/regrade-agent-config-verifier.mjs` aplica a mesma revisão V2 **offline** ao baseline e a todas as variantes, sem chamadas adicionais ao provider. Preserva o resultado V1, hashes do relatório original e do verificador, e lista as tentativas reclassificadas. O baseline e as 150 tentativas do primeiro snapshot não mudaram; a variante v4 passou de 7/10 para 8/10. O verificador continua heurístico e lexical, sem alegação de avaliação semântica completa. Typecheck e três testes de integridade do harness passaram (`typecheck-verifier-final.txt`, `benchmark-harness-tests-final.txt`).

`release-benchmark-summary-v2.json` e `release-benchmark-manifest-v2.json` vinculam a comparação final aos registros originais e às cópias reavaliadas:

| Métrica | Baseline | Candidata final |
|---|---:|---:|
| Tarefas corretamente concluídas | 18/25 | 22/25 |
| Corretas com guardrails | 18/25 | 22/25 |
| Corretas e eficientes | 17/25 | 21/25 |
| Tokens de entrada | 893.902 | 899.020 |
| Tokens de saída | 9.347 | 9.583 |
| Tokens totais | 903.249 | 908.603 |
| Tokens por tarefa correta | 50.180,5 | 41.300,1 |
| Custo total estimado | US$ 1,29259 | US$ 1,30079 |
| Uso/custo potencialmente incompleto | 0 tentativas | 0 tentativas |

Sucesso: +16 pontos percentuais; bootstrap pareado descritivo de 95% [+4; +32] pontos. Explore teve 2/5; plan, invoice, badge e admin tiveram 5/5 cada. Uma tentativa admin excedeu o orçamento de eficiência, preservando correção e guardrails. Tokens por tarefa correta caíram **17,7%** e custo estimado por tarefa correta caiu **17,7%**. Tokens totais aumentaram **0,59%**; não há redução de consumo total. **A meta de 20% continua não atingida.** Não foi reduzida após observar o resultado.

Latência mediana/p95 observada: baseline 51.657/203.007 ms; candidata 28.357/40.361 ms. Baseline e candidata não foram intercalados e tiveram cargas distintas; esses números não demonstram ganho causal de latência. O corpus foi usado durante o diagnóstico, é pequeno e não substitui holdout de jornadas reais inéditas. Os relatórios V1, as tentativas falhas e os resultados anteriores permanecem preservados.

Na rodada de 25/10, G4 ficou pendente de navegação após o login e da validação instalada. Foi solicitado login manual em perfil descartável. Em 26/10, o usuário autorizou pular o login para testar: a navegação local passou com identidade fictícia offline, conforme registro abaixo. Login cloud real e instalação/upgrade continuam sem homologação; a conta cloud e a instalação ativa foram preservadas.

## Encerramento dos recursos de avaliação

A auditoria ampliada `profile-cleanup-final.json` encontrou três cópias de credencial em dois perfis históricos sem marcador (`live-profile` e `matrix-profile`). Os scripts originais e os respectivos budgets comprovam sua origem descartável. Após verificar que estavam inativos, foi recuperado o registro de ownership desses dois perfis e aplicada limpeza com secure_delete, VACUUM e checkpoint WAL nos bancos/backups pertencentes à avaliação. O registro inicial com os achados foi preservado.

`profile-cleanup-final-v2.json`: **116 perfis limpos, 227 bancos/backups auditados, zero credenciais nas tabelas e zero arquivos com bytes residuais da chave Z.ai** nas bases/WAL/journals verificados. Um perfil de setup interrompido sem marcador, que não recebeu credencial, também foi auditado sem ser adotado para escrita. A credencial original foi consultada somente para a comparação em memória; não foi exibida nem alterada.

O inventário final identificou um smoke antigo órfão (PID 24380, pai ausente), com dois filhos próprios. Identidade, criação, árvore e conexões foram verificadas antes de encerrar apenas essa árvore. `process-audit-final-v2.json`: **zero processos e zero contêineres de teste ativos**. O servidor Vite próprio também foi encerrado; a VM Podman e processos alheios foram preservados.

## Interface real com identidade offline — 26/10/2026

O usuário autorizou pular o login para executar os testes locais. `RELIABILITY_OFFLINE_UI=1 node scripts/release/reliability-desktop-canary.mjs` prepara uma identidade fictícia em `chromium/cloud/account.json`, exclusivamente no novo perfil descartável. Usa o cache offline já implementado no aplicativo; não altera o bundle, não injeta respostas de IPC, não copia tokens e não adiciona bypass ao produto. O endpoint cloud do processo de teste aponta para um servidor local que só responde 401.

`offline-ui-final-v2.txt` / `desktop-canary-1793022784775/report.json`: **passou** no executável original empacotado. Foram exercitados por interações de UI: workspace, Explorer, abertura de arquivo no Monaco, busca do arquivo novo, navegação Database, formulário de conexão SQLite, teste e persistência da conexão, abertura do console SQL, digitação/execução de SELECT e duas linhas no grid. Recarregar a página preservou a conexão salva. As APIs reais do preload/IPC/backend também passaram no mesmo processo.

As primeiras tentativas revelaram seletores e pressupostos incorretos do roteiro: tab Code inexistente no layout atual, wizard de preparação inicial, foco retido pelo Monaco, paleta global distinta da busca de arquivos, nome da conexão com sufixo do engine e editor oculto retido no DOM. O harness passou a selecionar controles observados, verificar foco/visibilidade e usar timeouts limitados. As falhas e capturas permanecem preservadas; não foram contabilizadas como sucesso do produto nem mascaradas por stubs de UI.

O aplicativo negou `account.entitlements` com 401 sem token; nenhum request chegou ao servidor cloud local. O logout real restaurou a tela "Continue with Google" e o estado `logged_out`. Não foi criado `refresh.enc`. Isso valida a navegação local e o retorno ao gate; **não valida OAuth, login cloud, assinatura, instalação ou upgrade**. O login manual deixou de ser necessário para os fluxos locais autorizados nesta rodada.

Capturas: `offline-workbench.png`, `offline-editor.png`, `offline-search.png`, `offline-database.png`, `offline-query.png`, `offline-reload.png` e `offline-logout.png` na pasta do relatório. A consulta/grid e o editor foram inspecionados visualmente. Startup observado: 4.719 ms (uma amostra, não p95); zero erros JavaScript, saída graciosa, nenhum PID restante. Os hashes do EXE (`c15ad036…da88`) e ASAR (`e994e7ee…daa2`) continuam iguais ao manifesto da candidata final de 25/10.

`offline-ui-cleanup.json`: sete perfis dessa rodada auditados; zero processos restantes, zero tokens cloud e zero identidades fictícias persistidas. Alterações deste complemento ficam nos scripts de teste e neste relatório; o runtime da candidata e a instalação ativa não foram alterados. A meta de redução de 20% permanece aberta conforme o benchmark GLM anterior.
