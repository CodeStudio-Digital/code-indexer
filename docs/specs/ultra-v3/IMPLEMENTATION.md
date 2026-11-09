# Ultra v3 — implementação e validação

Atualizado em 27/10/2026. Baseline: `448d526dd2e24247617938721c0d8cf18ce850cf`, com alterações locais preexistentes preservadas. HEAD sozinho não identifica a candidata. A especificação normativa continua nos documentos 01–05.

## Código integrado

| Item | Implementação e donos |
|---|---|
| B01 Política | Preserva esforço; requested/effective e motivo de downgrade; paralelismo e limite de inícios com revisão; verificação off/selective. `sessions/ultra-policy.ts`, `index.ts`, provider-sdk e `UltraPolicyStatus.tsx`. |
| B02 Resultado/término | `AgentWorkResult`, critérios/evidências ligados a tools observadas, reparo local limitado; partial/unknown não viram aceitação; revisão opcional cede ao steering. `runtime/work-result.ts`, `advisory-verification.ts`, adapters spawn/collect/resume. |
| B03 Recovery | Snapshot original de provider/modelo/esforço/limites, instance/epoch/lease; resultado antes do ACK; migração legada somente com prova e backup. `implement-subagent.ts`, `chat-resume.ts`, `resume-run.ts`, `chat-checkpoint-migration.ts`. |
| B04 Budget | Ledger raiz com CAS e reservas; concorrência/inícios compartilhados; coordenador, filhos, verificadores e Company; tentativas físicas contabilizadas e custo desconhecido preservado. `collaboration/budget.ts`, `ultra-budget.ts`, `ultra-provider.ts`, `ultra-budget-recovery.ts`. |
| B05 Chats/waits | Índices por destinatário/resposta, ACK seletivo, conclusões imutáveis ordenadas por publicação, cursores ANY/ALL/idle/response, timeout/abort/ciclo, geração de stop. `collaboration/{store,message-index,wait-graph}.ts`, `chat-wait.ts`, `session-network-events.ts`, waits Company. |
| B06 Workflow | Readiness por dependência; aresta explícita para partial; escritores sobrepostos serializados; plano versionado; integração antes de liberar verificadores; resume conserva resultados. `tools/workflow/*`. |
| B07 Tools/contexto | Registry próprio de cada filho, find/expand reconstruídos, recibos comuns de ativação/projeção, contexto limitado. Reutiliza dispatcher/MCP/code_exec/shell da reliability. |
| B08 Propostas/sugestões | Claim idempotente; um chat após crash/duplo clique; contexto fresh/workspace/fork; preparar não executa; sugestão derivada de proposta existente sem chamada extra ao modelo; dispensa persistente. `collaboration/followups.ts`, rotas/tools `ultra-followups.ts`, `PromptSuggestionChip.tsx`. |
| B09 Scheduler | Once/cron de cinco campos, timezone IANA, DST, misfire, skip/coalesce, TTL/limite, pausa/cancelamento; accepted/started separados; ACK perdido consulta run original. `chat-calendar.ts`, `chat-scheduler.ts`, `chat-collaboration-wake.ts`. |
| B10 UX/migração | Painel de política/limites, propostas, agendamentos/ocorrências, rascunho sem envio e navegação para chat preparado, PT/EN; leitura legada e backup antes da migração comprovada. |
| B11 Progressivo | Três templates opt-in, harness com modo/esforço e ledger agregado, caso de integração paralela; corpus versionado de 30 tarefas/10 holdout. `workflow-templates.ts`, `scripts/bench-agent-effectiveness-live.ts`, `evals/ultra-v3`. |

Runtime/tools/sessions acima ficam em `packages/code-agent/src`; collaboration em `packages/session-storage/src`. Não foi criado outro executor, índice, banco de conversas ou serviço cloud.

## Invariantes

- Discovery solicita schemas; o dispatcher normal continua validando autorização. Resultado estruturado não concede autoridade.
- Escritores isolados encerrados deixam `integration.pending` com IDs exatos. O coordenador revisa/integra pelos tools normais e retoma o workflow. O sucessor só começa após o recibo de integração. Esperar integração é resultado de controle, não erro de execução.
- Hashes de conflito representam os bytes originais antes da captura. LF/CRLF do worktree não simula edição concorrente; mudança real da origem continua bloqueada.
- Resultado desconhecido não libera crédito nem autoriza retry. PID não prova ownership. Recovery requer recibo durável compatível.
- O journal segue ordem de publicação e conserva a resposta daquele run, inclusive com relógio regressando e duas conclusões rápidas.
- Aceitar proposta prepara rascunho. Started observa um run já admitido com prompt correspondente; texto editado não é inferido como execução da proposta original.
- Timer preparado por tool começa inativo. A UI permite ativação humana. Stop invalida a geração de eventos antigos.

## Validação executada

| Evidência em `.tmp` | Resultado e alcance |
|---|---|
| `ultra-v3-validation.log` | Bateria ampla inicial: 179 testes, 177 passaram; dois falharam na leitura do formato legado de conclusão. Falha preservada no relatório. |
| `ultra-v3-final-recheck.log` | Após correção: **100 testes / 14 arquivos passaram**, incluindo os dois casos anteriores, cursores, ciclos, workflow e discovery. |
| `ultra-v3-crlf.log` | **5 testes de isolamento passaram**, incluindo LF/CRLF, conflito real e rollback de escrita parcial. |
| `ultra-v3-evidence-check.log` | **39 testes / 4 arquivos passaram** depois da correção de referências de evidência e reconstrução de expand_toolset no registry próprio do filho. |
| `ultra-v3-browser-final.log` | **1 jornada Playwright passou**: esforço/cap, preparar sem enviar, dispensa persistida, criar/pausar rotina. Componentes reais com API de fixture; não é navegação autenticada completa. |
| `ultra-v3-dashboard-build.log` | Build da interface passou; avisos de chunks grandes permanecem. Saída: `.tmp/ultra-v3-dashboard-build`. |
| `ultra-v3-typecheck-final4.log` | Rodada anterior com erros de resolução de dependências. A causa foi esclarecida na preparação da 3.15.2: `fs.realpathSync.native` recebe EPERM no sandbox para junctions do pnpm; TypeScript perde os tipos transitivos. Não eram erros de código preexistentes. |
| `ultra-v3-release-typecheck-host.log`, `ultra-v3-release-ui-types.log` | Ambos os typechecks passaram fora do sandbox, sem alterar tipos, dependências ou relaxar configurações. O config de produção inclui os testes do backend; o segundo comando verifica a interface. |
| `ultra-v3-glm-smoke.log` | GLM 5.3/Z.ai, Ultra/high: correção simples passou em **34.062 ms**, 3 tools, 4 chamadas de modelo, 36.554 tokens agregados, 0 filhos e 0 reservas incertas. Custo efetivo ausente (`null`); fontes estáveis durante o teste. |
| `ultra-v3-glm-workflow.log` | Integração real inicial falhou por LF/CRLF. Também houve erro 500 externo com recuperação. Gerou correção e regressão dedicada; não conta como jornada aprovada. |
| `ultra-v3-glm-workflow-fixed.log` | Após LF/CRLF, os arquivos e testes ficaram corretos, mas as referências de evidência inventadas pelos filhos impediram a aceitação e o verificador dependente. O caso não foi promovido; o host passou a fornecer referências exatas em cada resultado. |
| `ultra-v3-glm-workflow-evidence.log` | **Jornada completa aprovada:** dois implementadores, duas integrações normais, resume do workflow e verificador dependente. 106.338 ms, 7 tools do coordenador, 3 agentes, 17 chamadas de modelo, 123.049 tokens agregados, 0 reservas incertas. Oráculos, guardrails e limite de chamadas passaram; nenhuma tool falhou ou foi executada em duplicidade. |

Relatório do smoke simples: `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-10-27T01-23-49-711Z.json`. As contagens não foram somadas: há sobreposição entre baterias.

Relatório final do workflow: `.tmp/agent-effectiveness/reports/agent-effectiveness-2026-10-27T01-46-39-197Z.json`. Fontes estáveis durante a execução. O caso de desenvolvimento foi esclarecido para preservar role/modifier existentes e exigir resume; versões/prompts anteriores e suas falhas foram preservados. Não foi usado o holdout para ajustar o comportamento. Preço efetivo continua desconhecido, sem converter `null` em zero.

Encerramento conferido: os quatro processos dos smokes e seus filhos não estavam ativos; a porta 7328 do servidor de fixture não estava escutando. Os quatro perfis descartáveis foram verificados com o limpador próprio: oito bancos locais, zero credenciais restantes. Relatórios e fixtures foram conservados. `git diff --check` dos componentes finais não apresentou erros.

## Rastreabilidade Q01–Q26

| Casos | Evidência focal |
|---|---|
| Q01–Q02 | `ultra-v3.test.ts`, `run-coder-execution-mode.test.ts`, provider-sdk reasoning: esforço solicitado/efetivo e cap. |
| Q03–Q04 | `ultra-v3-recovery.test.ts`: embalagem/docs dispensam revisão opcional; steering aborta revisão própria e descarta retorno tardio. Smoke simples não delegou. |
| Q05–Q07 | A→VA sem esperar B lento; partial explícito; schema inválido/fabricado rejeitado; integração pendente bloqueia verificador; adapter paralelo conserva resultado. |
| Q08–Q11 | Resume, subagent-resume-persistence, subagent-fencing, migração/recovery, CAS e saldo após restart. |
| Q12 | Find-tools/score, mcp-server-manager, tool-projection, catálogo próprio dos filhos; discovery não concede permissão. |
| Q13 | Contratos existentes de invocation/dispatcher/MCP preservados. A SPEC não cria uma segunda chamada para observar trabalho existente; testes da reliability continuam sendo sua evidência. |
| Q14–Q18 | Collaboration, chat-collaboration, session-network, chat-wait, wake HTTP, relógio/cursor/epoch. |
| Q19–Q20 | Rotas ultra-followups, jornada browser e observer de início real: claim sobrevive ao crash, dispensa não envia mensagem. |
| Q21–Q25 | Corrupção preserva bytes; scheduler/DST/misfire/ACK; limites e abort; autoridade e wake pelo host normal. |
| Q26 | Ultra-workspace: bytes originais, conflito antes de escrever, rollback; integração pelo dispatcher. |

A matriz aponta evidências de contratos. Não atribui a testes unitários prova de qualidade geral do agente ou de serviços remotos.

## Limitações e promoção

1. **G3 comparativo pendente.** Smokes não provam ganho geral sobre Standard/Ultra anterior nem paridade com Claude. Corpus com 30 tarefas e 10 holdout está congelado; automatizar todas as fixtures/oráculos e comparar três repetições por variante permanece B11 progressivo.
2. **Teto financeiro por provider:** ledger aceita limite de tokens/custo, mas o provider genérico não garante carga máxima por chamada. Nessa combinação o host recusa admissão com `budget_bound_unavailable`; não promete teto financeiro baseado em estimativa. A UI oferece limites operacionais e custo observado.
3. **Scheduler local:** depende do host; não acorda máquina desligada nem é executor cloud/SSH. Aplica misfire ao voltar. Lembretes ficam nas ocorrências do painel.
4. **Compatibilidade/rollback:** conserva intenção de modelo/esforço/limites. Legado sem prova fica legível e bloqueado para execução. Para cessar novas admissões, desligar Ultra/rede e pausar/cancelar rotinas; preservar registros v3 e reconciliar runs ativos antes de voltar um binário. Não apagar journal/budget para liberar saldo.
5. **Compilação:** backend e interface passaram em 27/10/2026. A limitação anterior de tipos foi diagnosticada como restrição de resolução de links pelo sandbox e deixou de bloquear o pacote. Instalação/perfil atual, credenciais do usuário e conexões database foram preservados.

Não rotular “todos os gates aceitos” enquanto essas limitações permanecerem. Código integrado, contrato testado, comparação de qualidade e pacote publicado são estados distintos.

## Entrega Windows 3.15.2 — 27/10/2026

O escopo funcional obrigatório B01–B10 foi empacotado com as evidências Q01–Q26 acima. B11 permanece otimização progressiva, conforme o critério de entrega do documento 05; não há afirmação de ganho comparativo geral ou paridade com Claude. Nesta rodada não houve alteração do runtime: foram atualizados a versão, o diagnóstico da compilação e a verificação da distribuição. As jornadas e regressões já aprovadas não foram repetidas sem mudança de código.

- Instalador: `D:\MCP\dist\releases\ultra-v3-3.15.2\CodeStudio Setup 3.15.2.exe`, Windows x64, **340.954.405 bytes**.
- SHA-256: `debbaf9618c58fce6f8dd31072b61d4c9e29ab70e5faece2d6168940c50f77ed`.
- Compilação completa e ambos os typechecks aprovados, sem relaxar regras ou rebuildar o addon SQLite compatível.
- `package-verification.json`: **7 verificações aprovadas**; 2.441 módulos e 42 pacotes resolvidos, renderer/deep link, parser WASM, execução QuickJS, conversão HTML e imagem/vídeo.
- `validation/ultra-v3-smoke.json`: **7 verificações aprovadas nos módulos do app.asar**, executados pelo CodeStudio.exe candidato. Esforço/cap, disputa de budget e restart, wait/journal/stop, proposta/claim idempotente, timer sem autorização inativo, rejeição de sucesso sem evidência e `code_exec` sem duplicar mutação de resultado incerto. Usa somente perfil descartável, sem provider.
- `validation/installer-payload.json`: `app.asar` e `CodeStudio.exe` extraídos do instalador têm os mesmos hashes do pacote validado. SHA-512 e tamanho conferem com `latest.yml`. O aviso do 7-Zip sobre bytes após o arquivo corresponde à cauda do contêiner NSIS; a extração concluiu com exit 0 e hashes idênticos.
- Build: `.tmp/ultra-v3-installer-3.15.2.log`. Smoke reproduzível: `scripts/release/ultra-v3-smoke.cjs`.

G4 local concluído para esta entrega. Instalador sem assinatura Authenticode; não foi publicado nem instalado sobre o aplicativo atual. Processos próprios de build/validação encerrados. Os relatórios de pacote ficam na mesma pasta do instalador; nenhum perfil ou conexão do usuário foi alterado.

## Correção de `code_exec` — 3.15.3

O uso real revelou uma lacuna da validação da 3.15.2: um `Promise.all` com três consultas de shell falhou quando o diagnóstico REA retornou exit code 1. O executor já conhecia esse resultado, mas cancelou uma consulta irmã que havia começado; a corrida de cancelamento marcou o lote `effect_outcome: unknown`. A marca persistiu no histórico e o guard de retomada bloqueou as mensagens seguintes. A origem foi confirmada no registro da chamada, não inferida apenas do print.

`code-exec.ts` agora fecha a admissão das consultas na fila antes de encerrar o avaliador. Chamadas já iniciadas conservam seus prazos originais, dentro do limite do lote; a falha de uma irmã não reduz esse prazo ao drain de cinco segundos. Cancelamento humano, deadlines e efeitos realmente incertos continuam interrompendo e bloqueando repetição.

- `.tmp/code-exec-unknown-regression-before.log`: a regressão reproduziu o erro (`unknown` no lugar de uma falha conhecida).
- `.tmp/code-exec-unknown-regression-final.log`: **14 testes / 2 arquivos passaram**, incluindo consulta irmã acima de cinco segundos, concorrência, timeout e cancelamento incerto.
- `.tmp/code-exec-unknown-integration.log`: **63 testes / 2 arquivos passaram** para composição e proteção da retomada. Essa rodada foi anterior ao ajuste final que preservou o prazo completo; os 14 testes acima foram executados depois dele.
- `scripts/release/ultra-v3-smoke.cjs` passou a verificar também a regressão dentro do pacote, mantendo o caso de efeito realmente incerto sem execução duplicada.

A correção de código previne a recorrência, mas não apaga marcas de incerteza antigas automaticamente. A reconciliação de um caso antigo exige conferir a operação e preservar um registro da decisão; uma atualização de versão não equivale a essa evidência. Para o incidente observado foi preparada uma reparação específica, com hash do script e do resultado, backup, journal append-only e zero comandos repetidos. Ela recusa sessões ativas ou uma trava de escrita existente.

Entrega final: `D:\MCP\dist\releases\ultra-v3-3.15.3-final\CodeStudio Setup 3.15.3.exe` (**340.954.640 bytes**; SHA-256 `ca62546f9b49293efdcc140232320d367d5ce8aabe3181bf163ed8fe314e36f3`). Build e types de produção aprovados; a interface sem mudanças reutiliza o build aprovado anterior. Os oito checks do smoke Ultra passaram no pacote final, inclusive a consulta irmã acima de cinco segundos. Closure de 2.441 módulos/42 pacotes aprovada. Executável e ASAR extraídos têm os mesmos hashes da candidata testada; tamanho e SHA-512 conferem com `latest.yml`. Não assinado, não publicado e não instalado automaticamente.

Após o usuário fechar o CodeStudio, a reparação específica foi aplicada à sessão `95ec3e6f-ebd3-4950-8796-63f55a641b19`, chamada `call_df42cd53cb9446fdb57045025cf69ee0`. Backup no próprio bundle; todos os bytes anteriores do journal foram preservados. A falha original permanece registrada, com nota de reconciliação, e nenhum comando foi repetido. A leitura hidratada pelo codec e o guard real de bootstrap confirmaram ausência de bloqueio incerto remanescente. Relatório local: `.tmp/dysmantle-outcome-review.json`.

## Recuperação de transporte — 3.15.4

Corrigida a classificação de `TypeError: terminated` e a contagem que acumulava timeouts antigos já recuperados até encerrar uma chamada posterior. A recuperação distingue a sequência sem resposta válida do total da execução, conserva os limites existentes, respeita cancelamento e preserva o bloqueio de ferramentas com efeito incerto. A resposta ChatGPT termina em `response.completed`, sem aguardar o fechamento do socket. Causas de transporte conhecidas passam a aparecer na telemetria sem dados sensíveis.

Entrega: `D:\MCP\dist\releases\provider-recovery-3.15.4\CodeStudio Setup 3.15.4.exe`, **340.953.894 bytes**, SHA-256 `c8e7bcba06902a282e75d3d6ae09f298d434b76e9213aa7ada38a18936f03275`. **141 testes e três verificações no pacote aprovados**, incluindo desconexão HTTP real com SDK/fetch nativos. Build de produção e interface aprovados; conteúdo extraído do instalador idêntico ao validado, closure e metadados de atualização conferidos. Sem instalação automática ou alteração do perfil. Evidência, causa e limitações em [PROVIDER-RECOVERY-3.15.4.md](../../agent-research/PROVIDER-RECOVERY-3.15.4.md). Esta correção não encerra os gates comparativos progressivos B11.
