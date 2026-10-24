# Harness: implementação e evidências de desempenho

Data: 2026-10-03. Base Git: `2d24020c28785bf181c178c72b9eaea8c1bfcdea`,
checkout com alterações locais preexistentes. Os resultados abaixo pertencem
ao candidato local; não certificam o aplicativo instalado ou um canário.

## Alterações implementadas

- Recovery Rust: `ListCommittedSessionRecords.snapshot_id` e
  `CommittedSessionRecordPage.snapshot_id` usam a tag 5. A primeira solicitação
  valida toda a cadeia e retém uma fotografia dos receipts; as páginas seguintes
  usam o identificador, mantendo verificação de lease/autoridade e da origem.
  O host de recovery passa o identificador por toda a paginação e rejeita troca
  ou ausência do identificador. Os contratos TS/Rust foram regenerados do proto.
  Host e bridge devem ser distribuídos juntos: uma bridge antiga sem esse
  identificador é rejeitada durante recovery.
- Cada writer Rust retém uma fotografia, limitada a 100.000 receipts e 32 MiB
  de alocação contabilizada. Payloads continuam exigindo leitura por hash exato.
  Commit invalida a fotografia; reabertura cria outra identidade; alteração
  inesperada do journal falha fechada. A API local antiga continua validando
  novamente em cada chamada. Limites excedidos falham fechados.
- O writer TS mantém projeções incrementais de conversa e objetivos após o
  commit. Replay por operation ID e procura por sequência usam índices.
  Reabertura reconstrói os índices; recuperação após falha os invalida. Mudança
  externa do journal invalida o writer. O cache permite até quatro projeções,
  com até 100.000 commits e 32 MiB de journal; acima disso usa reconstrução.
- Totais de métricas também avançam incrementalmente para novos registros.
  Substituição, rollback, importação fora de ordem e publicação em lote
  invalidam ou reconstroem o resumo. O cache acompanha o writer, sem persistir
  uma segunda autoridade. Falha de publicação descarta o cache.
- O dispatcher atual publica cada resultado após redução e contabilização.
  A mensagem enviada ao modelo continua na ordem original. Falha do observador
  de apresentação não repete uma ferramenta já executada.
- Memória proativa e capítulos relevantes compartilham orçamento de 300 ms.
  Há no máximo uma preparação pendente por run. Resultado tardio só é aplicado
  numa fronteira posterior com a mesma tarefa; tarefas substituídas descartam
  o resultado. Abort encerra a espera. Ferramentas explícitas de memória não
  passam por esse orçamento. O índice de capítulos reutiliza `total_count`,
  com fallback para implementações antigas que não o retornam.
- A transcrição não aguarda mais a Promise da telemetria diagnóstica.
  Conclusões tardias não podem associar o ID de uma métrica ao turno seguinte.
  Os arquivos de diagnóstico ainda obedecem ao writer da sessão; essa alteração
  remove a dependência explícita, não cria um segundo writer.
- O renderer processa até 50 eventos ou 6 ms por lote e usa cursor na fila.
  Blocos da resposta ativa agora são linhas do virtualizador. O processamento
  de deltas consulta um índice de prompts pendentes e presença de atividades,
  evitando varrer todos os cartões antigos em cada token.

## Reprodução local

```powershell
node --import tsx scripts/harness-performance.mjs scratch/harness-performance.json
cargo test --manifest-path native/agent-runtime/Cargo.toml -p agent-session-store --test session_journal recovery_snapshot_pages_scale_to_ten_thousand_records -- --nocapture
```

As fixtures são sintéticas e descartáveis. Nenhum provider é chamado.
O script registra versão do Node, plataforma, horário e HEAD; o checkout pode
conter alterações não commitadas e esse HEAD sozinho não identifica o binário.

Medição Windows x64, Node 22.20.0, 2026-10-03:

| Histórico | Abertura + projeção fria | Commit + leitura aquecidos p95, 20 amostras | Registros aplicados |
|---:|---:|---:|---:|
| 100 | 14,916 ms | 5,001 ms | 120 |
| 1.000 | 19,301 ms | 5,467 ms | 1.020 |
| 10.000 | 112,241 ms | 5,371 ms | 10.020 |

Essa medida cobre `SessionWriter` e sua projeção, não todo o custo de
`persistAssistantTurn`, rede, provider ou transporte da UI.

Lote legado de ferramentas simuladas de 20/200 ms: primeiro resultado visível
em 24,381 ms; lote completo em 240,012 ms. Concorrência permanece **1**.
10.000 deltas sobre 50/1.000/5.000 cartões anteriores consumiram
2,610/1,626/1,451 ms no handler. Essa medida não inclui DOM ou React.

Recovery Rust em build de debug, mesma fixture e paginação de 256 receipts:

| Receipts | Validar a cadeia em cada página | Validar uma vez |
|---:|---:|---:|
| 100 | 2,094 ms | 1,970 ms |
| 1.000 | 67,367 ms | 17,186 ms |
| 10.000 | 7.472,478 ms | 188,483 ms |

São amostras locais de um algoritmo, não p95 de produção nem percentual de
aceleração total do agente. O teste verifica conteúdo, ordem e identidade da
fotografia, sem assertions de tempo dependentes da máquina.

## Renderer e integração física

`node scripts/harness-renderer-performance.mjs scratch/harness-renderer-performance.json`
compila uma fixture isolada do `MessageList` e a executa em Chromium. A fixture
não inicializa o backend e bloqueia requisições para outras origens.

Em Chromium 149.0.7827.55, viewport de 1280 × 720, os 5.000 blocos do turno
ativo mantiveram 17 linhas montadas no início e 18 no fim. Rolagem nas duas
direções e digitação passaram durante 120 atualizações: intervalo entre frames
p95 de 17,7 ms (máximo 18,6 ms), 12 interações com p95 de 10,3 ms, sem exceções
do renderer. A latência de interação inclui o round trip do Playwright.
Essa fixture não mede a inicialização do Electron ou o aplicativo instalado.

Também foi produzido o pacote nativo Windows x64 em release:
`runtime-v1-38ce02dea699c5029ca73f6914ac74b77464324acac9afa58d6f81ac9e316d10`.
O smoke de carregamento do addon no Electron passou. O smoke do pacote em
diretório somente leitura também passou, incluindo launch/kill de runner e
supervisor. Cinco testes com processos
reais passaram: negociação do supervisor, ativação e reap, `native.read_file`
com continuação do provider de teste e recovery do journal, rejeição de hydration
divergente e fencing no canal Control. O teste opcional do adapter OSS não foi
executado; não houve chamada a provider real.

`GATE-PERF-01` passou com 10 warmups e 100 amostras: startup do runner Rust em
release p50 de 14,718 ms, p95 de 16,042 ms e máximo de 82,009 ms, contra a meta
de 250 ms. Esse gate não mede startup do aplicativo completo nem certifica
dispatch, ACK de cancelamento, soak ou canário.

## Validação do candidato

- 399 testes TypeScript em 62 arquivos passaram; depois da revisão da perda de
  ACK nas métricas, os 41 testes de session storage passaram, incluindo o novo
  caso. Total de casos distintos cobertos: 400.
- 619 testes Rust passaram; 14 permaneceram ignorados na suíte configurada.
- Typecheck global, build do dashboard, `cargo check --workspace --all-targets`,
  clippy dos crates alterados, limites de LOC e dependências dos crates passaram.
- Cinco testes físicos adicionais e smoke do addon no Electron passaram com o
  pacote nativo acima. Fixtures de provider são determinísticas e locais.

Relatórios locais: `scratch/harness-20261003/` contém as medições, logs de build
e testes. Os scripts e este documento ficam versionados; os relatórios scratch
seguem ignorados pelo repositório.

## Continuação da implementação (2026-10-03)

O scheduler Rust agora recebe todos os tool calls do provider e executa janelas
com até quatro NativeRead explicitamente readOnly/parallelSafe. Mutação,
comando, interação e HostCapability são barreiras. O limite efetivo também
respeita maxConcurrentTools e maxBlockingTasks. O canal Host atual tem apenas
uma operação pendente; a concorrência não foi habilitada artificialmente nele.

Cada membro confirma started antes do efeito e terminal após o efeito. O sink
publica o resultado individualmente; a composição do contexto preserva a ordem
original. Um token de lote é emitido uma única vez, vinculado ao engine e às
chamadas exatas. Reservas atômicas impedem repetir membros, e o próximo turno
exige todos os commits. Falhas drenam os membros já iniciados sem reenviá-los.
Unknown e cancelamento interrompem a continuação automática.

O recovery mantém OUTCOME_UNKNOWN como pendência mesmo quando há terminal
persistido. Uma segunda resposta terminal não substitui essa incerteza sem
reconciliação explícita. Há testes para perda de ACK, classificação inválida,
chamada duplicada e término prematuro do lote.

ProviderResumeContextV1 e seu decoder Rust validam hash, bytes canônicos,
sessão/run/attempt, pareamento de tool calls/results e ausência de operações
não resolvidas. Mudança do binding descarta o cursor do provider.
A fronteira agora é publicada pelo writer nativo antes de abrir cada chamada
ao provider, em registros CHECKPOINT separados dos eventos diagnósticos.
O writer salva deltas de mensagens e um checkpoint completo a cada 32 chamadas,
ou quando a compactação altera o prefixo. A configuração do contexto continua
incluída em cada registro. Hashes autenticam a base e a reconstrução.

A recuperação percorre uma fotografia validada do journal. Uma ferramenta
executada após a última fronteira impede retomada automática mesmo quando
o resultado é conhecido: omitir esse resultado poderia repetir uma mutação.
OUTCOME_UNKNOWN continua bloqueando a retomada mesmo se houver checkpoint
posterior. Falta de espaço, ACK perdido e cancelamento antes do commit impedem
a abertura do provider. O estado do writer falha fechado após commit ambíguo.

O teste físico encerra todos os owners da primeira attempt, reabre o journal,
hidrata outro runner com nova identidade/fence e confirma que o resultado da
ferramenta foi recuperado sem nova execução. Isso cobre a composição nativa;
a rota de retomada do produto ainda precisa consumir essa composição.

O adapter legado passou a ter controle de ownership, replay de launch e
cancelamento concorrente. Launch ambíguo retém a identidade e não cria outro
executor. Esse adapter ainda precisa ser composto com o control plane real.
NativeRustAgentRuntimeAdapter também implementa o contrato da fachada, valida
identidade/digest/build e possui a attempt física. A conclusão só é observada
após commit durável e ACK de dados; o lease solicita cleanup, espera o reap e
fecha o supervisor. Cancelar retorna no ACK de controle, enquanto closed espera
a liberação física. Os módulos físicos são importados apenas ao selecionar uma
attempt nativa. O teste com processos reais confirma launch único e reap
após conclusão normal. O gate test/shadow continua obrigatório.

O índice de capítulos guarda somente títulos/fontes/ordinais e reutiliza
listagem e total_count pela revisão dos arquivos. Metadados de identidade e
timestamps invalidam alterações externas, substituições e exclusões. O cache
é limitado a 32 sessões. Há teste de leitura aquecida sem relistar, edição
externa e reabertura; calcular a revisão ainda percorre os metadados.

Cinco varreduras de jobs semânticos foram transferidas para o worker existente,
em páginas SQL de 256 registros e com limite superior de ID. Esse limite
impede uma varredura infinita por novas inserções, mas não equivale a uma
fotografia imutável de atualizações concorrentes. A remoção de projeto mantém
a publicação da barreira de mutações antes de qualquer await. Outras consultas
síncronas curtas continuam no coordenador.

A validação do desktop encontrou e corrigiu duas falhas de primeiro boot:

- O manifesto distribuível não declarava @babel/parser, magic-string e
  isolated-vm, embora services dependesse deles. Agora declara as versões já
  presentes no lockfile; o build verifica dependências externas dos workspaces.
- O seed dos plugins abria o SQLite antes do schema, criando um cabeçalho que
  impedia o bootstrap de um perfil novo. A inicialização agora termina num
  worker dedicado antes do seed. O teste confirma que um banco legado continua
  rejeitado e byte a byte inalterado. Não houve migração de dados do usuário.

## Evidências da continuação

- Rust: 628 testes passaram na suíte completa, 14 ignorados.
  Clippy de todo o workspace, todos os targets/features, passou com -D warnings.
- Contratos/host: 461 testes passaram, 21 ignorados na execução sem opt-ins
  físicos. Inclui fronteiras incrementais, recovery, disco cheio/ACK perdido,
  cancelamento antes do provider e lifecycle do lease nativo.
- SQLite/semântica: 104 testes passaram pelo Electron. Capítulos/contrato:
  22 testes passaram. Bootstrap do banco/plugins: cinco testes passaram.
- Typecheck global, build de produção, limites de 250 LOC (804 módulos) e
  grafo de 11 crates/14 arestas passaram.
- A regra de referências ao legado continua falhando no checkout: 457 entradas
  novas e 70 removidas frente à baseline. O relatório está em
  scratch/harness-20261003/legacy-boundary.txt. Não foi regenerada uma baseline
  apenas para esconder esse gate.
- Nove testes físicos passaram, incluindo lotes de uma e quatro leituras,
  continuação do provider determinístico, journal, fencing, retomada em outro
  runner, mutação Host real com resposta perdida e reap automático pelo adapter.
  A mutação permaneceu incerta após reabertura e bloqueou a retomada.
  OSS opcional permaneceu ignorado.
- No candidato runtime-v1-73ef105bd29dbf5b03f936ba2f93512446a92a07c1158a6919b94b89ba72b43e,
  cancelamento: cinco warmups e 50 amostras, p95 1,382 ms, máximo 1,468 ms;
  zero processos órfãos nos 55 ciclos. A carga era idle, sem provider concorrente.
  No benchmark release do checkout atual com performance-harness, startup
  aquecido passou: p95 94,897 ms, p99 260,091 ms e máximo 501,145 ms em 100
  amostras após dez warmups. O gate é p95 <=250 ms; a cauda ainda oscila.
  Esses números identificam as condições medidas, não certificam versões futuras.
- O executável empacotado abriu com dados e perfil temporários: interface em
  6715,992 ms, 120 frames com p95 7,0 ms e máximo 7,1 ms, sem exceções.
  O trace possui 41125 eventos. É um primeiro boot vazio, não uma reprodução
  do frame de 8.759 ms do perfil original. A variação entre boots não permite
  afirmar uma redução do tempo total de startup. O benchmark isolado do transcript
  acima cobre streaming/replay de 5.000 blocos separadamente.
- Smoke do pacote Windows verificou ASAR/fuses, addon e launch/kill em diretório
  somente leitura. Usou política de desenvolvimento unsigned; a verificação do
  antivírus não ficou disponível. Isso não é certificação de release assinado.
- O módulo opcional isolated-vm 7.0.0 está declarado e empacotado, mas não possui
  binário para Electron ABI 146 neste checkout. O executor de scripts do cliente
  de APIs informa indisponibilidade; esse recurso não foi certificado. Não houve
  reconstrução global das dependências nem substituição por um sandbox inseguro.

Reprodução adicional:

```powershell
node scripts/harness-electron-startup.mjs scratch/startup dist/electron-builder/win-unpacked/CodeStudio.exe
$env:MCP_RUST_AGENT_PERF_E2E='1'
node node_modules/vitest/vitest.mjs run packages/agent-runtime-host/src/__tests__/native-process-real-performance.windows.test.ts --maxWorkers=1
```

## Integração e certificação ainda abertas

A migração integral **não está concluída**. A ativação do worker HTTP/SSE agora
passa pela AgentRuntimeFacade e pelo adapter legado, com rota durável por attempt.
Cancelamento e aprovações identificadas usam os mesmos handles. MCP/CLI e a
seleção nativa no produto continuam pendentes. Não houve promoção de runtime
nem troca do modelo/provider escolhido.

| Parte do plano | Estado verificável |
|---|---|
| Fachada e adapter legado | Fachada composta na ativação HTTP/SSE, com start/resume, cancelamento e aprovações identificadas; seleção nativa, MCP/CLI e convergência completa dos transportes pendentes |
| Fluxo completo Windows | Leitura nativa e retomada em processos reais com provider determinístico testadas; paridade produtiva de edição/comandos/Git/imagens/MCP/plugins pendente |
| Scheduler Rust | Lotes, quatro leituras nativas, barreiras e ordem implementados; gateway Host continua sequencial |
| Persistência | Projeções incrementais, recovery por fotografia e fronteira durável com deltas implementados; ligação à retomada do produto pendente |
| Preparação | Orçamento de memória, cache de capítulos e telemetria fora da espera implementados; seleção por embeddings não tem chamada no caminho produtivo inspecionado |
| Host/interface | Varreduras semânticas e bootstrap do banco em workers, virtualização e orçamento de eventos implementados; isolamento de todo o backend ainda não concluído |
| Rollout | Boot empacotado e smokes locais executados; dispatch nativo p95, carga/soak, crash/reconnect, qualidade/custo equivalente, shadow e canário ainda abertos |

Company/subagentes continuam na árvore legada. O Host supervisor permanece
explicitamente restrito a test/shadow: multi-launch, crash recovery e durable
rehydration ainda estão marcados como ausentes no gate existente. Esse gate
não foi removido nem declarado aprovado.

## Continuação: preparação no caminho do produto

As rotas de nova mensagem e continuação agora criam a autoridade da execução
independentemente das flags de shadow. Mensagens encaminhadas a um worker ainda
ativo conservam a mesma attempt. Antes do primeiro turno do runner, o worker
envia a configuração resolvida: provider/modelo, esforço, identificação do agente,
hash do prompt, catálogo de capabilities, ambiente e permissões iniciais.
Credenciais, valores de ambiente e texto da conversa não integram esse registro.

O host confirma o owner e o fencing epoch que ele próprio atribuiu, grava uma
preparação imutável, atualiza a resolução do AgentRun e confirma a ativação antes
de liberar o worker. A preparação tem journal próprio, separado dos checkpoints
de política escritos pelo worker. Conteúdo diferente não pode substituir a
configuração de uma attempt já preparada. Uma gravação com ACK perdido permite
reparar a projeção com os mesmos dados, sem autorizar uma chamada ao provider.
Cancelamento durante essa espera não depende do retorno do disco ou do host.

A ativação antecipada revelou uma corrida com o vínculo do SSE. O primeiro
vínculo de bus agora pode ocorrer tanto em `accepted` como em `running`; um bus
ou runner já vinculado não pode ser substituído por outro. Os resultados de
admission de um worker substituído são rejeitados antes de liberar execução.

Validação desta continuação:

- 74 testes passaram em oito arquivos, incluindo falha de disco, ACK perdido,
  mudança de configuração, fencing, cancelamento durante a espera, vínculo SSE,
  worker pool e idempotência de mensagens/continuação. Typecheck e build de
  produção passaram.
- `scripts/harness-electron-admission.mjs` executou o pacote Windows com perfil,
  banco e projeto temporários, usando um provider determinístico em loopback.
  O teste observou o arquivo de preparação e o AgentRun `running` antes de
  cada chamada da conversa, executou `read_file` de verdade e recebeu o conteúdo
  no turno seguinte do provider e a resposta final pelo SSE.
- Foram duas chamadas da conversa, 161 capabilities, registro de preparação de
  285.275 bytes e nenhum erro do renderer. O caminho POST → resposta final levou
  2.127,454 ms nessa amostra; não é ganho percentual nem benchmark de provider real.
  Houve também uma chamada auxiliar de preflight, separada das duas chamadas da
  conversa. A primeira execução do teste confundia essa chamada auxiliar com a
  execução principal; o harness de validação foi corrigido para distingui-las.
- Evidências: `scratch/harness-20261003/admission-all-tests.txt`,
  `admission-typecheck.txt`, `admission-production-build.txt`,
  `admission-electron-package.txt` e `admission-packaged-e2e/report.json`.

O avanço descrito nesta etapa fechou a confirmação da configuração real e da ativação no caminho
atual HTTP/SSE. O recibo registra explicitamente `legacy_ts`; não produz uma
ResolvedAttemptSpec nativa fictícia nem declara paridade Rust. A fachada pública,
o provisionamento nativo do produto, MCP/CLI e os gates da tabela anterior ainda
precisam ser concluídos. A confirmação cobre a configuração inicial; mudanças
legadas de configurações ao vivo conservam seu comportamento existente.

## Continuação de 2026-10-05: fachada no produto e cancelamento de stream

`CoderWorkerPool` agora compõe `AgentRuntimeFacade`, `RuntimeRouter` e
`LegacyAgentRuntimeAdapter` na ativação de cada execução preparada. O worker
existente espera o recibo; o adapter não cria outro executor. A rota imutável em
`events/runtime-routes/<attemptId>.json` é confirmada antes de `markRunStarted`
e da liberação do provider. Uma continuação recebe outra identidade de execução;
a escolha de runtime da attempt anterior não muda. RPCs simultâneos de admission
compartilham a mesma ativação, e dados diferentes ou requests obsoletos são
rejeitados antes de poderem substituir essa execução.

O contrato distingue `PreparedLegacyAgentAttempt` de `PreparedAgentAttempt`.
O primeiro referencia a preparação admitida e seus hashes; o segundo continua
exigindo a ResolvedAttemptSpec nativa, snapshots e orçamento de recursos.
O adapter Rust rejeita explicitamente a preparação legada antes de provisionar
processos. A seleção produtiva desta etapa permanece `legacy_required`. O hash
de runtime registrado pelo legado identifica o arquivo de entrada do worker,
não constitui uma certificação de todos os módulos do aplicativo nem do Rust.

Cancelamento e respostas de interação identificadas, incluindo aprovação de
ferramentas, passam pelo handle da fachada. Pedidos de controle têm registros
imutáveis próprios; os registros de resposta guardam hash e identidade, sem
copiar o texto da resposta. Um cancelamento confirmado impede admission ou
ativação tardia, inclusive depois de reabrir a autoridade. Respostas concorrentes
iguais compartilham o resultado do RPC; conteúdo diferente é rejeitado e uma
entrega incerta não é repetida automaticamente. A rota HTTP de aprovação retorna
503 quando perde a confirmação do worker, sem fabricar uma mensagem dizendo que
a ferramenta não executou. Isso evita convidar o modelo a repetir uma mutação
que pode já ter sido liberada.

O handle também fornece snapshot e assinatura do bus legado. Esses eventos
declaram explicitamente sua origem volátil, identidade do stream e sequência
local ao stream. O consumidor reutiliza o buffer existente, com acesso por índice,
sem manter uma fila crescente por assinante. Cursor de outro stream ou trecho
evicto exige atualização do transcript/snapshot. Fechar um iterador remove os
listeners mesmo enquanto ele espera novos eventos. O transporte HTTP/SSE
existente permanece compatível; a convergência de todos os transports e das
interações sem identificador ainda não está concluída.

### Travamento reproduzido e corrigido

O cenário empacotado com provider que deixa o SSE aberto reproduziu uma falha
concreta: `/abort` respondeu em 81,9 ms, mas a leitura permaneceu pendente até o
timeout de 60 segundos do cliente. O adapter OpenAI compatível não transmitia o
AbortSignal ao SDK, e o consumidor esperava `AsyncGenerator.return()` atrás do
`next()` bloqueado. O mesmo encaminhamento de sinal faltava no adapter Kimi Code.

Agora ambos passam o sinal ao SDK. Cada chamada do provider possui um controller
próprio, ligado ao cancelamento da sessão e encerrado ao sair da chamada. Timeout
também cancela esse transporte antes de recovery. O consumidor solicita cleanup,
observa rejeições tardias e não aguarda indefinidamente um iterador que ignora a
interrupção; erros do SDK após cancelamento são classificados como abort, sem
retry de provider. Testes em HTTP real de loopback cobrem cancelamento antes e
depois do primeiro trecho, além de iteradores cujo `next()` e `return()` nunca
resolvem.

### Validação desta etapa

- 358 testes passaram em 37 arquivos: providers, execução, fachada/adapters,
  roteamento, authority em filesystem, worker pool, aprovação, idempotência e
  replay. Os testes antigos que dependiam das flags de replay já retiradas foram
  atualizados para exercitar o limite fixo vigente, incluindo overflow real.
- Typecheck, compilação de produção, `tsc-alias`, empacotamento Windows e o gate
  de 250 linhas dos 806 módulos de produção Rust/host/contracts passaram.
- O pacote executou conversa, leitura real, pausa após ferramenta, continuação
  com nova attempt e cancelamento de provider ativo. Antes de cada chamada da
  conversa, a fixture conferiu preparação, resolução e rota no disco.
- Na reprodução após a correção, o ACK de cancelamento levou 26,9 ms e o término
  do runner/SSE 30,9 ms. A conexão do provider fechou; os quatro processos Electron
  rastreados não sobreviveram ao fechamento. Esses tempos são uma amostra local,
  não p95 nem evidência de ganho percentual global. O diálogo de leitura levou
  2.000,4 ms com provider determinístico em loopback.
- Evidências: `scratch/harness-20261003/facade-product-all-tests.txt`,
  `facade-product-typecheck.txt`, `facade-product-build.txt`,
  `facade-product-package-final.txt`, `facade-product-loc.txt` e
  `facade-product-packaged-e2e-final/report.json`. A reprodução anterior à
  correção está em `facade-product-packaged-e2e-v2/report.json`.
- Uma segunda execução ampliou o cenário para aprovação HTTP de `write_file`:
  o arquivo não existia antes da autorização, a escrita real concluiu e o recibo
  da interação ficou no disco. Leitura, continuação e cancelamento passaram
  juntos, com oito requests principais, quatro preflights, nenhum erro do
  renderer e nenhum dos quatro processos Electron rastreados remanescente.
  Cancelamento: ACK 32,0 ms; runner/SSE encerrados em 36,6 ms, com transporte do
  provider fechado. Evidência: `facade-product-packaged-full-e2e/report.json`.

O teste empacotado usa perfis/projetos temporários e credenciais fictícias de
loopback. Não certifica providers externos, qualidade de modelos reais, o
congelamento de inicialização de 8,76 segundos, nem paridade produtiva Rust.
Permanecem os gates nativos, de superfícies e rollout listados acima; a fachada
integrada ao legado é uma etapa concreta dessa migração, não sua conclusão.

### Persistência dos fatos físicos do supervisor

`FileControlPlaneStore.createSupervisorFactPort` implementa o port durável usado
pelo coordenador nativo. Cada fase física é um registro imutável separado em
`events/supervisor-facts`, gravado pela fila de mutações da sessão. O port captura
os bytes Protobuf antes de enfileirar e vincula o registro à conexão autenticada,
sequência, hashes e identidade completa da attempt. Uma fase divergente, outro
owner/fence, conexão diferente, prazo expirado ou predecessor ausente falha antes
do ACK. Os registros não substituem a validação do protocolo no driver.

Uma gravação tardia após timeout pode existir no disco; o canal permanece falho.
Reenvio dos mesmos bytes reconcilia o registro sem duplicá-lo. Cancelamento antes
de sair da fila não grava nada. Saída e reap podem ser registrados depois da
terminalização lógica da mesma attempt, sem reativar lease ou permitir efeitos.
Launch e ativação continuam proibidos após cancelamento.

O E2E físico compõe esse port do produto com supervisor, runner, leitura nativa,
Provider Gateway e journal Rust reais. Ele confirma os cinco fatos até reap e a
reabertura do ledger, com duas chamadas de provider determinístico. A fixture
continua fornecendo snapshots e o grant de ativação em modo shadow; essa prova
fecha a persistência de fatos, não o provisionamento produtivo completo.

O lease nativo também limita o grace de cancelamento pelo orçamento e deadline
selados. Autoridade já expirada fecha os processos pertencentes ao lease em vez
de enviar uma mensagem fora do contrato.

Validação: 484 testes passaram e 22 ficaram ignorados pelos gates configurados;
quatro cenários físicos adicionais passaram, incluindo retomada sem repetição e
mutação real com ACK perdido. Compilação de produção, `tsc-alias`, limite de LOC
e empacotamento Windows passaram. Evidências em
`scratch/harness-20261003/supervisor-fact-regression.txt`,
`supervisor-fact-physical.txt`, `supervisor-fact-build.txt` e
`supervisor-fact-package.txt`.

### Três amostras do mesmo pacote Windows

O harness agora registra o SHA-256 do executável e do `app.asar` em cada amostra.
Os três cenários abaixo usaram exatamente os mesmos arquivos, cada um com perfil
e projeto novos e provider determinístico em loopback. O cache de arquivos do
sistema operacional não foi controlado. Em cada execução passaram leitura,
retomada, aprovação de escrita real e cancelamento; houve oito requests principais
e quatro preflights, nenhum erro do renderer e nenhum processo Electron rastreado
sobreviveu ao fechamento.

| Amostra | Diálogo com leitura | ACK de cancelamento | Runner/SSE encerrados |
|---:|---:|---:|---:|
| 1 | 2.083,083 ms | 24,284 ms | 28,985 ms |
| 2 | 2.376,657 ms | 22,678 ms | 28,114 ms |
| 3 | 2.215,717 ms | 28,562 ms | 33,313 ms |

A conexão do provider fechou em todas. Esta é uma baseline local repetida de um
cenário definido, sem p95 de produção ou comparação de qualidade entre engines.
Não fecha a matriz completa de G0 ou os gates de shadow/canário.

- `app.asar`: `ab14bb6437e82410fcf3f942fdb2c9ad39e7da3c3eb4164faa27cf7f19df8760`.
- Executável: `c6356037a45de8fbd5de97d7026f13332c5521e974f3eac21ebc246c8fbdcab3`.
- Windows x64, harness em Node 22.20.0, 2026-10-05.
- Evidências: `scratch/harness-20261003/supervisor-product-baseline-{1,2,3}/report.json`.

## Continuação de 2026-10-05: preparação real, conteúdo durável e leituras Host concorrentes

O caminho nativo de integração agora admite a attempt pelo `FileControlPlaneStore`,
confirma a rota pela fachada e só ativa o processo após os fatos físicos do
supervisor e o grant durável do produto. Falha de disco, ACK perdido, projeção
parcial, owner substituído e cancelamento durante admission têm testes próprios.
A fixture dos primeiros testes físicos deixou de ser a autoridade de ativação.
Os snapshots de ambiente/workspace dos testes ainda são fixtures: isso não
institui um lease de workspace no worker produtivo.

`prepareNativeCoderContext` reutiliza a preparação do worker e seu registro selado:
provider, modelo, reasoning, prompt, ferramentas, preset e histórico anterior.
O novo snapshot inicial é distinto de um checkpoint de recovery. Rust confere a
identidade e exige que o último usuário corresponda exatamente à tarefa selada,
sem duplicá-la. Imagens e documentos via leitor autorizado têm referências por
hash e orçamento de bytes; a limpeza da hidratação não descarta imagens que o
gateway ainda precisa enviar ao provider. A composição de fontes confere a ordem
e o conjunto exatos do manifesto, incluindo attachments da tarefa.

Texto, argumentos e resultados completos são registros de conteúdo separados do
lifecycle, limitados e autenticados. A publicação ocorre após commit e ACK.
`NativeCoderEventProjection` reconstrói texto e cartões no bus HTTP/SSE existente;
o replay lê conteúdo mediante receipts do writer Rust. Um consumidor lento tem
cursor invalidado para replay em vez de acumular uma fila sem limite.

Uma recusa de policy/usuário agora tem registro durável próprio, não passa por
`started` e retorna erro ao próximo turno do provider. IDs de ferramenta que o
provider reutiliza em outro turno não colidem com operações anteriores: o ID da
operação inclui a identidade do turno, mantendo o ID original para o modelo.
Depois do terminal confirmado, o gateway elimina inputs, outputs e grants grandes
e guarda somente um tombstone limitado. A prova de 1.000 operações confirma a
liberação dos mapas ativos e a impossibilidade de redispatch de operação retirada.

### Concorrência efetiva através do gateway TypeScript

Além das leituras nativas, janelas homogêneas de até quatro `HostCapability`
explicitamente `readOnly` e `parallelSafe` usam `CapabilityReadBatchExecute`.
Cada membro cruza sua própria barreira durável de `started`. O Host verifica todo
o lote contra grants e classificação do registro selado antes de aceitar qualquer
execução. Ferramentas sem classificação, com risco dinâmico, interativas, comandos
e mutações permanecem barreiras; um lote não mistura turnos do provider.

O ACK do lote libera o único owner do Data channel. Cada resultado chega em sua
própria mensagem, em ordem de conclusão; o runner libera o canal entre resultados
para confirmar e publicar imediatamente o conteúdo e o terminal daquele membro.
Resultados que chegam enquanto um commit está aguardando ACK são autenticados e
guardados num buffer restrito aos quatro membros. A sequência entregue ao modelo
continua a original. Resultado duplicado, estrangeiro ou ambíguo não autoriza nova
execução.

O teste físico mantém uma leitura lenta bloqueada até observar no bus o terminal
durável de outra leitura. Também exige que as quatro tenham entrado no handler,
confere a barreira antes de escrita/comando e verifica a ordem do próximo request
do provider. Passou tanto com aprovação quanto com recusa de escrita. Um terceiro
cenário cancela com as quatro leituras bloqueadas, encerra os handlers e confirma
o reap do supervisor, sem chegar à escrita. O provider é determinístico e local;
essas provas medem sobreposição e ordenação, não a latência de um modelo externo.

### Evidências e limites desta continuação

- 650 testes Rust passaram no workspace (`native-host-batch-workspace.txt`).
- 601 testes TypeScript passaram, com 22 ignorados pelos gates, em 79 arquivos;
  seis arquivos ficaram ignorados (`native-host-batch-regression.txt`).
- Os dois cenários de leitura/edição/comando/recusa passaram
  (`native-host-batch-physical-recheck.txt`). O cancelamento de quatro leituras
  passou separadamente (`native-host-batch-cancel.txt`). A regressão física
  ampliada também passou nos cenários de ativação, recovery, ACK de mutação
  perdido e processos; sua primeira execução detectou uma expectativa de conteúdo
  de sucesso indevida no teste de cancelamento, corrigida na reexecução.
- O gate de 250 linhas passou em 826 módulos de produção (`native-host-batch-loc.txt`).
- Pacote nativo Windows x64: build
  `runtime-v1-197bf578360dab4bbb3dae8a476e6280a08fa41099114c72faaccd13e487e39f`,
  manifesto `a67ef3bddaffde2227bfc083359d50464b12aac83782d7eee12800a09dbeb19a`.
- Logs acima em `scratch/harness-20261003/`. São evidências do checkout local,
  não uma certificação de uma release publicada.

O worker principal ainda executa `CoderRunner.run` pela rota `legacy_required`.
A composição nativa acima é exercitada em integração física `test|shadow`, não
selecionada automaticamente em produção. Faltam o lease real de workspace dessa
composição, a ligação do contexto preparado ao worker, a integração dos leitores
de histórico persistido, a convergência de MCP/CLI e os gates de supervisor multi-launch,
recovery/rehydration e rollout. O adapter OSS continua versionado; nenhum modelo
escolhido pelo usuário é trocado. Company/subagentes continuam árvores legadas.

## Candidato validado em 2026-10-05: produto, interface e continuidade nativa

O dispatcher usado pelo produto também executa janelas de até quatro leituras
estáveis explicitamente `parallelSafe`. A classificação padrão permissiva de
uma ferramenta interna não basta para habilitar concorrência. Ferramentas
ocultas, inputs equivalentes, decisões de coalescência, risco dinâmico, efeitos,
comandos, interação e mutações fecham a janela. Todos os membros iniciados são
drenados antes de propagar falha inesperada; cancelamento impede iniciar a
barreira seguinte. O callback publica resultados em ordem de conclusão e o
array destinado ao modelo conserva a ordem original.

Na reprodução sintética, quatro leituras de 100 ms custaram 109,552 ms com
concorrência máxima quatro. No lote de 20/200 ms, o primeiro resultado ficou
visível em 29,245 ms, antes do segundo, em 203,114 ms. A persistência aquecida de
históricos de 100, 1.000 e 10.000 turnos aplicou apenas os 20 novos commits depois
da abertura: os contadores foram respectivamente 120, 1.020 e 10.020. Não houve
reaplicação integral do histórico em cada turno. Esses cenários não medem o
tempo de um provider externo nem autorizam extrapolar um ganho percentual total.

O coordenador semântico usa consulta agregada para IDs de projetos em remoção e
`EXISTS` para detectar jobs abertos. A seleção de backfills de documentos passa
pelo worker em páginas limitadas, com filtros de namespace e geração. Chamadas
simultâneas compartilham o mesmo trabalho. Antes de alterar um candidato, o
coordenador relê o job e rejeita estado já concluído ou cancelado; uma resposta
atrasada do worker não ressuscita jobs. Consultas pontuais ainda existem no main;
essa mudança não equivale à retirada de todo acesso síncrono ao SQLite.

O fluxo nativo agora publica `message_complete`, fase e usage por turno. O ID
visível de cada ferramenta inclui attempt e operação do provider, evitando que
um ID remoto reutilizado em outro turno sobrescreva cartão ou aprovação anterior.
O ID original continua no protocolo do modelo. Blocos `thinking` do histórico e
do turno atual atravessam o contrato gerado e a continuação após ferramentas,
separados do texto público e com limite cumulativo de bytes.

### Verificação do candidato

- 832 testes TypeScript de backend/contratos passaram; 22 testes e seis arquivos
  ficaram ignorados pelos gates configurados (`native-final-host-regression-pass.txt`).
- 231 testes da interface passaram (`final-renderer-tests.txt`) e 27 testes SQL
  passaram no ABI do Electron (`semantic-final-scans-sqlite.txt`).
- 652 testes Rust passaram, com 14 ignorados (`native-final-workspace.txt`).
- 13 testes com processos reais passaram; um cenário opcional do adapter OSS
  ficou ignorado (`native-thinking-physical.txt`). Incluem aprovação/recusa,
  quatro leituras simultâneas, cancelamento, recovery e ACK de mutação perdido.
- Build de produção, aliases, empacotamento Windows, clippy do benchmark e
  verificação de LOC passaram. As features de benchmark não entram no pacote.

| Medição local | Amostras | Resultado | Limite da evidência |
|---|---:|---:|---|
| Spawn até Prepared, release e disco aquecido | 100 após 10 aquecimentos | p95 39,130 ms | Harness de startup, sem provider |
| Executor nativo de leitura | 1.000 após 100 aquecimentos | p95 0,301 ms | Inclui validação, dispatch, leitura de 4 KB e encoding; exclui IPC Host, policy admission e journal |
| ACK nativo de cancelamento | 50 após 5 aquecimentos | p95 1,401 ms | Attempts ociosas; supervisor e runner reaped em todos os ciclos |
| MessageList com 5.000 blocos durante streaming | 120 frames | p95 17,7 ms | Chromium isolado; 17–18 linhas montadas |
| Digitação durante o mesmo streaming | 12 interações | p95 9,409 ms | Round-trip Playwright e atualização do componente |

O tempo total do executor é um teto para seu overhead de dispatch: não foi
subtraída uma baseline artificial. A medição não certifica o custo de toda a
cadeia de admission/persistência. Os JSONs reproduzíveis estão em
`scratch/harness-20261003/final-native-{dispatch,cancel}-performance.json`,
`final-renderer-performance.json` e
`.tmp/rust-agent-performance/GATE-PERF-01-win32-x64.json`. O comando
`node scripts/benchmark-rust-agent-dispatch.mjs` recompila o benchmark em target
separado e registra também o SHA-256 do executável medido.

O aplicativo empacotado passou por quatro leituras, continuação em nova attempt,
escrita após aprovação HTTP e cancelamento de provider ativo. O diálogo de
leitura levou 2.643,059 ms; o ACK de cancelamento, 27,278 ms; o fechamento
runner/SSE, 32,490 ms. A conexão do provider fechou, não houve erro do renderer e
nenhum dos cinco processos Electron rastreados permaneceu vivo. É uma amostra
com provider determinístico em loopback e perfil novo, com tracing habilitado.

- `app.asar`: `657f63c52f6599700c18bf908c0d7dc11d99da81a6db5cf888ad27bd9d0df30b`.
- Executável: `0464265892c5f802d739a8b71373677fc0cdc190d1b52ad5a58626305a456a47`.
- Pacote nativo: `runtime-v1-928a81af8153b47c534f5c54790503c52b52ac33a3b5b9fef35e02e7ef0a514f`.
- Manifesto nativo: `22cf6b2908d7baaabbc9cd4f81193d970df9425e2b209b6a3950f0f00d0766cc`.
- Relatório e trace: `scratch/harness-20261003/final-product-packaged-e2e/`.

O trace contém 73.895 eventos. A maior tarefa da thread principal do renderer
foi 192,590 ms e a do browser, 191,572 ms. As tarefas maiores de até 2.838,496 ms
pertencem a workers de fundo, não à thread da interface. O congelamento antigo
de 8,759 segundos não foi reproduzido nesse perfil; sua causa original permanece
sem identificação. O harness usa categorias explícitas no argumento
`--trace-startup`: a forma sem valor provocou uma falha de tracing do Electron
42 nesta máquina e foi corrigida.

### O que ainda impede declarar a migração concluída

O pacote validado acima continua executando a rota principal `legacy_required`.
O Rust é exercitado pela composição física `test|shadow`. Ainda faltam a
autoridade real de lease de workspace nessa composição, seu handoff pelo worker,
os leitores de histórico nativo nas APIs existentes, artefatos retornados por
ferramentas, paridade de preparação/compactação entre turnos e convergência
MCP/CLI. A outbox durável/recovery do supervisor, certificação de multi-launch,
shadow comparativo, canário e rollback continuam abertos. Company/subagentes
permanecem em árvores inteiramente legadas. Não foram executados benchmarks de
qualidade/custo com providers externos. A autorização do usuário não é o
impedimento: são implementações e provas ainda necessárias.

## Integração do produto e histórico em 2026-10-05

Após a aprovação do plano, a preparação de `runCoder` foi separada de sua
execução. `prepareCoderExecution` entrega provider, mensagens e registry
selado ao executor nativo antes da construção de `CoderRunner`. O worker e a
fachada usam essa entrada somente com `CODESTUDIO_NATIVE_CODER_DEV=1`, Windows
x64, projeto local e catálogo de `read_file`. A autoridade de preparação,
ativação, rota, controle e terminalização permanece no processo principal,
por RPC autenticado pela attempt. As credenciais continuam no gateway TS.

O provider configurado tem identidade distinta do protocolo do adapter:
`harness-local` usa DeepSeek no teste. A composição agora preserva o ID lógico
selado sem alterar o adapter nem trocar o modelo. Outra correção preserva a
cópia do nonce de ativação antes do descarte do buffer original.

O journal Rust ganhou um leitor independente, sem lease de escrita, reparo ou
criação de arquivos. A bridge recebe open/close reader; list/read/query aceitam
exatamente um handle. Uma fotografia é validada na abertura e invalidada por
mudança de fonte/autoridade. O histórico do produto reconstrói entrada,
mensagens, tools e usage dessa leitura e reutiliza a projeção com verificação
de validade. Contagem, tail, paginação e acesso por sequência usam a mesma
fonte; o replay cede o event loop em fatias de 4 ms. Limites atuais: 100 mil
records e 64 MiB de projeção. Isso ainda não é certificação de 10 mil turnos
representativos nem de retomada com anexos/efeitos.

### Provas do produto

- Snapshot inicial do checkout e 139 arquivos novos preservados em
  `scratch/harness-candidates/2026-10-05T23-11-07-017Z`; SHA do manifesto:
  `708cfe80b80e578899030f2a2eb91a15572e86203c933b44eebaaca2d97079d5`.
- `scratch/harness-20261003/native-product-packaged/report.json`: compositor,
  quatro leituras Host, segundo turno, resposta visível e cancelamento; ACK
  **27,3 ms**. ASAR `7e70ff0c515ecab0965b1c07bead12479791c779c6ff654112aa6f6b24dfd05c`.
- `scratch/harness-20261003/native-history-packaged/report.json`: os mesmos
  passos mais **sete mensagens recuperadas e reload da interface**, com ACK
  **21,0 ms** e encerramento do cancelamento em **445,8 ms**. ASAR
  `2314a11dea45284c64f9d757d564f7e277af6539fc567db1c707e5ccf80096b6`;
  runtime `runtime-v1-06b01f0d1d38df8b971acad48f8806670eef2932a5826064c714fdd80f3743ed`.
- Ambos usaram perfil/projeto isolados e provider loopback determinístico;
  nenhuma autenticação cloud, qualidade de modelo real ou canário foi
  certificado. A fixture de conta é somente IPC em memória no processo de
  teste. Não houve processos Electron restantes após encerramento.
- O primeiro ensaio empacotado falhou por sincronização do compositor, antes
  de chamar o provider. O harness passou a aguardar o modelo renderizado e
  clicar no botão habilitado. O erro não foi descartado como ganho do runtime.
- Os tempos acima são amostras individuais, não p95. O tempo total inclui
  interface, preparação e preflight auxiliar; não mede o gate de startup.

### Autoridade e recovery em andamento

O lease de workspace agora tem ledger durável, raízes canônicas, epochs,
conflitos entre raízes sobrepostas e recusa de liberação de writer expirado
sem prova de término. O lock de transação do produto passou a usar o mutex
nativo descrito abaixo. Ainda falta integração com revogação/renovação e
processos Host persistentes.

`HostEffectScope` acompanha a duração real do handler mesmo após timeout da
comunicação. A composição aguarda esse trabalho antes de liberar o workspace;
timeout de drain retém o lease. Um teste com handler que ignora cancelamento
confirma que `outcomeUnknown` não significa efeito encerrado. A terminalização
espelhada no main também preserva o recibo/reason já confirmado pela fachada.

O writer Rust foi alterado para lock do sistema operacional, com arquivo de
lock permanente e owner publicado por rename. O teste mata o processo writer,
reabre com epoch seguinte e verifica replay do recibo sem duplicar o registro.
Leases do formato antigo não são roubados. Essa mudança passou no store e em
dois cenários de recovery; **não integra o pacote de histórico identificado
acima** e ainda precisa entrar no próximo candidato.

Validações recentes: sete testes da bridge; 23 testes do store antes do teste
de processo; dois cenários de recovery de writer (o helper marcado ignored é
executado pelo processo filho); 18 testes de executor/drain/composição física;
typecheck. Os relatórios estão em `scratch/harness-20261003/native-*`.

Permanecem: outbox durável/reconciliação do supervisor, multi-launch, escrita e
processos Host sob autoridade completa, retomada, conteúdo/anexos completos,
catálogo de programação, CLI/MCP/árvores Company, corpus comparativo, piloto I0,
soak, canário e rollback. O runtime padrão continua legado. M2 é a frente
crítica; a primeira integração de leitura/histórico não aprova os gates globais.

### Locks de processo e continuidade da conversa — 2026-10-05

O writer e o mutex do ledger de workspace agora mantêm locks do sistema
operacional. Os arquivos de lock permanecem no disco; a posse termina ao
fechar o handle ou morrer o processo. O protocolo devolve `LOCK_BUSY` e o Host
aguarda com timer assíncrono. O ledger v2 recusa mistura com o lock antigo e
não remove leases antigos por estimativa de idade/PID. O teste Rust mata o
processo detentor, reabre o writer/mutex e confirma um único commit do efeito.
O ledger retém writers expirados até prova de reap; isso continua distinto da
recuperação automática do mutex de transação.

A leitura do journal pode descobrir sua autoridade atual por uma cadeia
validada, sem obter poder de escrita. O epoch de armazenamento avança por
sessão, independentemente do epoch da nova command/attempt. O worker recebe
histórico Rust, a projeção acrescenta a entrada de cada novo comando e a
assinatura de eventos começa na sequência já existente quando o writer abre.
Uma sessão com transcript Rust recusa continuação pelo legado. Attempts já
abertas exigem recovery explícito, sem novo dispatch automático.

Evidências adicionais:

- `native-root-lock-crash-tests.txt`: oito testes da bridge e dois cenários
  de recovery de processo; o helper ignored é executado pelo teste pai.
- `native-root-lock-physical-tests.txt`: oito testes, incluindo owners nativos
  concorrentes, timer responsivo, liberação por falha e epochs monotônicos.
- `native-followup-physical-tests.txt`: quatro testes, incluindo duas commands
  na mesma sessão com epoch de armazenamento 1→2, histórico preservado e
  invalidação da fotografia antiga. Corrigiu um cursor zero que, antes,
  impedia a assinatura da segunda attempt.
- `native-followup-replay-tests.txt`: 19 testes de replay, frontier e eventos.
- `native-lock-vector-packaged-2/report.json`: extensão vetorial `v0.1.9`
  carregada no pacote, quatro leituras, reload e ACK de cancelamento de 21,8 ms.
  O loader agora aponta ao arquivo físico em `app.asar.unpacked`.
- `native-followup-packaged/report.json`: duas mensagens enviadas pelo
  compositor, nove mensagens recuperadas após reload, quatro requests de
  execução no total (duas no primeiro comando, uma no seguinte e uma de
  cancelamento), ACK de cancelamento de 25,2 ms e nenhum PID restante.
- `native-followup-local/report.json`: mesmo fluxo no Electron local;
  ACK de cancelamento de 30,0 ms. Tempos individuais, sem afirmação de p95.

Todos os relatórios ficam em `scratch/harness-20261003`. O provider é loopback;
essas provas não certificam qualidade, custo ou latência de um provider real.
Os gates globais e o default legado permanecem inalterados.

### Anexos persistidos no produto — 2026-10-05

O compositor Windows agora atravessa a rota de desenvolvimento Rust com imagem
e documento por referência local. O leitor de documentos usa os grants da sessão,
resolve a raiz real, recusa junctions que escapem dela, limita bytes e verifica
identidade/alteração do arquivo. Um grant de arquivo não concede acesso aos seus
vizinhos. Os bytes são persistidos pelo writer nativo em chunks de 128 KiB antes
do primeiro provider; o reader valida grupo completo, digest, autoridade e sessão.
O contrato preserva o nome do documento. A continuação recupera os bytes do
journal, mesmo se o original mudar ou desaparecer.

Validação em `scratch/harness-20261003`:

- `native-documents-local/report.json` e `native-documents-packaged/report.json`:
  imagem e documento fora do projeto anexados pelo compositor; quatro leituras,
  reload com sete mensagens, segunda command/reload com nove mensagens; provider
  recebeu o conteúdo original após alterar o arquivo. Nenhum processo restante.
- Pacote: ASAR SHA-256 `86b90d9c520b57767e5c1991c86c6c74b03a331fa51cdc37143005e9c281a08f`,
  EXE `371ebddfd2ca27356c2a02eaa7ea08d637547cc0d2d2d0655a518f11e9d33cc8`,
  runtime `runtime-v1-d197dba0901fd73903117961aeee207c252f19d68350076dbe54dd86f70d19cf`.
  ACK de cancelamento: 22,36 ms; execução isolada, não p95.
- `native-documents-physical.txt`: dois testes físicos; o original é removido
  antes da segunda command e o provider ainda recebe imagem e documento nomeado.
- 17 testes de material/provider/anexos/permissão passaram; typecheck/build e
  testes Rust de runner/store/bridge passaram (`native-documents-rust-tests.txt`).

Houve uma falha transitória de transporte no primeiro ensaio anterior de anexos;
três repetições passaram. A causa não foi isolada. O coordenador agora preserva
o erro inicial quando o fechamento dos canais gera um segundo erro, com teste
de regressão. Não atribuir a ele uma correção comprovada da falha transitória.

Ainda faltam artefatos devolvidos por ferramentas, anexos maiores que os limites
do contexto/IPC, deduplicação entre commands e retomada de execução interrompida.
O pacote acima antecede o trabalho subsequente da outbox do supervisor.

### Outbox durável, reinício e anexos sem duplicação — 2026-10-06

O supervisor persiste o par Exited/Reaped numa outbox com lock do sistema
operacional, cadeia de hashes e limites antes de liberar a reserva de recursos.
O ACK do Host também é persistido. Falha de gravação conserva a reserva em
quarentena; reabertura não dispara outro processo nem repete efeitos.
`agent-lifecycle-store` é compartilhado pelo writer do supervisor e pelo reader
autenticado da session bridge. A inspeção recusa um supervisor ainda vivo.

Na inicialização, o Host compara essas evidências com a identidade, PID,
proveniência e conexão do lançamento original e grava um checkpoint idempotente.
Esse caminho permanece ativo com a flag de desenvolvimento Rust desligada.
Perfis sem sessões nativas não carregam o pacote; a recuperação nativa filtra
as sessões antes de consultar seus runs. Um pacote nativo indisponível não
impede novos comandos legados em sessões independentes.

Anexos idênticos da mesma sessão agora usam identidade derivada do conteúdo e
metadados. O writer corrente confirma os chunks anteriores pelo índice de
operações; a segunda command não duplica os registros. Outra sessão, nome ou
conteúdo produz outra identidade. Receipts de epoch futuro ou de outro writer
no mesmo epoch são recusados.

Evidências em `scratch/harness-20261003`:

- `native-recovery-packaged/report.json`: quatro leituras, imagem/documento,
  segunda command, cancelamento, encerramento e reinício completo do Electron
  com a flag Rust desligada; nove mensagens preservadas, três checkpoints de
  recuperação, zero chamada ao provider repetida e zero PID restante.
- `native-startup-recovery-tests.txt`: 14 testes, incluindo o runtime físico;
  `native-dedup-tests.txt`: 21 testes de anexos, material, coordenador e duas
  execuções físicas. A continuação conserva exatamente os dois receipts de
  anexos da primeira command, mesmo após excluir o documento original.
- `native-recovery-rust-verified.txt`: suites de lifecycle store, session store,
  bridge e supervisor passaram. Os skips físicos preexistentes não são gates
  aprovados. `native-recovery-clippy.txt`: workspace completo, todos os targets e
  features, sem warnings. Gates de crates e LOC também passaram.
- Candidato preservado em `scratch/harness-candidates/2026-10-06T01-43-40-334Z`,
  manifesto SHA-256 `8c244b914d0faeb506f76b67ecb8c0a031b4adf3637e985bcdc707123bdf47ab`.
  Runtime `runtime-v1-a3034fd019dd537158c0ea454d349b5c6f5b7478c48771d081e886558d4ebe10`.

Um ensaio local anterior não abriu o dashboard. Outro preservou a sessão e
gravou os checkpoints, mas o verificador procurava na pasta errada; a asserção
foi corrigida antes do ensaio empacotado aprovado. O builder usou a distribuição
Electron 42.5.0 já instalada, após o download redundante falhar na rede restrita.

O gate global de referências legadas continua falhando: 486 referências novas
frente ao baseline e 70 removidas, incluindo a migração filesystem e gateways.
Não foi regenerado cegamente para esconder esse desvio. Sua classificação por
superfície e a retirada do legado permanecem pendentes.

Essa recuperação prova encerramento dos processos nativos; o checkpoint mantém
`hostEffectsReconciled: false`. Ainda faltam rehydration de ownership anterior ao
reap, efeitos Host sobreviventes, disco cheio real, retomada interrompida e
certificação de multi-launch/soak/canário. Nenhum gate global foi marcado como
concluído. O pacote desta subseção antecede a expansão do catálogo filesystem.

### Escrita, aprovação e cancelamento nativos — 2026-10-06

O catálogo de desenvolvimento passou a admitir `write_file`, `create_file`,
`edit_file`, `multi_edit` e `apply_patch`, além das leituras. Catálogos com escrita
exigem lease exclusivo; cada operação física revalida a autoridade e a raiz,
com leitura limitada do arquivo de leases. A comparação de caminhos físicos
respeita maiúsculas/minúsculas no Windows. Expiração impede efeitos, sem liberar
automaticamente um writer cujo encerramento é desconhecido.

Uma reprodução com aprovação pendente encontrou uma corrida: fechar a interação
antes do ACK de Control fazia o resultado recusado avançar o canal enquanto o
cancelamento ainda era enviado. Os efeitos físicos são bloqueados imediatamente;
os waiters Host são fechados após o ACK ou encerramento físico. Cancelar pela
fachada e pelo sinal do worker passou sem criar o arquivo ou executar a próxima
barreira. Falha de preparação anterior a qualquer lançamento libera sua própria
reserva; falha após iniciar a ativação continua exigindo prova de encerramento.

- `native-filesystem-product-recheck.txt`: 20 testes de filesystem, fence e leases.
- `native-filesystem-abort-tests.txt`: nove testes, incluindo aprovação, recusa,
  cancelamento direto e abort externo com processos nativos reais.
- `native-filesystem-packaged/report.json`: escrita pelo endpoint público de
  aprovação, receipt durável, quatro leituras, anexos, segundo comando e reinício.
  Quatro attempts reconciliadas, zero provider replay e zero processos restantes.
  ACK de cancelamento de 23,09 ms, amostra individual.
- ASAR SHA-256 `94363a26a5058db200038165003e42477dfe4e895a13a1acbd13d9951dfb1d9f`;
  EXE `fc059c8180d912405871b971f3548373504ec69ad4d366e07138d00e84b15f32`.

Esse pacote ainda antecede as imagens devolvidas por ferramentas. A versão atual
do lease tem deadline fixo de até 120 segundos e não constitui exclusão entre
writers legados/Company e nativos. Processos shell persistentes, renovação,
retomada interrompida e o lembrete de verificação do runner legado ainda não
foram integrados. A expansão do catálogo não certifica esses recursos.

### Imagens de ferramentas no provider, interface e replay — 2026-10-06

`view_image` foi incluído no catálogo nativo. O Host materializa texto/imagem/
documento inline devolvido em `extraUserBlocks`, confirma os chunks dos anexos
no writer autorizado e só então devolve a referência ao runner. O contexto Rust
acrescenta as mensagens extras depois de todos os resultados do lote, preservando
o pareamento de tools. A projeção ao vivo publica `result.image` apenas após o
terminal durável, e o replay usa os bytes persistidos. Conteúdo adicional sem
materialização confirmada não é tratado como entregue.

Provas em `scratch/harness-20261003`:

- `native-tool-images-tests.txt`: 23 testes, incluindo processos reais para
  imagem + leitura, aprovar/recusar escrita, cancelar durante aprovação, abort
  externo e falha de preparação. O teste de imagem remove o arquivo original
  antes do replay e verifica o conteúdo recebido pelo segundo provider.
- `native-tool-images-runner-tests.txt`: os 146 testes do runner Rust passaram;
  `native-tool-images-clippy.txt`: todos os targets/features do runner passaram.
  TypeScript compilado, gates de crates e LOC aprovados (845 módulos Rust).
- `native-tool-images-packaged-2/report.json`: quatro leituras + `view_image`,
  anexos do compositor, segundo comando, escrita aprovada, cancelamento e
  reinício completo com a flag Rust desligada. A prévia lazy foi aberta pela
  interface e o PNG decodificou; onze mensagens foram recuperadas, quatro
  attempts reconciliadas, nenhum provider replay e nenhum PID Electron restante.
  ACK de cancelamento: 25,44 ms, amostra individual.
- ASAR SHA-256 `76fa7fac9ac36c580d3d6014b861ddf640148f19b024a9a33b62190b2b7e2bfc`;
  EXE `7d48bbb1ffaef71cc57461a2aff2abe99ff81e8c1d44d28051a0fae06f75aa91`;
  runtime `runtime-v1-00194833da4f99ee34181196e9c3ac60b40d0dcee02fd016ca9770a675cf9d63`.
- Candidato de código em `scratch/harness-candidates/2026-10-06T02-17-33-859Z`,
  manifesto `3e87921f7309cf63eae8e67deb26dfafc39ea58b7c6ec2ebf76ac9063ce8c7ca`.
  A correção posterior do script de UI somente clica na prévia lazy e espera
  a decodificação; o pacote é o mesmo nos dois ensaios.

O primeiro ensaio empacotado esperava a imagem antes de clicar em “Load preview”
e expirou: a API deliberadamente remove base64 da listagem. A correção exercitou
o comportamento real de carregamento sob demanda, sem desabilitá-lo. Um erro
`concurrent_session_mutation` apareceu nesse primeiro log durante leitura
concorrente; a política de invalidação/retry dessa projeção ainda requer revisão.

O orçamento de material extra continua limitado a 8 MiB por attempt. Documentos
retornados apenas como caminhos não são aceitos nessa extensão. Isso não comprova
todos os tamanhos máximos, providers com fallback de visão, MCP/plugins ou
retomada de uma execução interrompida.

## Busca, comandos contidos e disputa no histórico — 2026-10-06

O catálogo de desenvolvimento passou a oferecer as buscas internas MCP com
proveniência verificada e classificação explícita de leitura independente. O
sinal de cancelamento chega ao SDK MCP. `run_command` e Git usam agora uma ponte
Host Windows que cria o processo suspenso dentro de um Job Object, com stdin,
stdout e stderr próprios. O dono encerra descendentes inclusive quando o processo
principal termina normalmente; o resultado só chega após reap. Falha ao comprovar
cleanup conserva o lease de workspace. Saída mantém começo e cauda real, com
contagem dos bytes omitidos. O shell conserva a gramática de `cmd /d /s /c`.

A projeção de histórico agora descarta a fotografia invalidada por commit
concorrente e tenta abri-la novamente, no máximo três vezes. Corrupção, autoridade
obsoleta e erros de IO não são convertidos nessa política de retry. Isso evita
uma classe de falha transitória; não elimina o replay integral quando o cache
da projeção expira. A decodificação de conteúdo extra rejeita campos Protobuf
desconhecidos, alinhando a verificação canônica TS à implementação Rust.

Evidência do candidato:

- `native-search-history-tests.txt`: 18 testes, incluindo invalidação de leitura,
  corrupção/autoridade e contrato/cancelamento da busca.
- `native-host-command-rust-tests.txt`: seis cenários físicos Windows, com
  stdin/stderr, aspas, saída de 200.008 bytes limitada a 128 bytes retidos,
  cancelamento, timeout e descendente que sobrevive à saída do pai.
- `native-shell-port-tests.txt`: 20 testes de cinco arquivos; inclui Node-API
  real, comandos/Git, cancelamento, filesystem e preservação do lease em falha.
- `native-coder-shell-tests.txt`: três cenários físicos atravessando provider,
  policy, aprovação/recusa e cancelamento após criação de um filho; o PID observado
  já não existia antes de liberar o workspace.
- Clippy de platform/Host/N-API sem warnings; build TS e aliases aprovados;
  orçamento de 850 módulos e grafo de 12 crates/17 arestas aprovados.
- `scratch/harness-candidates/2026-10-06T02-39-46-403Z`: manifesto
  `40fdd2c78301d79af14273d4b090e8cee7f2160478e376b707e6004432425261`.
- Runtime `runtime-v1-7418a953e306ad4d160933a962a4f3dc97dfed9716634be961e2155c479438c4`;
  manifesto `b47729ae775e488e45fe6a29c494465f5b16679310b2bda6956cef80670ac290`.
- `scratch/harness-20261003/native-commands-packaged/report.json`: comando
  aprovado, Git, busca MCP, imagem de tool, reload, novo comando, cancelamento e
  reinício aprovados. Dez mensagens viraram doze; quatro attempts reconciliadas,
  zero provider replay. ASAR
  `e8bab8a67e67bc079f7700e95d846841fce362967082156d7cf4f55399253d98`;
  EXE `3fc64ebe39102a32ad8230183dc0c90044c61d20153f6b3c720432022aaafb50`.
  ACK de cancelamento 30,16 ms; fechamento 375,98 ms, amostras únicas.

Os ensaios usam provider determinístico local. O Job limita cada comando a
2 GiB e 128 processos, com teto de dez minutos e deadline menor do lease atual.
Não comprova orçamento agregado de todos os efeitos Host, PTY ou comandos em
segundo plano persistentes. MCP externo/plugins e a exclusão entre legado e
nativo ainda não foram certificados; canário, qualidade/custo e p95 permanecem
abertos. O teste empacotado anterior da busca está em `native-search-packaged`.

## Continuação entre comandos e resultados incertos — 2026-10-06

O endpoint existente `/continue` cria outro comando/run. A composição agora
representa isso pelo trigger aditivo `SESSION_CONTINUATION`, mantendo `RESUME`
como attempt posterior do mesmo run. O checkpoint da nova execução conserva
mensagens e resultados; nenhum texto auxiliar de preparação chega ao provider
ou à projeção do histórico. Provider, modelo e configuração continuam vindo
da sessão atual.

A admissão verifica o journal depois de adquirir a autoridade de workspace.
Resultados desconhecidos bloqueiam qualquer novo comando. Na continuação,
writer, run, revisão/hash do journal e digest das mensagens formam uma prova
durável. IDs de tool renomeados pela interface são comparados pelo pareamento
exato entre chamada e resultado. Conteúdo divergente, chamadas pendentes ou
efeitos posteriores ao último checkpoint bloqueiam a continuação. O scan atual
tem teto de 65.536 registros; sessões extensas ainda exigem índice incremental.

Quando um efeito retorna `OUTCOME_UNKNOWN`, o scheduler abandona os membros
ainda não executados e grava uma interrupção antes da limpeza física. Essa
interrupção não reconcilia o efeito. Falhas de transporte antes da primeira
leitura também são capturadas pelo dono do canal, sem rejeição não tratada.

Validação desta alteração:

- Três cenários físicos de produto: continuar após uma escrita concluída,
  rejeitar resultado incerto e rejeitar histórico adulterado. A escrita ocorre
  uma vez, e os cenários rejeitados não invocam o provider novamente.
- Seis arquivos de regressão passaram com 32 testes; os 19 testes do contrato
  passaram após atualizar as expectativas dos campos de reader/lock/outbox
  adicionados anteriormente. Transporte: 23 testes. Rust: 151 testes de biblioteca
  e 18 de turn loop. Clippy sem warnings, build TypeScript/aliases, LOC e grafo
  aprovados. Logs `native-continuation-*.txt` e `native-transport-error-tests.txt`
  em `scratch/harness-20261003`.
- Runtime `runtime-v1-e78ba63a54ef729c50e785bd038cb5baf5301ebdcb2520f6e3ab65db630a43a6`;
  manifesto `856dc567ca6ee081c12ba3c033078214b533a1934b37ecbda0b4bde9a19e5529`.
- `native-continuation-packaged-verified/report.json` passou com
  `--native --attachments --filesystem --tool-images --search --commands --continue --restart`.
  A continuação preservou quatro mensagens e fez uma chamada ao provider;
  reinício reconciliou seis attempts, manteve doze mensagens na conversa principal
  e não repetiu provider. ACK de cancelamento: 30,10 ms; fechamento: 373,98 ms;
  duração total: 29,59 s. São amostras únicas com provider local.
- ASAR `117dd4c8493421b6c30dfe0447d3d7772f3cb99aae33e982be313dd8ae694efb`;
  EXE `715efc3485845688afcede886390f8eae51aedbdd9b395c44473070a13163669`.
- Fonte capturada antes da última correção do contador do harness:
  `scratch/harness-candidates/2026-10-06T03-10-35-728Z`, manifesto
  `ff870fca87e328532545e044e0b89b131e64ad12336177671d1cd47613e6a905`.

O primeiro teste empacotado validou a continuação, mas falhou no contador antigo
de chamadas da aprovação (9 observadas contra 6 esperadas); o harness passou a
contar por cenário, mantendo a checagem de retry. Também apareceu uma invalidação
de snapshot durante streaming nesse primeiro teste. O retry limitado não resolve
a reconstrução integral nem garante leitura sob escrita contínua; essa lacuna
continua aberta. Os PIDs acompanhados pelo Electron terminaram; esse relatório
ainda não comprova a árvore completa de processos MCP/plugins.

## Limite de turnos, imagens na continuação e crash do Host — 2026-10-06

O scheduler conclui o lote de ferramentas antes de pausar por max_turns. Uma
operação Data própria persiste a fronteira sem abrir outra chamada ao provider;
o ACK confirma o checkpoint durável antes da interrupção. IDs, correlação,
digest e prazo continuam verificados. O endpoint /continue reconhece mensagens
de imagem originadas de ferramentas pelo pareamento dos registros nativos;
a admissão ainda verifica a fronteira e rejeita efeitos incertos.

Resultados concorrentes continuam visíveis na ordem de conclusão pelo SSE.
A projeção do histórico usa a ordem das chamadas do assistant, preservando a
mesma sequência enviada ao provider. O cenário físico cobre quatro leituras
terminando fora de ordem, uma escrita executada uma vez e a retomada posterior.
Outro teste mata o processo Node Host enquanto um comando e um descendente
estão vivos: o Job Object encerra ambos antes da verificação dos PIDs.

Evidência anterior à alteração incremental do histórico desta mesma data:

- native-limit-rust-tests.txt: 373 testes de biblioteca e 18 de turn loop;
  native-limit-checkpoint-test.txt: protocolo duplex do checkpoint, digest
  divergente rejeitado, Clippy estrito aprovado.
- native-limit-ts-tests.txt: 64 testes; native-limit-final-physical-tests.txt:
  11 testes, incluindo seis cenários de continuação, ordenação, imagem, guard
  de /continue e crash físico do Host. Build TypeScript e aliases aprovados.
- Fonte: scratch/harness-candidates/2026-10-06T03-39-12-691Z; manifesto
  3db805a3e8b020f2658056247ea8bee3fc3b136c95b53a4a35d991286895c16d.
- Runtime runtime-v1-8b61cb617e4fcec567ef4a5036799a9b610c9e473fd2eddbabc6e634127e6aeb;
  manifesto 0b5b515b06d7c12acfff1327e362a126885a1a231ae88288f380b5f2250e0bb4.
- native-limit-packaged/report.json passou com todos os flags de ferramentas,
  anexos, continuação e reinício. A pausa fez uma chamada ao provider; a
  continuação preservou cinco mensagens, incluindo a imagem original mesmo
  após o arquivo de origem mudar. Seis attempts reconciliadas após reinício
  com a flag nativa desligada; doze mensagens na sessão principal; zero replay.
- ASAR 3bb58ab5ef734163164aace54f825f8e631993a6ed903991dde3cc03f9caa1ff;
  EXE 30ca600f6e32843492ff4bb6c9a369418cecbb5feb306d4d754df49a4972e25c.
  ACK de cancelamento 34,86 ms; fechamento 305,96 ms. São amostras únicas com
  provider determinístico local, não percentis nem comparação de qualidade.

A prova de crash refere-se à árvore dos comandos contidos. Não certifica
processos MCP/plugins externos, exclusão com o legado ou rollout global.

## Histórico incremental no writer ativo — 2026-10-06

O store Rust mantém a ordem dos receipts em um índice reconstruído na abertura
e atualizado apenas depois de cada commit. Novas fotografias guardam o tamanho
do prefixo confirmado; não reabrem o journal nem copiam todos os receipts.
Appends autorizados preservam as páginas antigas. Alteração inesperada do
arquivo invalida o writer, inclusive antes da primeira paginação. Reabertura
continua validando autoridade, cadeia e payloads integralmente.

O worker oferece a projeção de histórico pelas capabilities de leitura do
writer nativo existente. A API principal consulta esse worker quando a sessão
está no runtime nativo; consultas legadas não fazem esse RPC. Cada atualização
consome apenas receipts posteriores ao cursor confirmado da projeção. Chamadas
sem registros novos reutilizam o snapshot. Lotes parcialmente concluídos são
expostos sem consumir o estado necessário para ordenar os resultados futuros.
Leituras são serializadas entre si, permitem commits e são canceladas antes de
fechar o writer. O leitor independente permanece para reabertura e sessões sem
writer ativo; não foi relaxada sua detecção de mudanças concorrentes.

Validação:

- native-writer-index-tests.txt: 27 testes Rust aprovados, com um teste filho
  marcado ignored e executado pelo teste pai de crash. No Windows, um handle
  nega novas leituras de dados do journal; paginações e appends continuam
  funcionando depois da recuperação. Adulteração antes da primeira fotografia
  é rejeitada e a reabertura também falha.
- Escala sintética de receipts: paginação completa de 100 / 1.000 / 10.000
  registros por fotografia em 0,215 / 1,215 / 20,808 ms. São amostras de debug
  locais e registros, não turnos; não fecham os gates de p95 do produto.
- native-live-history-physical.txt: sete arquivos, 21 testes aprovados. Incluem
  histórico consultado durante provider ativo, imagem/anexo, cancelamento,
  resultados fora de ordem, snapshots anteriores preservados e proibição de
  reler payloads antigos. native-live-history-clippy.txt, build TS/aliases,
  orçamento de 857 módulos e grafo de 12 crates/17 arestas aprovados.
- Fonte anterior à última extensão do harness de leitura HTTP:
  scratch/harness-candidates/2026-10-06T03-56-38-760Z, manifesto
  dbaa6928e54833afd2560d9223b0bd8d3b5c0d53a7ee5f782e133f6f852a6e4c.
- Runtime runtime-v1-2069ddbc9176cf087dfd4af4d23400dd7a5286a1dabd258220f60b2f3873f2e9;
  manifesto af48bfc1f832db64a315ed69ccd27d24feeaeb0614a67c4aa64fb39215c5c7a8.
- native-live-history-packaged/report.json passou com todas as opções de
  ferramentas, continuação e reinício. Três leituras HTTP consecutivas foram
  feitas mantendo a resposta do provider pendente e preservaram os seis
  resultados e a imagem. Reinício recuperou seis attempts, doze mensagens na
  sessão principal e zero chamadas repetidas ao provider.
- ASAR d366b28aa35652ff6c595b95ae6a3c204884bfc998c43e09a56ae770077e0cfb;
  EXE 7918ad0dafeca53eed234d354d6daeb1b1a54f5ca3e04034b54cb3d6aac148c8.
  ACK de cancelamento 21,99 ms; fechamento 423,88 ms; total do ensaio 35,19 s.
  Não comparar essas amostras únicas como ganho percentual.

O RPC ainda transporta a projeção completa quando o endpoint solicita histórico
completo. A primeira abertura, a troca de attempt e a admissão de continuação
mantêm scans com limites explícitos. Sessões de 10.000 turnos, limites de memória,
consultas paginadas sem transporte integral e a matriz geral de desempenho
continuam pendentes; essa alteração não certifica canário nem paridade global.

## Observação pós-ferramenta, skills e memória explícita — 2026-10-06

Os observadores de atualização do índice e preview eram registrados em
RuntimeHookRegistry, mas o despacho compartilhado não chamava fireToolCall.
Agora ToolRegistry publica uma observação após a conclusão do handler, tanto
no legado quanto em HostCapability. Ela recebe argumentos copiados antes da
execução e metadados de resultado, sem autoridade para alterar o resultado.
O despacho não aguarda esses callbacks. apply_patch também produz as dicas de
caminhos de criação/alteração/remoção/move. A criação de linhas novas no índice
continua dependendo do watcher/dirty queue; callbacks síncronos ainda precisam
manter trabalho curto para não ocupar o event loop.

Validação desse primeiro candidato:

- native-tool-observers-physical.txt: cinco arquivos, 33 testes aprovados,
  incluindo handler com falha, isolamento dos argumentos e observação no
  processo Rust real. Build TypeScript/aliases e gates estruturais aprovados.
- Fonte scratch/harness-candidates/2026-10-06T04-14-33-105Z, manifesto
  2cf5f87b58968b9956529dbaf264ccd430387659d9ad5f9524cf5f4e70c5a9ac.
- native-tool-observers-packaged/report.json aprovado: histórico durante
  provider, imagem, busca, comando/Git, continuação e seis attempts recuperadas
  após reinício sem replay. ASAR
  8b2c76e5408760da92e53ffbf73661820e162b4781e5844c7fe6984f9715ac75;
  EXE b31a973017c55f215af0f3ddcd2e9e96a55caa80065ab475e6c9fba5f9986f53.
  ACK de cancelamento 23,73 ms; fechamento 414,99 ms; ensaio 41,07 s.
  São amostras únicas com provider determinístico local.

O catálogo nativo passou a aceitar list_skill_namespaces, get_skills_list,
get_skill_content, invoke_skill e recall_memory. O contrato exige procedência
nativa e risco de leitura. Carregar/invocar uma skill fornece suas instruções
interpoladas; não cria outro runner nem troca provider/modelo. As duas listagens
são parallelSafe; as duas operações que também registram uso/input são barreiras.

A consulta explícita de memória recebe o sinal da ferramenta até o host, busca,
embedding e reranker. Cada leitura tem identidade restrita ao canal worker;
cancelar não afeta mutações nem outro worker. Fechar o canal aborta as leituras
pendentes. Adaptadores não interrompíveis têm sua resposta tardia descartada;
o registro limita a 32 operações pendentes por worker. Falha explícita não é
apresentada como busca bem-sucedida vazia. A memória proativa mantém sua política
separada de orçamento/cache.

- native-memory-physical.txt: sete arquivos, 44 testes aprovados. Incluem
  skills reais, consulta/listagem por MessageChannel e processo Rust, conteúdo
  preservado no histórico, cancelamento durante recall sem segundo provider,
  limite de leituras não cooperativas e aborto antes da busca vetorial.
- native-memory-build.txt: compilação TypeScript e aliases aprovados.
- native-memory-packaged/report.json passou com --knowledge: quatro ferramentas
  de skills e duas consultas de memória foram executadas junto das leituras,
  busca e imagem. O histórico passou de 16 para 18 mensagens no follow-up,
  sobreviveu ao reinício e não repetiu chamadas ao provider. Conteúdo semântico
  veio da fixture real no banco isolado; o provider permaneceu determinístico.
  ASAR 6ba439e7ea1ffd4b4dec58b6a54dc63c61ac7c6d791932ebc864128f045fd5ad;
  EXE 1e6960a45e19a94ec04006d2fcaa0e763ecb0b5593f32f50913c4dc891a44fb9.
  Fonte scratch/harness-candidates/2026-10-06T04-25-45-758Z, manifesto
  1fed38004dbf7418b6fb31f3e8b29b25aa15e6f06b9676fa0f169341ee47943b.
  ACK de cancelamento 30,80 ms; conclusão 322,13 ms; duração 36,80 s. Amostras
  únicas, sem controle do cache de arquivos; não são percentis certificados.

Essas provas, isoladamente, não fechavam seleção manual de skills no compositor.
Essa extensão foi implementada e validada no candidato descrito abaixo. Memória
proativa no loop Rust, compaction, Company/subagentes, MCP externo e canário
continuam sendo gates separados.

## Skills selecionadas e contexto durável — 2026-10-06

A seleção feita no compositor agora é resolvida uma vez e transportada como
ProviderPreparedUserContextV1. O conteúdo interpolado tem prioridade de mensagem
do usuário, integra o digest da fronteira e permanece no checkpoint. A retomada
usa os mesmos bytes mesmo se a definição da skill mudar durante a pausa. O
histórico visível guarda a seleção sem acrescentar o corpo interno da skill.
O adapter OSS permanece versionado e recusa explicitamente esse novo contexto
enquanto não implementar seu transporte; nenhum engine foi promovido.

- native-selected-skills-rust.txt: 604 testes de biblioteca aprovados, 15
  ignorados. Os ignorados não contam como certificação física.
- native-selected-skills-physical.txt: 13 arquivos, 74 testes aprovados,
  incluindo processo Rust, metadados/histórico, alteração da skill após pausa,
  continuação, cancelamento da memória e verificação de digest.
- Compilação TS/aliases e clippy de todo o workspace com todos os targets e
  features, negando warnings, aprovados. Gates de 859 módulos, 12 crates e
  17 arestas aprovados.
- Runtime runtime-v1-ae40d4fa46bacec29da82ba1669e8da1dfd1805bbfb6a00afefcaa62ff171da8;
  manifesto 5727ad8af64c916f147ff13f3425733f2fd2463c56189dcc65e8e1286e00da87.
- Fonte scratch/harness-candidates/2026-10-06T04-39-17-844Z, manifesto
  5aa0173b2009979e34af2ce81622fe3a7b92e03b2f389cce2f5e84c365ef2aff.
  A correção posterior da asserção do harness está fora dessa fotografia.
- native-selected-skills-packaged-final/report.json passou com seleção real
  pelo compositor, 12 resultados, consultas durante provider ativo, imagens,
  memória, leitura/busca, comandos/Git e continuação. Reinício recuperou seis
  attempts, 18 mensagens na sessão principal e zero chamadas ao provider.
  ASAR 4a4968112fdf253dc7e28865a6111732a194a998bef495b240818a62b6d0c72c;
  EXE ddbc8880faef7f26dfeca275be16a436cd4593d768bdcdabc2e22e883dde6d19.
  Duração de 31,57 s, provider local determinístico, nenhum processo rastreado
  permaneceu vivo. Não é medida de p95 nem comparação de ganho percentual.

A primeira execução desse candidato encontrou uma asserção errada no harness:
o endpoint público retorna selectedSkillIds, não a coluna interna
selected_skill_ids_json. A asserção foi corrigida e o ensaio completo repetido.
Telemetria de uso para a seleção manual e migração de seleções antigas em todo
o histórico ainda precisam de cobertura específica.

## MCP: despacho em cache e resultados incertos — 2026-10-06

O pool compartilhado fazia tools/list de todos os servidores para resolver cada
invocação. Agora utiliza os handlers da última atualização do catálogo; health
check, refresh e mudanças administrativas continuam atualizando esse catálogo.
A ponte preserva imagens, documentos, dados estruturados e metadados de erro,
além do envelope compatível ok/text. O worker reconstrói a procedência e a
classificação conservadora de escrita; hints de servidores não habilitam
paralelismo nem tornam uma mutação segura.

Reconexão permanece permitida antes de enviar uma nova chamada. Falhas de rede,
autenticação e cancelamento após envio não provocam repetição automática. Elas
retornam effectOutcome=unknown. Esse estado atravessa a ponte, torna-se
outcome_unknown no HostCapability e interrompe o loop legado antes do próximo
provider. A fila restante recebe resultados de não execução, preservando o
pareamento. O ledger mantém a barreira mesmo se code_exec engolir o erro de uma
chamada aninhada. O histórico FS grava effect_outcome e Bootstrap/preparação
nativa recusam continuar uma sessão com esse marcador.

Cancelamento usa IDs restritos ao canal worker e chega ao sinal do SDK MCP.
Fechamento do canal aborta as chamadas pendentes. ACK de cancelamento não é
confirmação de ausência de efeito remoto. O host limita a 32 chamadas por canal,
retendo posições até a operação subjacente encerrar. O timeout de conexão é
removido após o handshake, evitando timers sobrando em conexões bem-sucedidas.

- mcp-outcomes-physical.txt: 12 arquivos, 77 testes aprovados. Servidor HTTP
  real aplicou um efeito e derrubou a resposta; houve uma única tools/call e
  nenhuma descoberta adicional durante o despacho. Inclui cancelamento por
  MessageChannel, preservação multimodal, fechamento/reabertura do store e
  continuação nativa bloqueada após efeito realizado sem confirmação.

Essa mudança ainda não certifica MCP externo no cohort nativo. Transferência de
autoridade até o despacho no processo principal, versões de configuração,
servidores stdio sobreviventes e reconciliação operacional continuam pendentes.
O legado também não ganhou um journal started por efeito: crash antes de gravar
o resultado incerto ainda exige o gate de migração/recovery. Não foi criada uma
ação de UI para remover esse bloqueio sem evidência de reconciliação.

## Catálogo preparado e identidade única do runner — 2026-10-06

O DocsAgent era instalado pelo observador onRunnerReady depois de o catálogo ser selado. O host agora fornece hostTools antes dos filtros de política e da admissão. O helper antigo torna-se idempotente quando a ferramenta já está registrada. O contexto da máquina de estados também reutiliza o runId admitido pelo CoderRunner; não aloca outra identidade para run_started/provider_call.

Validação: host-catalog-identity-tests-final.txt contém sete arquivos e 32 testes aprovados, incluindo hosts Company. TypeScript/aliases e empacotamento aprovados. host-catalog-identity-packaged/report.json passou pelo legado e MCP HTTP: uma mutação com resposta perdida, marcador preservado no histórico, continuação bloqueada e nenhum novo provider. host-catalog-identity-native-packaged/report.json passou por imagens, memória, ferramentas, continuação e reinício: seis attempts, 18 mensagens e zero provider replay. Nenhum processo Electron rastreado permaneceu vivo.

Os dois ensaios usaram ASAR d57a2f864c8392c5ce4364fd3b9610f2138142a30cdb03527e2d654d9cab2063 e EXE 36f472d561cc5364e6bf5213c91bbb3dd538bad1c16f8979539871f3fd6d95ac. Durações de 28,19 s e 32,01 s são amostras únicas com provider determinístico local. As asserções incluem ausência de falha tardia de registro DocsAgent e de divergência de identidade do runner.

O candidato MCP anterior também passou no pacote: mcp-outcomes-packaged-discovery/report.json e mcp-native-regression-packaged/report.json, ASAR 9ee8eafc96ce02bc913e204bb5cdfb1bff3ffe56893cfd369e6f75766fb55742, EXE 14641416d3d65412c52f5a3f5a77eea9be27d26f64879a96b4f7413c791629ec. A fixture usa descoberta find_tools antes de invocar a ferramenta externa, respeitando o working set do catálogo. Não foi promovido MCP externo no cohort Rust.

## Autoridade do transporte MCP e reconexões — 2026-10-06

Fechar um servidor agora invalida também handshakes e autenticação ainda pendentes. Uma resposta tardia não publica outra conexão; chamadas concorrentes da mesma configuração compartilham um handshake. O pool vincula cada ferramenta a uma revisão opaca da configuração completa e do schema. Mudanças são detectadas mesmo sem alteração de updated_at. Chamadas antigas são recusadas antes do envio; a revisão e o owner são conferidos novamente depois de eventual reconexão.

O proxy é criado por execução e transporta runId. O processo principal exige o mesmo worker, sessão e execução ativa; cancelamento ou substituição do run impedem o envio posterior. O registro de chamadas reserva sua posição antes de aguardar a autorização, permitindo cancelar durante essa espera.

mcp-lifecycle-tests-final.txt: seis arquivos, 22 testes aprovados no candidato anterior à integração nativa. Cobrem HTTP real, OAuth tardio, revisão alterada durante espera e owner antigo. TypeScript/aliases e empacotamento aprovados. mcp-lifecycle-packaged/report.json passou, com uma mutação, histórico incerto preservado, continuação bloqueada e nenhum processo rastreado vivo. Fonte scratch/harness-candidates/2026-10-06T05-28-31-301Z, manifesto 61c12259fc4abe9294d6be494c431c544b65d0ba52b14350f022e202edafca98.

ASAR 22ad16e82777b716fe7df1757cb3af9202f17b79fb03afac8e95cbdb559e0228; EXE bfe68f7a7deeb68c4cd4516b0434e6067e9d2b2378c2f712bd948caadcb71ebf. Duração de 26.94 s, provider determinístico e amostra única. A autoridade por workspace e seu transporte no cohort Rust recebem validação separada a seguir.


## MCP de rede no cohort Rust — 2026-10-06

O catálogo nativo admite ferramentas externas HTTP/SSE somente quando o host fornece configuração, revisão e procedência consistentes. O despacho atravessa worker e processo principal com runId, lease exclusivo, binding do recurso e hash dos argumentos. O host verifica esses dados e o owner; a última verificação ocorre no fetch do transporte, depois da preparação assíncrona de headers do SDK. AsyncLocalStorage separa chamadas concorrentes. Redirecionamentos de tools/call e reenvios na mesma operação são recusados.

Um resultado remoto incerto encerra o loop, persiste effect_outcome=unknown e retém o lease exclusivo. Encerrar o runner não comprova término de efeito remoto. O endpoint continue recusa a sessão antes de admitir outra execução; erros tipados da preparação também atravessam o worker e chegam como HTTP 409, retryable=false. Esse ajuste foi necessário porque a primeira execução empacotada bloqueou corretamente o efeito, mas respondeu com um erro HTTP genérico.

- native-mcp-physical-expanded.txt: 11 arquivos, 59 testes aprovados antes da barreira final de fetch.
- mcp-wire-physical.txt: cinco arquivos, 27 testes aprovados. Inclui Rust real com HTTP e SSE para sucesso, resposta perdida e argumentos alterados; zero efeito no último caso. Perda de autorização durante a espera interna do SDK também envia zero chamadas. Redirecionamento após efeito não provoca repetição.
- mcp-admission-errors.txt: 27 testes de rotas aprovados, incluindo bloqueio antes da admissão e erro tipado recebido do worker nos endpoints messages e continue.
- TypeScript/aliases, empacotamento, limite de 250 linhas dos 859 módulos Rust e grafo de 12 crates/17 arestas aprovados.
- Fonte scratch/harness-candidates/2026-10-06T05-55-08-190Z, manifesto 871b253a9a8c1f2f7eed34ca2c8319e12657cf3b5cffd2d1726966e45d2ac555.
- native-mcp-admission-packaged/report.json aprovado: uma mutação MCP, uma descoberta e uma chamada ao provider; histórico incerto e bloqueio persistiram após reinício com o flag de desenvolvimento desligado. Sete attempts reconciliadas, 18 mensagens na sessão principal e zero provider replay. Imagens, memória, skills selecionadas, leitura/busca, comandos/Git, aprovação, cancelamento e continuação também passaram. Nenhum processo Electron rastreado permaneceu vivo.
- ASAR 170b9af071f947ebd3c2d6176f2e81eb5adfded4ecbdd171878445c378b7b71b; EXE 8008cab826aabcd73ee65a991a45d72b0803029f3f087c240a03968a6f84ae41. Duração 36,73 s; ACK de cancelamento 22,34 ms e término 413,29 ms. Amostra única, provider local determinístico, cache de arquivos não controlado; não são percentis certificados.

O mesmo pacote passou em legacy-mcp-admission-packaged/report.json: uma mutação, uma descoberta, duas chamadas ao provider (descoberta + invocação), histórico incerto preservado e continuação bloqueada. Duração de 21,42 s; nenhum processo Electron rastreado permaneceu vivo.

Stdio permanece excluído do catálogo nativo até a contenção de descendentes e o transporte duplex estarem integrados. Reconciliação operacional de efeitos incertos, exclusão entre runtimes no workspace, renovação de leases, plugins e árvores Company/subagentes permanecem pendentes. O runtime Rust continua sob o flag de desenvolvimento; esta evidência não promove canário nem altera o provider/modelo do usuário.


## Custo da codificação do checkpoint — 2026-10-06

O codec gravava deltas, mas clonava o histórico inteiro para descartar seu prefixo e serializava duas cópias de cada mensagem antiga para comparar igualdade. Agora cria uma visão temporária do delta e compara campos Protobuf, incluindo campos desconhecidos. A cópia retida vem dos bytes completos já autenticados; isso também impede que buffers de campos desconhecidos da entrada alterem a base após o commit. O formato persistido e os digests não mudaram.

Benchmark reproduzível: node --import tsx scripts/benchmark-provider-frontier.mjs <report.json>. São mensagens sintéticas, três aquecimentos e vinte amostras, Node v22.20.0, sem provider ou IO durável. Relatórios em scratch/harness-20261003/frontier-before.json e frontier-after-wire-equality.json:

| Turnos | Mediana antes/depois | p95 antes/depois | Delta gravado |
|---|---|---|---|
| 100 | 2,44 / 1,48 ms | 3,11 / 5,66 ms | 151 bytes |
| 1.000 | 26,46 / 13,11 ms | 28,10 / 13,95 ms | 151 bytes |
| 10.000 | 328,74 / 152,45 ms | 374,88 / 228,63 ms | 152 bytes |

A dispersão do cenário pequeno piorou; não se afirma ganho universal. O cenário de dez mil turnos reduziu a mediana desse codec em cerca de 54%. A validação e o digest completo ainda percorrem o histórico; isto não prova custo constante do turno nem aceleração equivalente da aplicação.

frontier-codec-tests.txt: quatro arquivos e 26 testes aprovados, incluindo processo Rust, retomada, MCP, corrupção, campos desconhecidos e mudança da entrada após codificação. TypeScript/aliases e pacote passaram. frontier-codec-packaged/report.json aprovou o fluxo completo: sete attempts recuperadas, 18 mensagens, MCP executado uma vez, bloqueio antes/depois de reinício e nenhum processo Electron rastreado vivo.

Fonte scratch/harness-candidates/2026-10-06T06-04-38-606Z; manifesto fd6f506981d906da5a464b9900aefdcd31fb64ec468b0d80bd217c2c7d8607b8. ASAR 1cdcaef77b08773e6c808a442ba9c674d76a079f991dd5d8300cfd7afc248a68; EXE fe8ce6a0dc452e0b50609c66c6e887c4018c4a76249a19a572dcd888494d6b4e. Duração 38,27 s e ACK de cancelamento 28,59 ms são amostras únicas com provider local. A implementação de stdio iniciada depois dessa fotografia ainda não faz parte desse pacote.


## MCP stdio contido e integrado ao produto — 2026-10-06

O Host Windows agora dispõe de transporte duplex via Node-API com fila de
entrada limitada a quatro frames de 1 MiB e saída limitada a 32 blocos de
16 KiB. A criação suspensa instala o Job Object antes de executar o servidor;
o proprietário mantém stdin/stdout/stderr, deadline, cancelamento e reap da
árvore completa. A espera de IO ocorre fora do event loop JavaScript. A leitura
JSONL limita cada mensagem a 4 MiB, preserva UTF-8 entre blocos e cede ao event
loop a cada 4 ms de processamento. O parser de comandos do SDK instalado é
reutilizado para executáveis, shebangs e shims Windows, sem delegar o spawn.

O pool publica a comprovação local de contenção e a revisão exata do catálogo;
metadados remotos não conseguem habilitar stdio no catálogo Rust. A chamada
verifica a autoridade imediatamente antes do enqueue síncrono nativo. Não há
reenvio após escrita admitida. Falhas de limpeza são persistentes no manager:
reconexões concorrentes aguardam a aposentadoria anterior e nenhuma nova
conexão é iniciada se o reap permanecer sem comprovação. O transporte é retido
mesmo depois de o SDK descartar sua referência em onclose.

A seleção continua de desenvolvimento: CODESTUDIO_NATIVE_CODER_DEV=1 habilita
a composição nativa, e CODESTUDIO_NATIVE_MCP_STDIO_DEV=1 permite exercitar só o
transporte local com o legado. A segunda flag permanece no teste de restart
quando a primeira é removida; isso não promove o engine nem certifica o
transporte legado anterior. Plataformas não certificadas não usam esta rota.

Validação local:

- Quatro testes Rust do transporte: IO repetido, resposta final/EOF, pressão
  nas filas, cancelamento e deadline. Clippy host-bridge/Node-API passou.
- Quatro testes físicos Node-API, incluindo morte abrupta do Host e encerramento
  do servidor com descendente destacado.
- 34 testes em quatro arquivos passaram, incluindo nove cenários do runner
  Rust (HTTP/SSE/stdio × sucesso/resposta perdida/argumentos alterados) e
  executável direto/shim Windows. Outros 30 testes de regressão do pool,
  bridge e lifecycle passaram; há sobreposição entre os conjuntos.
- TypeScript e pacote Windows passaram. O E2E do pacote usou provider local,
  perfil isolado, anexos, filesystem, imagens, busca, comandos/Git, memória,
  skills, continuação, cancelamento, MCP stdio e restart.

No pacote, a mutação MCP ocorreu uma vez em uma chamada ao provider; a
continuação foi bloqueada antes/depois do restart. Sete attempts/checkpoints
foram reconciliados, 18 mensagens da conversa principal recuperadas e nenhum
provider replay ocorreu. Os quatro PIDs MCP registrados e os quatro PIDs
Electron do encerramento estavam mortos. A execução durou
44.209 s; ACK de cancelamento 28.558 ms
(amostra isolada, não p95).

Evidências: scratch/harness-20261003/stdio-native-packaged/report.json,
stdio-native-runner-tests.txt, stdio-pool-regression.txt, stdio-duplex-tests.txt,
stdio-duplex-napi-tests.txt e stdio-duplex-clippy.txt. Captura fonte
2026-10-06T06-33-17-965Z, manifest SHA-256
89acdd73babe07f424d70a126cbd9f247cb52e21e33f8aaecaa496df4767e8d7.
ASAR SHA-256 95a55270c72145b9eddc7130d69a4e00001c0aecc01b7e601e62190e6f4e4b48;
EXE SHA-256 67c8fb0737c8d5d5e4c00f10b51c0acb989c95b8db6b88daff08ca4174daa097.

Limites: plugins fora do protocolo MCP, PTY, reconciliação operacional e
exclusão do workspace entre runtimes ainda não estão certificados por esta
prova. O gate de imports foi executado e falhou: 541 referências novas ao
legado e 73 removidas em relação à baseline antiga. O relatório está em
legacy-boundary-current.txt; a baseline não foi ampliada para ocultar a falha.

Compatibilidade do mesmo pacote: o engine legado também passou com o novo
transporte stdio (stdio-legacy-packaged/report.json), em 22.675 s,
com uma mutação, bloqueio de continuação e nenhum PID MCP/Electron restante.


## Contratos neutros e comparacao de imports por simbolo — 2026-10-06

ToolResult, seus tipos de erro/saida e os construtores ok/err/unknownToolOutcome
agora vivem em agent-runtime-host/tool-result.js. O modulo antigo reexporta a
mesma API para compatibilidade. Foram ajustados 32 consumidores externos;
46 consumidores de mensagens/JSON Schema passaram a importar os DTOs canonicos
de provider-sdk diretamente. O contrato nao mudou de formato. Manter esses
tipos fora de agent-runtime-contracts evita o ciclo provider-sdk -> shared ->
agent-runtime-contracts -> provider-sdk.

O gate de fronteira legado compara agora conjuntos de simbolos por arquivo,
modulo e tipo de import. Retirar ToolResult de um import agrupado deixa de
parecer uma referencia nova; adicionar um simbolo, arquivo, namespace ou
modulo continua falhando. Referencias sem simbolos (assets/package) continuam
sendo dependencias. Seis testes cobrem essas diferencas. A baseline nao foi
ampliada. Com esse comparador, o gate ainda falha com 533 grupos novos e 122
removidos (legacy-boundary-symbols.txt); contagens anteriores por linha de
import nao sao diretamente comparaveis.

TypeScript/aliases e 59 testes focados em oito arquivos passaram. O workspace
Rust passou com 666 testes, zero falhas e 16 ignorados; alguns testes fisicos
ainda exigem opt-in e esse total nao equivale a certificacao fisica completa.
Clippy de todo o workspace/all-targets/all-features passou com -D warnings.

O pacote Windows apos a extracao passou no fluxo nativo completo e no legado
com MCP stdio. A prova nativa registrou uma mutacao MCP, uma chamada ao
provider, sete attempts reconciliadas, 18 mensagens principais recuperadas e
nenhum replay ou PID restante. A prova legada registrou uma mutacao, duas
chamadas ao provider, bloqueio de continuacao e nenhum PID restante.

Evidencias em scratch/harness-20261003: neutral-contracts-build.txt,
tool-result-tests.txt, stdio-rust-workspace-tests.txt,
stdio-rust-workspace-clippy.txt, neutral-contracts-native-packaged/report.json
e neutral-contracts-legacy-packaged/report.json. Captura fonte
2026-10-06T06-51-52-676Z; manifest SHA-256
a81a49085979b2da4b9f8b0e2d1e415ef68d0032c159da612282856a81b17216.
ASAR SHA-256 442efc341c9a4a314a7c2a21a1b7c5e0168a48f7116c8e6fc281b7959daf1a77;
EXE SHA-256 d851255c8df79a2653a6c3dcc778b0e046348d238fa93f465966b419bf0bb4e0.

Isto reduz dependencias concretas, mas nao retira CoderTool, ToolContext,
SessionStore ou os runners legados. M0, corte de producao e retirada do legado
continuam abertos.


## Orcamentos de execucao e confirmacao duravel — 2026-10-06

A composicao do produto agora aplica maxTurns, maxToolCalls e maxWallMs da
policy selada. O limite de turnos e o menor entre pedido e policy. O scheduler
reserva o lote inteiro antes de criar grants; um lote que ultrapassa a cota de
ferramentas recebe recusas duraveis sem executar um subconjunto de mutacoes.
A cota e acumulada entre turnos. max_tool_calls e preservado no SSE, ledger,
contrato terminal e projecao visual. A retomada e outro comando, sem replay.

Foi removido o teto arbitrario de 120 segundos da composicao nativa. A attempt
continua limitada pelo lease de executor admitido. Renovar o ledger no Host
nao renova automaticamente a autoridade imutavel do runner: execucoes alem
do lease inicial de dez minutos ainda requerem UpdateAttemptAuthority e nao
estao certificadas por essa mudanca.

ResolvedAttemptSpec ganhou o campo opcional execution_deadline_at_unix_ms
(tag 28). Provider, approvals e efeitos param nessa fronteira. O deadline
existente reserva um segundo adicional, dentro do lease admitido, para
confirmar resultados, gravar o terminal e encerrar processos. Bindings TS/Rust
foram regenerados pelo gerador buf.build autorizado. A ausencia do novo campo
preserva a interpretacao anterior para specs existentes.

As reproducoes fisicas encontraram duas falhas adicionais: o envelope de uma
CapabilityExecute expirava antes da resposta de cancelamento, e uma operacao
longa era limitada pelos 30 segundos de I/O de frames. O envelope agora usa
o prazo de confirmacao; o corpo e o grant continuam limitando o efeito ao
prazo original. Apenas requests de capability autenticados usam seu deadline
absoluto enquanto pendentes; demais frames conservam o limite de I/O. O canal
continua limitado pela autoridade da attempt. Expiracao durante aprovacao
fecha a interacao, grava a recusa e interrompe o lote sem iniciar outra tool.

Outra falha corrigida impedia continuacao apos recusa/falha: a projecao TS
renderizava somente reason_code, enquanto o frontier Rust incluia o envelope
JSON de erro. Os resultados persistidos agora preservam o mesmo conteudo e
pairing usado pelo modelo. Outcomes incertos continuam identificados e nao
autorizam repeticao automatica.

Os testes fisicos incluem cota cumulativa, lote recusado inteiro, policy de
plan mode, falha de handler, retomada sem replay, provider de 125 segundos,
tool de 32 segundos e prazo de tres segundos durante provider/tool/aprovacao.
Os logs desta fatia usam o prefixo native-budget- em scratch/harness-20261003.
A certificacao consolidada do candidato empacotado e registrada abaixo apos
os testes fisicos; os gates globais de rollout permanecem abertos.

A regressao fisica final dessa fatia passou com 56 testes em seis arquivos
(native-budget-complete-physical.txt). TypeScript/aliases, build do dashboard,
Clippy all-targets/all-features e os checks de LOC/crate graph passaram. Depois
da ultima correcao de approvals, engine+runner passaram com 173 testes.

O pacote passou no fluxo nativo completo (native-budget-native-packaged/report.json,
43,13 s) e no legado com MCP stdio (native-budget-legacy-packaged/report.json,
23,42 s), sem PIDs de teste restantes. Captura fonte 2026-10-06T07-58-51-253Z,
manifest SHA-256 abc9d8f8cb0070c83714a743844378377f5a764b1f083684e9e1207453f98683.
ASAR a123358a1209281498d5670a7b92c5a63724cc880129f874b28f5b14f124b888;
EXE bf468a6804879bf1a5000d57e28de24711a939ad76fde84db58760110c723a43.
Os dois cenarios usam provider local e perfil isolado; nao comprovam qualidade
ou custo com provider real, p95 estatistico, soak ou cutover.

## Streaming nativo e limites independentes — 2026-10-06

Uma reproducao fisica de 1.000 deltas encontrou encerramento do processo antes
do terminal (native-stream-burst-before.txt). Havia dois erros independentes:
o Host Data aplicava maxIpcFrames (256) ao total de identidades da conexao,
enquanto o runner ja permitia 65.536; e o engine aplicava a mesma cota de IPC
como limite total de eventos do provider. O Host agora usa o mesmo teto de
identidades do protocolo Data; o engine usa o teto de 100.000 eventos do
gateway. Correlacoes simultaneas, janela de replay, bytes, deduplicacao,
tombstones permanentes e fechamento por esgotamento continuam limitados.
Um teste duplex atravessa 100 checkpoints com cota de 64 requests pendentes.

O gateway agrupa somente deltas textuais contiguos do mesmo item/fase/tipo.
O primeiro delta do segmento sai imediatamente; os seguintes acumulam no
maximo 16 ms, 16 KiB ou 256 deltas. Tools, uso, mudanca de item/fase e terminal
sao barreiras. Ha somente uma leitura antecipada, nenhuma fila produtora em
segundo plano. Contagem e limite UTF-8 continuam sendo aplicados a cada delta
original antes de agrupar; sequencias do wire sao atribuidas depois do agrupamento.

Na primeira comparacao fisica com o mesmo binario, o cenario de 1.000 deltas
contiguos terminou em 1.442 ms com cinco eventos textuais; 1.000 deltas com
barreira de item terminaram em 4.419 ms, preservando os 1.000 eventos.
Ambos recuperaram exatamente 1.000 caracteres do journal. Isto e uma medicao
sintetica unica, incluindo startup, persistencia e recovery; nao e p95 nem
percentual de aceleracao do produto. Arquivos native-stream-coalesced-burst.json
e native-stream-coalesced-burst_barriers.json registram os valores brutos.

A segunda parte implementa credito explicito por consumo. ProviderStart tag 15
(consumption_ack_required) habilita a janela de um evento nao terminal. O runner
nativo sempre habilita essa janela. ProviderEventConsumed (FramePayload tag 47)
retorna identity, operation_id e event_sequence somente quando o evento sai da
fila do runner. O Host valida a sequencia exata antes de liberar o proximo envio.
Esse recibo nao confirma persistencia nem efeito; os ACKs duraveis existentes
continuam obrigatorios. O protocolo anterior sem a flag permanece legivel.

A fila nativa com credito aceita um evento de dados e reserva mais um slot
somente para terminal que concorra com cancelamento. Consumidor lento nao trava
a faixa de escrita dos recibos de persistencia. Cancelamento interrompe a espera
de credito; um unico ACK ja em transito pode ser retirado depois do terminal,
sem permitir novo evento. ACK com identidade/operacao/sequence divergente e
rejeitado. O Host conserva no maximo uma autoridade de credito ja encerrada.

A regressao fisica depois dessa mudanca passou com 58 testes em seis arquivos,
incluindo 1.000 fragmentos, barreiras de item, provider de 125 segundos, tool
longa, prazo durante aprovacao, MCP HTTP/SSE/stdio e retomada sem replay.
Os cenarios finais registraram 763 ms/cinco eventos e 5.379 ms/1.000 eventos;
nao compare esses tempos como p95 ou como ganho isolado de credito, pois sao
amostras unicas com caches e concorrencia locais. Logs/JSON: native-stream-credit-physical.txt,
native-stream-credit-burst.json e native-stream-credit-burst_barriers.json.

Passaram 45 testes Host de stream/transporte, 30 de contratos e 670 no workspace
Rust (16 ignorados), alem de TypeScript/aliases, Clippy all-targets/all-features
com -D warnings, LOC de 875 modulos e grafo de 12 crates/17 arestas. Logs com
prefixo native-stream-credit- em scratch/harness-20261003.

O teto de 65.536 identidades por conexao ainda exige rotacao autenticada ou
encerramento duravel antes de esgotamento para attempts muito extensas;
nenhuma protecao de replay foi relaxada aqui. Soak, p95 e certificacao de
consumidores lentos no aplicativo continuam gates distintos.

O pacote com agrupamento e credito passou no fluxo nativo completo em 42,64 s
(native-stream-credit-native-packaged/report.json), recuperando sete attempts
e 18 mensagens sem provider replay. O legado com MCP stdio passou em 23,60 s
(native-stream-credit-legacy-packaged/report.json). Nenhum PID de teste restou.
Captura fonte 2026-10-06T08-34-43-646Z; manifest SHA-256
5331b340c9eaa355cf481c9b2f6a774a98141860eff8883e646a5b783e0f9736.
ASAR 71166b79722093dd14242e1b7f71b960f645fd2e11b18f0dd938b7237fc3ae66;
EXE 1d0f34dbb380168bcc9bc832bc3fa2a17dc4cd99c08212c94c4642f1da9731ab.
O pacote nativo usa build runtime-v1-840d12ee92d05082686d618f7dc3ce38da766c1f7e527d0fd49c8bddab2d8520,
manifest 9f9540b434b6abe2f317d9ee375b0b7d8b9763c8d96560eeb4a6c1f88cb4169e.
O build do dashboard tambem passou (native-stream-credit-dashboard.txt).


## Renovacao da autoridade fisica — 2026-10-06

O Coder nativo separa o deadline imutavel da tarefa do lease renovavel do
executor. A ausencia de maxWallMs usa um teto explicito de 24 horas, alem de
um segundo reservado para confirmacao terminal; nao significa duracao ilimitada.
A ativacao ainda exige lease vivo. O gateway recebe o orcamento selado para
nao rejeitar esse prazo pelo seu limite generico anterior de 30 minutos.

UpdateAttemptAuthority usa o canal Management existente. O supervisor valida
identidade/fence, launch duravel, lease atual vivo, chave idempotente e hard
deadline inalterado; a renovacao apenas atualiza o watchdog do launch.
Cancelamento/expiracao nao ressuscitam por update; ACK perdido exige reap.
O Host acompanha separadamente a ultima expiracao confirmada fisicamente.
Consulta o ledger a cada no maximo 30 segundos, sem sobrepor renovacoes;
resultado atrasado nao altera um lease ja expirado. Cancelamento Control nao
aguarda renovacao; o comando Management subsequente e serializado com ela.

Os testes fisicos curtos passaram com 61 casos em sete arquivos, incluindo
lease inicial de oito segundos, provider de dez segundos, renovacao aceita
e ausencia de renovacao impedindo conclusao tardia. A primeira tentativa de
610 segundos falhou em 258 segundos: o Host Control consumia sua cota vitalicia
de identidades a partir de maxIpcFrames=256. Host e runner Control agora usam
65.536 identidades, independentemente de creditos simultaneos; 1.000 heartbeats
consecutivos passam e um replay antigo continua rejeitado apos sair da janela.
A repeticao passou: 613,39 segundos de teste fisico, um unico provider chamado,
historico terminal recuperado e lease de workspace liberado
(native-authority-ten-minute-fixed.txt). Os 14 casos ignorados nesse comando
sao os demais cenarios excluidos pelo filtro, nao validacoes contabilizadas.

Evidencias em scratch/harness-20261003: native-authority-complete-physical.txt,
native-authority-ten-minute.txt (falha reproduzida), native-authority-control-ids.txt
(44 testes), native-authority-control-rust.txt (151 testes do runner),
native-authority-rust-workspace.txt (691 testes, 16 ignorados) e
native-authority-clippy.txt. TypeScript/aliases passaram apos a correcao Control.
O suite Host passou 469 testes e encontrou uma expectativa desatualizada do
export explicito tool-result.js; corrigida a whitelist, os dois testes da API
publica passaram. A proibicao de wildcard e de primitivas internas permanece.

Esta fatia nao certifica duracao de 24 horas: limites vitalicios de canais,
rotacao/terminal antes de esgotamento e soak continuam abertos. Company e
subagentes ainda nao recebem essa composicao. Default e cohorts de producao
permanecem no runtime certificado.

O pacote final passou no fluxo nativo completo em 45,11 s e no legado com
MCP stdio em 25,70 s. Sete attempts e 18 mensagens foram recuperadas no restart,
sem provider replay nem PIDs de teste restantes. ACK de cancelamento nativo
34,46 ms e cleanup 362,78 ms sao amostras unicas, nao p95. Relatorios:
native-authority-native-packaged/report.json e native-authority-legacy-packaged/report.json.
ASAR a0513fe07c719d092c110ac2166595cd90c08d1475face242a725aa4f804f389;
EXE cf83ccda273a8b805ba66851c3e1cfc78fa64f3df8a568295dbb9a994e9400e5.
Build nativo runtime-v1-c4188391d23122d67ed7acf57afeba86a89518c68430f0f7ec008310cde594fc,
manifest 6564243ab50ee81fc977602201367925803452a6de5d81782e5337b5633dcee4.
Captura fonte 2026-10-06T09-28-27-805Z, manifest
022ba8f2e5e96303e32289d1e5d2340dc35c08f870249a61e6371ff0ea3643b8.

Os probes de desempenho release com a feature isolada performance-harness
passaram: startup ate AttemptPrepared p95 55,949 ms, 10 aquecimentos/100
amostras; executor de leitura 4 KiB p95 0,215 ms, 100 aquecimentos/1.000
amostras. A leitura inclui validacao, dispatch, filesystem e encoding, mas
exclui IPC Host, policy e journal. Startup nao inclui composicao do produto,
UI nem provider. O probe nao substitui os executaveis empacotados. Logs
native-authority-startup-perf.txt e native-authority-dispatch-perf.json.
Clippy final, 880 modulos no limite de LOC e grafo de 12 crates/17 arestas passaram.

## Encerramento antes do limite de canal — 2026-10-06

O runner produtivo reserva 8.192 identidades Data para encerrar o stream,
confirmar efeitos ja admitidos, gravar o proximo checkpoint e o terminal.
Antes de abrir outro provider, a mesma fronteira salva o contexto sem abrir
stream nem resolver credenciais. Durante streaming, ProviderCancel e o consumo
limitado da cauda precedem o terminal `ipc_identity_budget`. Recibo terminal
corrompido ou peer que nao encerra continuam falhando de forma fechada.

Control e Management expoem contagens dos identificadores efetivamente
confirmados, incluindo tombstones e reserva pendente. A composicao nativa
observa essas contagens a cada segundo e sinaliza o gateway antes do limite.
A reserva e limitada a 8.192/1.024, reduzida para canais negociados menores.
Isso interrompe um provider ativo ou impede abrir o proximo apos confirmar
sua fronteira. No produto, a sinalizacao tambem cancela interacoes e ferramentas
pendentes; uma mutacao remota incerta continua exigindo reconciliacao.
Autoridade, deadlines e protecoes de replay permanecem independentes.
Nao existe rotacao de canal nem continuidade ilimitada na mesma attempt.

A retomada reconstrui texto/thinking confirmados depois da ultima fronteira.
A primeira prova fisica encontrou uma falha: o scanner de recovery ignorava
registros CONVERSATION. Ele agora valida tambem sua classificacao e entrega
conteudo autenticado ao observador. A comparacao de digest continua exigindo
historico exato; conteudo atravessando ferramenta sem checkpoint nao e aceito.
Uma interrupcao anterior a abertura do provider nao cria mensagem vazia;
uma fronteira com uso faturado mantem sua contabilizacao.

Evidencias em scratch/harness-20261003:

- native-channel-budget-resume-physical.txt: falha de retomada reproduzida.
- native-channel-budget-resume-fixed.txt: stream com ate 45 mil fragmentos
  distintos encerrado antes do limite, texto parcial recuperado e uma nova
  attempt concluida sem repetir ferramenta; 144,96 s de teste fisico.
- native-channel-budget-management-verified.txt: cota Management negociada
  de 16 identidades, renovações confirmadas, interrupcao duravel e Exited/Reaped
  antes do esgotamento; 1,47 s de teste fisico.
- native-channel-budget-host-complete.txt: 477 testes Host passaram, 28
  ignorados; native-channel-budget-counters.txt: 54 passaram, incluindo
  contadores Control/Management e texto parcial com uso sem texto.
- native-channel-budget-workspace.txt: 692 testes Rust passaram, 16 ignorados;
  native-channel-budget-clippy.txt e native-channel-budget-loc.txt passaram
  (882 modulos produtivos dentro do limite).
- native-channel-budget-settled-build.txt e native-channel-budget-dashboard.txt:
  TypeScript/aliases e dashboard passaram.

Os testes Control incluem contagem autenticada e acionamento do limite;
nao sao uma execucao fisica de 65 mil heartbeats. Soak de 24h, pressao de todos
os canais simultaneamente, consumidor lento no pacote e canario seguem como
gates separados. O adapter OSS nao foi promovido por esta mudanca.

A suite fisica ampliada passou com 61 casos e tres ignorados em oito arquivos
(native-channel-budget-complete-physical.txt). O pacote nativo passou em 42,63 s,
recuperando sete attempts e 18 mensagens sem provider replay; o legado com
MCP stdio passou em 22,93 s. Ambos terminaram sem PIDs de teste restantes:
native-channel-budget-native-packaged/report.json e
native-channel-budget-legacy-packaged/report.json. Captura fonte
2026-10-06T10-16-43-999Z, manifest SHA-256
2c9db2a77b711396fee7289f2e0b3dc00e58b90278e5cb348539a2cc9ea5f773.
Build nativo runtime-v1-679f8983468e67e6d79e755f9280ea134f808c0bfc33f0fab2e3d6d2decb2783,
manifest 074d77cf8aee5c235ddfb8035c8c440a8b781912f0afcd8b913623ba41dd2b2f.


## Worktrees no fluxo nativo e metadados atualizados — 2026-10-06

A preparacao do Coder agora resolve uma worktree antes de fixar cwd, prompt,
snapshot recorder e ambiente da attempt. Criacao e verificacao Git usam
NativeShellPort com Job Object, deadline e reap. O writer persiste o caminho;
reabertura valida o registro Git, a raiz gerenciada e o repositorio comum.
Nao ha fallback para a arvore principal quando a worktree desaparece ou muda
de proprietario. Falha ao persistir preserva a arvore criada.

A primeira execucao empacotada encontrou um defeito real: o worker gravava
worktree_path, mas o catalogo do processo principal devolvia o valor anterior.
A consulta do historico nativo agora atualiza session/state de forma assincrona,
sem abrir outro writer e sem reler o journal. A leitura de metadados tem limite
de 8 MiB por arquivo e rejeita identidade/schema divergente.

Evidencias em scratch/harness-20261003:

- native-worktree-final-physical.txt: seis testes fisicos de worktree/filesystem
  passaram. native-worktree-recovery-physical.txt acrescenta repositorio alheio,
  cancelamento anterior ao Git e falha de persistencia com arvore preservada.
- native-worktree-metadata-tests.txt: 53 testes de session storage passaram;
  dois stores independentes comprovam a atualizacao sem leitura sincrona de
  session/state e sem leitura do journal.
- native-worktree-native-packaged/report.json: falha do catalogo reproduzida.
- native-worktree-metadata-native-packaged/report.json: corrigido; 31,24 s,
  escrita aprovada somente na worktree, nova mensagem na arvore persistida e
  recovery apos restart. Nenhum PID de teste remanescente.
- native-worktree-legacy-packaged/report.json: legado + MCP stdio passou em
  24,13 s no mesmo pacote, tambem sem processos remanescentes.
- ASAR desse pacote: 9bcd8bb5f03987229f5433e33d8048bf3dd0c3428a67581b840d29493868a0be.

Escopo atual: worktree local Windows no inicio/reabertura da sessao, para
projeto registrado na raiz Git. Troca de worktree durante uma attempt,
projetos registrados em subdiretorios Git, container/remote/E2B e rollout
certificado continuam pendentes. O runtime padrao permanece legacy_ts.


## Exclusao entre geracoes no cohort de desenvolvimento — 2026-10-06

WorkspaceRuntimeScope envolve a preparacao comum de runCoder e
prepareCoderExecution, incluindo as entradas CLI e Company que usam esse
ponto. A reserva inclui raiz principal, projetos ligados e grants externos;
novos grants precisam ampliar a reserva antes da ativacao. Contextos de
subagentes herdam o mesmo scope. Arvores sobrepostas nao podem admitir
geracoes diferentes. Concorrencia dentro da mesma geracao continua sujeita
a autoridade especifica desse runtime.

A barreira usa autoridade duravel limitada por perfil, sem expiracao automatica
de writers. Libera somente depois da conclusao e dos handlers pendentes.
Resultados incertos e capabilities legadas sem prova de contencao/encerramento
mantem a reserva. Isso inclui shell, plugins e operacoes de classificacao
insuficiente; a promessa JS concluida nao prova a morte dos descendentes.

A ativacao continua de desenvolvimento: CODESTUDIO_NATIVE_CODER_DEV=1 ou
CODESTUDIO_RUNTIME_COHORT_GUARD=1. A existencia da autoridade no perfil faz
novos processos legados/CLI respeitarem as reservas mesmo com a flag desligada.
Ativacao em perfil com processos anteriores ja abertos exige drain; essa
transicao ainda nao esta certificada. Perfis diferentes, reconciliacao de
processos legados persistentes, recuperacao de transaction.lock interrompido
e migracao Company/subagentes inteiramente para Rust continuam pendentes.
Nenhum lease retido foi liberado com base apenas em PID, tempo ou restart.

O teste empacotado encontrou dois defeitos no caminho de recusa: erro HTTP
generico e corrida entre a leitura do estado e a terminalizacao duplicada
da API. Agora o conflito tem codigo WORKSPACE_RUNTIME_CONFLICT e HTTP 409.
O observador HTTP preserva, dentro da fila da autoridade, o terminal ja
confirmado pelo worker; gravacoes normais continuam rejeitando motivo divergente.

Evidencias em scratch/harness-20261003:

- runtime-cohort-complete-tests.txt: 103 testes em 13 arquivos passaram.
- runtime-cohort-rollout-tests.txt: dez casos de concorrencia, raiz sobreposta,
  extensao de grant, retencao, corrupcao e ativacao passaram.
- runtime-cohort-terminal-race-tests.txt: 21 casos passaram, incluindo a corrida
  da terminalizacao, preservacao da rejeicao estrita e heranca do subagente.
- runtime-cohort-worker-pool-tests.txt: 29 testes do pool passaram.
- runtime-cohort-benchmark.json: 100 transacoes apos dez aquecimentos; admissao
  p50 7,28 ms / p95 8,43 ms; liberacao p95 8,19 ms. Mede somente a reserva
  local, excluindo provider, runner, Git e Electron; nao certifica startup total.
- native-worktree-metadata-bounds-tests.txt: cinco casos passaram, incluindo
  metadados invalidos/maiores que 8 MiB sem retornar o catalogo desatualizado.

Os primeiros relatórios runtime-cohort-native-packaged e
runtime-cohort-legacy-fixed-packaged registram falhas anteriores as correcoes;
nao sao evidencias de certificacao. O fechamento do pacote desta fatia deve
constar nos relatórios finais e no candidato fonte correlacionado abaixo.

Fechamento do pacote desta fatia:

- runtime-cohort-native-final-packaged/report.json: passou; Rust ativo recusa
  entrada legada com HTTP 409 antes do provider, worktree persiste/reabre e
  recupera apos restart; MCP stdio conserva a reserva de efeito incerto.
- runtime-cohort-legacy-final-packaged/report.json: passou (29,62 s); legado
  ativo recusa Rust antes do provider. Nenhum erro de terminalizacao duplicada.
- Ambos usam ASAR bafdc384c1520a8a339a0866a5c09dd4b06e79a018a2465eb83cb22222385227
  e executavel a96bdefc5a315e3241d116f29ea8056e4670fe990376658c0aaccd7d5f34380d.
  Provider local deterministico; estes resultados nao medem provider real
  nem promovem o cohort de desenvolvimento a runtime padrao.

## Comandos persistentes contidos — 2026-10-06

O cohort Coder passa a expor exec_command, write_stdin e list_sessions com
um registro exclusivo da attempt. A porta Host reutiliza o transporte duplex
Rust com Job Object; cada spawn/escrita revalida o fence na fronteira fisica.
As sessoes podem atravessar chamadas ao provider, mas nao atravessam o fim
da attempt. close cancela e aguarda os recibos fisicos de todos os donos,
mesmo se outro dono rejeitar sua limpeza.

stdout e stderr chegam enquanto o processo esta aberto, por chunks tipados
e decoders UTF-8 separados. O transporte tem fila limitada; a captura mantem
inicio/fim com contagem de bytes omitidos e cede o event loop a cada 6 ms.
Ha no maximo 16 sessoes por attempt, 1 MiB por entrada, captura de ate 800 KiB
por sessao e timeout de inatividade de dez minutos, dentro do deadline da
attempt. O novo campo de feature duplexOutputVersion impede expor comandos
persistentes sobre um pacote antigo que nao possua saida tipada.

Uma escrita sem confirmacao registra efeito incerto, cancela o processo,
recusa novas entradas nessa sessao e conserva a autoridade do workspace.
Nao ha reenvio automatico. O catalogo exige metadata nativa, efeitos
sequenciais e listagem explicitamente somente leitura.

A validacao encontrou uma corrida real no recibo do transporte duplex:
com a fila cheia, cancelamento podia fechar stdout e causar EPIPE no filho
antes do monitor consultar novamente o sinal. Dois dos doze casos em
native-persistent-cancel-stress-before.json terminaram com cancelled=false,
embora todos estivessem reaped. O monitor agora consulta o cancelamento
tambem ao observar a saida do processo. A prova subsequente fica nos
relatorios de stress e fisicos abaixo. Um fixture Rust tambem passou a
aguardar evidencia de criacao do descendente, em vez de dormir dois segundos.

Evidencias em scratch/harness-20261003:

- native-persistent-unit.txt: 41 testes passaram antes da ampliacao do catalogo.
- native-persistent-regression.txt: 509 testes passaram, 28 ignorados, incluindo
  suites Host e ferramentas legadas. Nao substitui os testes de processos reais.
- native-persistent-final-contract-tests.txt: 18 testes de porta/catalogo passaram.
- native-persistent-rust-all.txt: 678 testes Rust passaram, 16 ignorados, com
  --all-targets; a correcao posterior de cancelamento tem validacao focada em
  native-persistent-cancel-rust-fixed.txt e Clippy em
  native-persistent-cancel-clippy-fixed.txt.
- native-persistent-physical-fixed.txt: cinco casos passaram, incluindo
  conversacao com aprovacao por efeito e cancelamento entre turnos.
- native-persistent-final-physical.txt registra a reproducao ainda anterior
  a correcao do recibo de cancelamento; nao deve ser tratado como gate aprovado.

PTY/ConPTY, terminais de servidor que sobrevivem a uma attempt e reconexao
em um processo vivo depois de crash ainda nao estao implementados. tty=true
retorna indisponibilidade explicita. Esta entrega cobre sessoes pipe, sem
promover Rust a runtime padrao ou retirar a implementacao legada.

Fechamento do candidato de comandos pipe:

- native-persistent-cancel-stress.json: 12/12 cancelamentos corretamente
  classificados e reaped; maior intervalo local cancel-to-receipt de 20,77 ms.
  E uma amostra de componente, nao a certificacao p95 de cancelamento da aplicacao.
- native-persistent-certified-physical.txt: 18 testes fisicos passaram em seis
  arquivos; o nome do arquivo nao significa certificacao global de rollout.
- native-persistent-final-packaged/report.json: passou em 49,15 s. Exercita
  anexos, imagens, skills/memoria, Git, MCP stdio, interrupcao/continuacao,
  exclusao entre geracoes e restart. A sessao persistente teve tres aprovacoes,
  quatro chamadas ao provider local, stdin entre turnos, stderr ao vivo e
  historico recuperado. Todos os PIDs rastreados foram encerrados.
- Pacote Rust: runtime-v1-17459ab60e905db50f84668af6ce6d47495228ba188c3895418425030f59242e.
  Manifest SHA256: b60a2fa61859f7e115b7ebd4fbc4d181a393546ee34e54898d35dc41538cdf2b.
- ASAR: 8be07fb54e70fa3cc41ae781e9ca6c0d430b4f92875ade4603ed92af29b09138.
  Executavel: 1042e49a8ab92a19cc2d105f97c04e0621f476aa5d92521bb2de00f2866d7b65.
- Typecheck e aliases passaram em native-persistent-catalog-build.txt.
  Limite estrutural: 884 modulos de producao dentro de 250 linhas.
- native-persistent-legacy-packaged/report.json: legado no mesmo pacote passou
  em 24,19 s, com MCP stdio e bloqueio da geracao Rust concorrente antes do
  provider. Nenhum processo Electron/MCP rastreado permaneceu vivo.
- Candidato fonte: scratch/harness-candidates/2026-10-06T11-52-14-056Z/manifest.json,
  SHA256 6a887f8c5f499c621f45a75c87fe9e4ab4e142b22b4eb7556f3e6591124ebe99.
  HEAD 2d24020c28785bf181c178c72b9eaea8c1bfcdea; inclui patch tracked e 313
  arquivos nao rastreados. O manifesto de superficies recebe apenas a
  referencia a esta captura depois dela, sem alterar o candidato de codigo.

## Terminal ConPTY no pacote Windows — 2026-10-06

tty=true agora cria um console virtual nativo, com tamanho validado, entrada
UTF-8/VT e stdout/stderr na mesma tela. O processo inicia suspenso dentro do
Job Object, assim como nas sessoes pipe. Fechar a attempt cancela e aguarda
a limpeza; nenhum identificador de console cru atravessa a ABI Host.

A primeira prova fisica detectou heranca indevida de stdout redirecionado do
host. STARTF_USESTDHANDLES com handles nulos permite que ConPTY instale seus
handles de console. Os endpoints de criacao ficam vivos ate CreateProcess.
ClosePseudoConsole roda em worker separado enquanto a saida e drenada, evitando
que o encerramento espere um leitor bloqueado pela fila cheia.

Evidencias em scratch/harness-20261003:

- native-pty-rust-physical-fixed.txt: terminal real interativo e cancelamento
  com consumidor parado passaram. A falha anterior foi preservada.
- native-pty-clippy-final.txt: Clippy workspace/all-targets sem warnings.
- native-pty-unit.txt: 19 testes da porta/catalogo passaram.
- native-pty-physical-final.txt: 12 testes fisicos passaram, incluindo modo
  pipe, dimensoes 90x25, stdin, cancelamento e descendentes.
- native-pty-typescript-final.txt: typecheck/aliases passaram. O limite de
  250 linhas permanece valido em 888 modulos Rust de producao.
- native-pty-packaged/report.json: pacote passou em 50,57 s com provider
  local, PTY 100x32, tres aprovacoes e quatro chamadas ao provider na sessao
  interativa. Tambem cobre Git, imagens, skills/memoria explicita, MCP stdio,
  cancelamento/continuacao, exclusao entre geracoes e oito checkpoints apos
  restart, sem replay. Todos os PIDs rastreados foram encerrados.
- Pacote Rust: runtime-v1-8a4c0040384ae5f6ccb31d3b087815880028750d6748d947aa0466fa31072432.
  Manifest SHA256: ca305da1b6d650f854906713c1f0b2d11d9e69cd0cf64e68262ba019c74deae5.
- ASAR: 87c8faf4b71f5591ba84e5fc0f9e0804536d0919fa3eecbab512ba9fdee4f4e9.
  Executavel: 05aa880fbfcd391397b6ee2b723db77f2900e3ae472ddca1830dbae73096877f.
- Fonte: scratch/harness-candidates/2026-10-06T12-21-43-821Z/manifest.json,
  SHA256 10474e80d96b3e6084ae2179e4637bd565f644324afbb87e2745c1de220d5ed8.

A primeira suite TS executada durante compilacao concorrente falhou porque a
fixture exigia prompt dentro de uma janela fixa. O teste agora consulta a
sessao enquanto o processo inicia, com limite de tentativas. O candidato final
foi validado sem recompilacao concorrente. Isso nao certifica servidores que
atravessam attempts, reconexao viva, soak/canario nem muda o default legacy_ts.

## Contexto proativo na fronteira nativa — 2026-10-06

Memoria de projeto e capitulos relevantes sao preparados pelo gateway antes
de cada fronteira do provider. A tarefa aguarda no maximo 300 ms uma unica
vez; a busca continua e seu resultado so pode entrar na proxima fronteira.
Checkpoint nao dispara busca nem consome resultado tardio. A porta respeita
ignore-memory, limita quantidade/bytes e vincula o contexto ao SHA256 da
mensagem original. Retomada preserva o contexto confirmado sem refazer recall.

O frontier duravel registra os bytes efetivamente enviados antes da abertura
do stream. O digest do pedido do runner continua identificando seu pedido
original; o frontier autentica separadamente o enriquecimento feito no Host.
Ao mudar contexto anterior, previousResponseId e invalidado para que o provider
receba esse historico atualizado. Cancelar encerra a autoridade de aplicacao;
o RPC de memoria ja iniciado ainda pode concluir ate seu timeout de 10 segundos.

Evidencias em scratch/harness-20261003:

- native-boundary-rust-all.txt: 682 testes Rust passaram; 16 ignorados
  explicitamente. Clippy workspace/all-targets passou em native-boundary-clippy.txt.
- native-boundary-host-regression.txt: 478 testes passaram em 62 arquivos.
  native-boundary-unit-fixed.txt: 35 passaram; native-boundary-regression.txt:
  75 passaram; native-boundary-contract-final.txt: 22 passaram.
- native-boundary-physical-recovery.txt: 10 testes com processos reais passaram.
  A primeira chamada iniciou antes do recall e a seguinte recebeu seu resultado;
  cancelamento preservou esse conteudo no checkpoint de continuacao.
- native-boundary-build-final.txt: TypeScript/aliases passaram. Limite de
  250 linhas passou em 891 modulos de producao.
- native-boundary-packaged/report.json: passou em 69,73 s. Memoria semeada no
  servico real do aplicativo chegou ao contexto do provider local. Tambem
  confirmou PTY, aprovacoes, Git, imagens, MCP stdio, retomada, exclusao entre
  geracoes e oito checkpoints recuperados sem replay. PIDs rastreados encerrados.
- native-boundary-legacy-packaged/report.json: fallback no mesmo pacote passou
  em 30,34 s; efeito remoto incerto permaneceu bloqueado e nenhum PID rastreado
  ficou vivo. Tempos totais nao sao comparacao de desempenho entre candidatos.
- Pacote Rust: runtime-v1-8c4f479d04a1531e54d7b50efe1d1ad2c136b32c20aadcd497f804c73105f157.
  Manifest SHA256: c2db7dfe09a6613c1295c0d1d4aec892376659da9568904506486c4ba4580b4a.
- ASAR: 88c3860705ce2e373d26b8ac469f31132078561d6835910aee67144a1732bf4f.
  Executavel: 48104f69ce840b173637b865c4958c9ae51ee9346ad397b8a2c23b53d025a3e8.
- Fonte: scratch/harness-candidates/2026-10-06T12-43-56-275Z/manifest.json,
  SHA256 06799db758cb57fc0d0cd9622d69cb762b86852161e1f414b7053c2ff5911fe3.

Esta entrega nao implementa compaction nativa, metas/tarefas/hooks, Company ou
subagentes. Esses gates, comparacao com provider real, soak e canario continuam
abertos; o runtime padrao permanece legacy_ts.

## Historico com transporte limitado por consulta — 2026-10-06

O leitor informa ao writer qual janela ou estatistica precisa. A selecao ocorre
antes de MessageBridge/MessagePort: tail, pagina anterior, faixa de capitulo,
mensagem individual, usuario anterior e contagens nao transportam mais toda a
conversa. O projector incremental tambem deixa de copiar os arrays completos
a cada recibo quando a consulta pede apenas uma janela. Leituras completas
continuam disponiveis para os consumidores que precisam delas.

Cursores, mensagens de ferramenta e limites de arquivo mantem o contrato
anterior. A validacao de autoridade e integridade do journal permanece no
writer/reader nativo. O legado reutiliza sua projecao hidratada e preserva a
reconciliacao de capitulos em caso de crash antes da atualizacao de state.json.

Evidencias em scratch/harness-20261003:

- native-history-query-build-clean.txt: TypeScript e aliases passaram.
- native-history-query-physical.txt: quatro testes com runner real passaram,
  incluindo consultas no writer ativo, anexos, memoria e recuperacao.
- native-history-query-packaged/report.json: passou em 51,09 s. Tail, contagem,
  pagina anterior e usuario precedente coincidiram com o transcript completo
  durante o provider e apos restart. Oito checkpoints foram reconciliados sem
  replay. Nenhum PID rastreado ficou vivo.
- native-history-query-legacy-packaged/report.json: fallback legado no mesmo
  pacote passou em 27,17 s, com exclusao de geracoes e MCP stdio.
- native-history-query-transport.json: benchmark sintetico MessagePort com
  100/1.000/10.000 turnos e dez amostras por caso. Para 10.000 turnos, a copia
  completa transferiu 16.846.697 bytes JSON equivalentes (p95 117,53 ms); tail
  de dez mensagens visiveis transferiu 5.614 bytes (p95 0,0374 ms); contagem,
  126 bytes (p95 0,0063 ms). E uma medida do componente de transporte, sem
  journal, provider, renderizacao ou certificacao de uma sessao nativa real
  de 10.000 turnos.
- ASAR: aa9092b16cbd1f6fa8c59fa14ce6437d11b27de217d57b942eb8b24128069c2a.
  Executavel: 81eba0ecda915a928a80c6598d5bfe6410f605aa802d6f8eadfe0f979d3e2b37.
  Binarios Rust iguais ao candidato de contexto proativo acima.
- Fonte: scratch/harness-candidates/2026-10-06T13-04-19-230Z/manifest.json,
  SHA256 1ae1b21ea64f2462b4ba19320327d98ebc8716b86c18d353d882e3d81f8b0527.

Reabertura ainda precisa reconstruir sua primeira projecao. Compaction nativa
e prova de 10.000 turnos reais continuam gates separados; esta entrega fecha
o transporte paginado do Coder Windows em desenvolvimento.

## CLI e MCP publico pela fachada — 2026-10-06

A CLI deixa de iniciar runCoder diretamente. Usa os endpoints do produto em
um gateway interno sem porta de escuta, conservando provider/modelo da sessao,
opcoes, retomada, output progressivo e aprovacoes. SIGINT/SIGTERM pedem cancelamento;
o codigo de saida depende do recibo terminal e o comando aguarda shutdown.
Uma retencao explicita do event loop evita a saida 13 do Node enquanto servicos
com timers unref ainda estao drenando. Commander usa argv de Node explicitamente.

O MCP publico consome SSE incremental com limites de tamanho e tempo de
processamento. Nao acumula response.text() de toda a execucao, nem interpreta
HTTP 200/EOF como sucesso. start/list/get/result/cancel preservam conclusao,
falha e cancelamento, inclusive apos restart, usando recibos do journal e do
produto. O transporte stateless cria uma instancia do SDK por requisicao.
Admissoes que compartilham quota sao serializadas; metadados e abort possuem
timeout. Cancel ACK e resultado final sao distintos: CLI/MCP reanexam o stream,
validam sua identidade quando conhecida e aguardam o terminal; resposta perdida
nao autoriza reenviar o comando.

O pool pede o drain antes de revogar a autoridade do worker. A limpeza nativa
tambem ocorre quando o provider falha; liberar o workspace exige reap fisico
e efeitos locais drenados. Efeito externo incerto continua retendo o lease.

Evidencias do primeiro pacote desta etapa, em scratch/harness-20261003:

- native-cli-mcp-terminal-regression.txt: 110 testes passaram em 14 arquivos.
  O teste de higiene foi atualizado para a API assincrona existente; os testes
  SQLite usaram Electron ABI 146, sem rebuild de dependencias.
- native-cli-mcp-terminal-build.txt: TypeScript/aliases passaram.
- native-cli-mcp-terminal-development/report.json: passou em 118,57 s. Cinco
  processos CLI reais: conversa (0), mesma sessao retomada (0), escrita aprovada
  (0), cancelamento (130) e erro do provider (1). MCP publico completou, cancelou
  e falhou com as mesmas classificacoes depois do restart. Onze checkpoints
  recuperados sem provider replay; nenhum PID rastreado permaneceu vivo.
- native-cli-mcp-terminal-packaged-scoped/report.json: passou em 53,70 s.
  MCP publico e externo stdio, PTY, filesystem/Git, imagens, memoria proativa,
  continuacao, consultas de historico e restart no mesmo pacote. Onze checkpoints
  recuperados; 17 mensagens; zero replay e zero PID rastreado vivo.
- native-cli-mcp-terminal-legacy/report.json: fallback passou em 33,40 s,
  com isolamento de geracoes e MCP stdio no mesmo pacote.
- ASAR: 6520d6c275891f7c8eb271d57988eb1f5478aae46ad27885eb6f7b97fd600bd8.
  Executavel: 74af8a7c05e9a12ce3ff79ac3f2c5a823238a150a3f01a4b0e732559f92b37e7.
- Fonte: scratch/harness-candidates/2026-10-06T14-20-53-392Z/manifest.json,
  SHA256 d651f83ee914956ab500d77d0b729e88a2af0a9c111c528fc956832cae52863a.
  O fixture recebeu depois a correcao de escopo: imagens/skills da conversa
  principal nao sao exigidas da conversa independente iniciada pelo MCP.

Falhas anteriores permanecem registradas: CLI encerrava antes do drain e
invalidava a autoridade; provider failure deixava lease exclusivo; o fixture
combinado exigia uma imagem de outra sessao. Nenhum relatorio reprovado foi
convertido em aprovacao ou apagado.

A CLI usou o entry point compilado real sob Electron como Node, com dependencias
do checkout. A distribuicao CLI independente sob Node e o Ctrl+C fisico do
console Windows ainda precisam de certificacao: o fixture dispara o handler
SIGINT por IPC. O pacote desktop nao inclui uma distribuicao CLI.
Perfis/ambientes/worktrees e interacoes ainda exigem a matriz completa da CLI.
Paridade global, provider real, soak, canario e retirada do legado continuam
abertos. Tempos acima sao duracao de testes funcionais, nao p95 nem ganho comparativo.

### Barreira final de limpeza

Uma revisao posterior moveu o drain Host para antes do terminal publico e da
transicao final do produto. O ACK de cancelamento continua independente.
Uma falha de limpeza produz native_host_cleanup_failed; historico e MCP nao
podem esconder essa falha sob texto completo ou pedido de cancelamento.
Enquanto apenas o engine terminou, o read model informa execucao ativa ate
o produto confirmar a limpeza. Efeitos remotos incertos continuam isolados.

- native-terminal-drain-physical-final.txt: 19 cenarios com processos reais
  passaram, incluindo barreira bloqueada, falha de limpeza e MCP incerto.
- native-terminal-drain-regression.txt: 114 testes passaram em 14 arquivos.
- native-terminal-drain-build.txt: TypeScript/aliases passaram.
- native-terminal-drain-packaged/report.json: passou em 57,01 s com a matriz
  combinada, 11 checkpoints recuperados e nenhum PID rastreado vivo.
- native-terminal-drain-cli/report.json: CLI/MCP e restart passaram em 115,93 s.
  native-terminal-drain-legacy/report.json: fallback passou em 36,02 s.
- ASAR desta revisao: 92180c2d2782a5c82ddd19a2b6f9ec1826def22a94304d7d8b46455ff68ba054.
  Executavel: 1ebe7c4b86c8857f0ddd402b4c0dde1dc16cba58db02aafb40571d07b76888af.
- Fonte: scratch/harness-candidates/2026-10-06T14-35-39-675Z/manifest.json,
  SHA256 2d15cfeb139a37661a53d799d7e4eea285878b8cc20be7f204ee074e0165d47c.
  Nenhum binario foi recompilado durante os E2Es deste candidato.

## Interacoes humanas na fachada nativa — 2026-10-06

ask_user, decision_gate e submit_plan usam uma porta de interacao independente
do CoderRunner. O slot e registrado antes da publicacao; a resposta atravessa
a fachada com a identidade duravel da chamada. Um ID incorreto e rejeitado
antes de consumir um recibo. O mesmo ID aparece no cartao ao vivo e no historico,
permitindo recarregar a interface enquanto o worker continua aguardando.

Aprovacao de plano exige persistir o veredito antes de liberar a politica de
escrita. Revisao e spec mode nao liberam essa politica. Falhas de persistencia
nativas deixam de ser ocultadas pelos callbacks herdados. HTTP, interface e CLI
carregam a identidade da interacao; sessao Rust sem seu owner nao recebe um
resultado sintetico legado. Recovery de uma pergunta apos crash do owner ainda
exige reconciliacao explicita e permanece pendente.

Os cartoes exibem falha de envio, preservam o rascunho e permitem reenvio. Durante
o envio, os controles ficam desabilitados. Uma resposta HTTP de erro nao marca
a pergunta/decisao como resolvida, e o plano restaura os controles.

Evidencias em scratch/harness-20261003:

- native-interactions-physical.txt: cinco cenarios com runner Rust real passaram:
  pergunta, decisao, aprovacao, revisao e cancelamento. Escrita anterior ao plano
  foi recusada; escrita posterior so ocorreu com aprovacao persistida.
- native-interactions-retry-build.txt e native-interactions-retry-dashboard.txt:
  TypeScript/aliases e bundle da interface passaram.
- native-interactions-retry-unit.txt e native-interactions-cli-unit.txt: 37 testes
  focados passaram; native-interactions-regression.txt: 87 testes em 13 arquivos.
  check-rust-agent-loc: 891 modulos dentro do limite.
- native-interactions-retry-development/report.json: interface passou em 65,45 s.
- native-interactions-packaged/report.json: matriz combinada passou em 85,47 s.
  Cinco casos pela interface real; pergunta, decisao e revisao foram recarregadas.
  Os quatro envios de resposta tiveram uma falha de transporte induzida antes
  do servidor, seguida de reenvio identico. Cancelamento nao retomou o provider.
  Dezesseis checkpoints recuperados sem replay; nenhum PID rastreado vivo.
- native-interactions-legacy/report.json: fallback no mesmo pacote passou em 25,62 s.
- ASAR: 2d82ce98ce71d58c840897eb9342d46674b2582d33f08a7c8a9f7ebdff6f7e8a.
  Executavel: 6e076c8b13f7d7363332cb2eb0e5ae05623c286c5480b08cfa8d3ba279629a43.
- Fonte: scratch/harness-candidates/2026-10-06T15-08-14-149Z/manifest.json,
  SHA256 24a08c32c462bbd822017e20841e1e3a17822ada05d851c4a46a1f5d78e4e573.
  Binarios Rust inalterados; pacote/compilados congelados durante os E2Es.

O primeiro E2E de desenvolvimento falhou no seletor ambiguo de Revisar, que
atingiu o botao da barra de arquivos; o fixture agora usa o cartao do plano.
O relatorio reprovado foi preservado. Esta etapa nao certifica spec/tasks/goals,
Company, subagentes, paridade completa da CLI, provider real, soak ou canario.

## Preparacao interrompida e ACK perdido — 2026-10-06

O worker agora aguarda o finally da preparacao antes de confirmar a liberacao
do writer. A barreira cobre o intervalo anterior a existencia do handle Rust.
O pool tambem distingue erro confirmado de um RPC cujo ACK se perdeu: neste
ultimo caso, solicita drain mantendo a autoridade. Se o drain nao for confirmado,
mantem a tentativa e impede substituicao. HTTP retorna CODER_STARTUP_UNCERTAIN
(503, sem retry automatico) e preserva o comando original; duplicatas reencontram
o bus original, sem novo dispatch nem terminal sintetico.

Evidencias em scratch/harness-20261003:

- native-preparation-stop-before-gated/report.json: reproduziu o bug no pacote
  anterior. Uma consulta MCP de preparacao permaneceu bloqueada enquanto o
  arquivo writer.lease desapareceu. O fixture nao executou um provider.
- native-preparation-stop-development/report.json: correcao passou em 44,43 s.
- native-preparation-ack-development/report.json: tres cenarios passaram em
  72,56 s: stop durante preparacao, ACK de inicio perdido e ACK de drain perdido.
  Writer mantido durante a barreira; zero chamadas do provider cancelado;
  novo worker concluiu duas chamadas na mesma sessao depois da reconciliacao.
- native-preparation-ack-unit.txt e native-preparation-ack-routes.txt: 61 testes
  passaram, incluindo idempotencia, retencao de autoridade e HTTP incerto.
- native-preparation-interactions-physical.txt: 22 testes com processos Rust
  reais passaram (interacoes, filesystem, worker e MCP).
- native-preparation-final-build.txt: TypeScript/aliases passaram.
- native-preparation-packaged/report.json: matriz combinada passou em 135,93 s,
  incluindo interacoes, arquivos, Git/PTY, MCP, anexos, memoria, continuacao e
  os tres cenarios de preparacao. Dezenove checkpoints recuperados sem replay;
  nenhum PID rastreado vivo.
- native-preparation-legacy/report.json: fallback no mesmo pacote passou em 27,04 s.
- ASAR: 22f3b102fb3bb527aa4e4b590faf32b82c3b4a1daacf79bb4c5800c815052178.
  Executavel: 3e9b9ff82690ab6e6720b020e9ba2e47f28516f1a28590bf36bfe897fccfcb6f.
- Fonte: scratch/harness-candidates/2026-10-06T15-26-19-098Z/manifest.json,
  SHA256 bbcfbb71c46e078422441a13adac68bd8aa03bbc8584a1147e30cd2ea39eedb6.

O primeiro fixture criou um worker inerte antes do caminho normal de admissao
e nao chegou ao ponto pretendido. Esse relatorio tambem foi preservado. A prova
valida intercepta somente a consulta MCP na criacao normal do worker, em perfil
isolado. Perda de ACK e induzida no transporte; nao simula crash do Electron nem
certifica todos os cenarios de falha de disco ou reconciliacao operacional.

## Consulta limitada de runs MCP — 2026-10-06

O MCP publico agora consulta metadados diretamente no catalogo, sem listar
todos os projetos nem hidratar metricas/transcricoes para ordenar a pagina.
O conjunto de candidatos fica limitado a 200; a varredura cede o event loop
apos 4 ms. Somente a pagina pedida carrega resultados, com concorrencia quatro.
Admissao consulta identidades ativas separadamente, incluindo sessoes antigas
fora da pagina recente. Falha de consulta nao libera a quota por omissao.

Evidencias em scratch/harness-20261003:

- native-mcp-query-unit-final.txt: 42 testes em quatro arquivos passaram.
  native-mcp-query-ranked-unit.txt: 30 testes passaram apos cachear os timestamps.
  native-mcp-query-storage.txt: 42 testes do catalogo e guard de storage passaram.
- native-mcp-query-ranked-build.txt: TypeScript/aliases passaram.
- native-mcp-query-ranked-benchmark.json: 20 amostras apos tres aquecimentos,
  com 100/1.000/10.000 sessoes. Para 10.000, pagina recente p95 2,71 ms,
  2.817 bytes; consulta de ativos p95 0,15 ms, 67 bytes. Mede apenas consulta
  sintetica em memoria, sem bootstrap do catalogo, disco, HTTP ou provider.
- native-mcp-query-packaged/report.json: pacote passou em 47,69 s; MCP publico
  start/get/list/result/cancel preservou completed/cancelled/failed apos restart.
  Sete checkpoints recuperados, zero replay do provider e nenhum PID rastreado vivo.
- native-mcp-query-legacy/report.json: fallback do mesmo pacote passou em 26,63 s.
- ASAR: 7913c0bbedd38d8d9124a355b1c910e7f41755eaf458e3eb72b534b698dcc374.
  Executavel: 17cfd3b876c1717320980b889f2cd8604149ad6aa384b29179f5e79b8d018738.
- Fonte: scratch/harness-candidates/2026-10-06T15-45-57-154Z/manifest.json,
  SHA256 a7b98e47c20976fa1db4d4df20aecf8db5d8faf63bc5758247ff9e8e53106a52.

A varredura ainda depende do numero de entradas do catalogo. O cache de runs
concluidos no manager MCP e a certificacao sob carga permanecem pendentes.

## Coordenacao de workspace entre perfis — 2026-10-06

Admissao de geracoes agora usa um ledger compartilhado pelo usuario do sistema,
independente de MCP_DATA_DIR, mantendo tambem o ledger do perfil para respeitar
workers anteriores. Apos ativacao, perfis com a flag Rust desligada tambem
participam. MCP_RUNTIME_COORDINATION_DIR permite uma raiz comum isolada nos
testes; todos os perfis participantes devem usar a mesma raiz.

Attempts nativas adquirem o lease compartilhado antes do lease do perfil.
Leituras podem coexistir; um escritor conflita com qualquer lease sobreposto,
inclusive entre perfis. Filesystem e MCP verificam ambas as autoridades antes
do efeito. A liberacao ocorre somente apos prova de cleanup, primeiro no perfil
e depois na raiz compartilhada. ACK perdido mantem ambas retidas. O bootstrap
carrega modulos fisicos antes de provisionar sua autoridade temporaria.

Evidencias em scratch/harness-20261003:

- native-cross-profile-development/report.json: um segundo processo/perfil,
  com flags desligadas, foi recusado durante uma attempt Rust ativa.
- native-shared-workspace-unit.txt: 41 testes em cinco arquivos passaram.
- native-cross-profile-physical.txt: primeira rodada teve 14/15; o primeiro
  launch a frio foi recusado pela validacao temporal. A rodada subsequente,
  apos antecipar o carregamento dos modulos, passou 15/15 em
  native-cross-profile-physical-retry.txt. Limites nao foram aumentados.
- native-shared-workspace-build.txt: TypeScript/aliases passaram.
  check-rust-agent-loc: 891 modulos dentro do limite.
- native-shared-workspace-packaged/report.json: matriz combinada passou em
  114,76 s; processos/perfis distintos foram recusados tanto para Rust/legado
  quanto para um escritor Rust diante de outro lease Rust. Interacoes,
  preparacao/ACK, arquivos, Git/PTY, MCP, anexos, memoria, continuacao e restart
  passaram; 19 checkpoints recuperados, zero replay e zero PIDs rastreados vivos.
- native-shared-workspace-legacy/report.json: fallback passou em 27,86 s,
  incluindo recusa de outro perfil Rust durante execucao legada.
- ASAR: fdcb0d68edd7f816160f61f2126b6bc3dce16fc90a063fcdd6e55647c30de5e7.
  Executavel: a1b5f6b69abd00c1e0cf56e8d515cdce3cb1613331fe5bda569484a51ec05a8f.
- Fonte: scratch/harness-candidates/2026-10-06T16-20-35-567Z/manifest.json,
  SHA256 09c5abc610b499f7414682c603213745d1eb5f005e85311d1e9eb6be2041c9a5.

Esta prova cobre processos usando a nova coordenacao. Ativacao exige drain de
processos anteriores que ainda nao participam dela; claims retidos e locks de
transacao do ledger de geracoes ainda precisam de reconciliacao operacional.
Nao houve instalacao/atualizacao do aplicativo do usuario nem promocao do default.

## MCP em worktrees e provisionamento tardio — 2026-10-06

A autorizacao de MCP comparava a pasta de execucao com a raiz original do
projeto e recusava worktrees validas. Agora o control plane confere o lease
exato contra o snapshot selado na preparacao duravel, junto da identidade da
attempt. Verificacoes do lease local/compartilhado, binding, input e owner
continuam imediatamente antes do efeito. Alterar raiz, epoch, prazo, acesso
ou attempt nao autoriza o despacho.

A falha temporal anterior reapareceu na primeira chamada a frio: antecipar o
import no adapter foi insuficiente porque a fachada ja havia provisionado o
launch. Admissao duravel e provisionamento fisico foram separados. A fachada
persiste a admissao antes de rotear, mas cria o launch uma unica vez, depois do
carregamento fisico, lendo novamente o lease do executor. Nenhum limite ou
deadline foi ampliado. O teste inclui atraso de 11 segundos no roteamento.

Evidencias em scratch/harness-20261003:

- native-worktree-mcp-before.txt: fixture invalido fora da pasta gerenciada;
  nao serve como prova do defeito.
- native-worktree-mcp-before-managed.txt: SSE e stdio executaram zero mutacoes
  em worktrees validas; HTTP falhou antes, na autoridade temporal do launch.
- native-worktree-mcp-authority-after.txt: 25 testes em tres arquivos passaram,
  incluindo os tres transportes, leases adulterados, ACK perdido, cancelamento,
  falha de drain e roteamento atrasado. Duracao 157,16 s inclui transforms TS;
  nao e benchmark de latencia do aplicativo.
- native-worktree-mcp-build.txt: TypeScript/aliases passaram. LOC: 891 modulos.
- native-worktree-mcp-packaged/report.json: passou em 43,36 s. Worktree criada,
  escrita isolada, reabertura e restart; MCP em outra worktree executou uma
  mutacao, perdeu o ACK e bloqueou continue antes/depois do restart. Seis
  checkpoints, zero replay e zero processos rastreados vivos.
- native-worktree-mcp-legacy/report.json: fallback passou em 29,86 s.
- native-installer-candidate-matrix/report.json: matriz integrada do mesmo
  pacote passou em 120,69 s, incluindo interacoes, preparacao/ACK, arquivos,
  Git/PTY, MCP publico/externo, anexos, memoria e continuacao. Recuperou
  19 checkpoints e 17 mensagens, zero replay e zero processos rastreados vivos.
- ASAR: 07dfe1d547f8077e6594f4eb9f898556b7bd669b3a36c8a8ef8ccffce71fa0d2.
  Executavel: 12256bc26cc15a2dbd36bd0c95caa065eb1da178fb716bc8de5667450c9df7c6.
- Fonte: scratch/harness-candidates/2026-10-06T16-42-40-357Z/manifest.json,
  SHA256 e994e8285b6b4657b0c0b037756e06e2622bf5fcf29a797ad90864a694915e65.

O instalador local foi gerado a partir desse pacote:
dist/electron-builder/CodeStudio-Harness-Candidate-2026-10-06.exe,
319.600.408 bytes, SHA256
2515e2337557ade0c274133c9042eb93c474d79c24651026caad171058be8bb4.
native-installer-payload-verification.json confirma os hashes do executavel,
ASAR, addon, runner, supervisor e manifestos extraidos do instalador contra o
pacote testado. O candidato nao possui assinatura Authenticode. A extracao
nao executou o instalador, nao atualizou o PC e nao comprova install/uninstall.
O runtime padrao continua legacy_ts; certificacao e rollout permanecem abertos.

## Compatibilidade do perfil instalado e trace do candidato — 2026-10-06

A instalacao existente em C:/Program Files/CodeStudio permanece na versao
0.5.2 e nao foi encerrada nem substituida. O candidato usa o mesmo diretorio
de dados, ~/.mcp-code-indexer. O banco original foi aberto somente para leitura
e copiado pela API de backup consistente do SQLite. As migrations foram
executadas apenas numa segunda copia, em scratch, usando o codigo do pacote.

Evidencias em scratch/harness-20261003:

- installed-profile-migration/report.json: migrations 267 e 268 aplicadas
  sobre o schema 266, quick_check aprovado e abertura pelo CodeIndexDB real
  do candidato aprovada. A unica mudanca de contagem ocorreu em schema_version.
- installed-profile-migration/config-integrity-report.json: valores completos
  de 22 tabelas de configuracao identicos antes/depois, por comparacao de
  hashes das linhas. Inclui 19 provedores, 15 plugins, dois servidores MCP,
  sete app_settings, 18 bindings, 818 modelos e 121 skills. Nenhuma credencial
  ou valor de configuracao foi impresso no relatorio.
- installed-profile-migration/source.index.db: snapshot consistente preservado,
  SHA256 afa68034dbd1eed52132c9afe1dbde8f2a10f55ae2202915eaf87a64100caf85.
- installed-profile-migration/sessions-report.json: catalogo leu 107 sessoes;
  16 journals copiados para scratch passaram pela validacao de integridade do
  leitor empacotado. Onze raizes registradas nao possuem o diretorio consultado;
  nao houve reparo automatico. Essa amostra nao valida todos os artefatos nem
  todas as conversas. O primeiro relatorio de sandbox registrou EPERM, resolvido
  na leitura posterior com permissao do host, sem alterar os dados.
- native-installer-startup/report.json: perfil vazio isolado chegou ao dashboard
  em 4.304 ms. Nos 120 frames posteriores, p95 7 ms e maximo 20,9 ms. O trace
  registrou tarefa maxima de 198,59 ms em CrRendererMain. Uma observacao de
  startup frio nao prova o gate de startup nativo aquecido nem identifica a
  causa do frame historico de 8.759 ms.

A copia existente cobre o banco e uma amostra dos journals, nao um backup
integral do perfil. Atualizacao instalada e copia das preferencias locais
aguardam confirmacao para encerrar o aplicativo aberto. Estes resultados
comprovam a compatibilidade observada dos dados, sem promover o runtime Rust.

## Projecao privada do checkpoint do provider — 2026-10-06

O writer conserva agora uma projecao privada do checkpoint confirmado. Para
um delta, ele copia somente o fragmento novo e compartilha o prefixo que ja
possui. Mensagens e bytes do chamador ou do payload devolvido nao alteram essa
projecao. O formato do journal, os hashes canonicos, a validacao do historico,
os checkpoints completos a cada 32 registros e a interrupcao apos ACK incerto
permanecem iguais. A API publica do codec continua retornando copias isoladas.

Evidencias em scratch/harness-20261003:

- native-frontier-owned-unit-after.txt: 21 testes em cinco arquivos passaram,
  incluindo igualdade exata de bytes, compaction, mudanca de binding/attempt,
  alteracao de campos desconhecidos, mutacao do payload, ENOSPC e perda de ACK.
- native-frontier-owned-typecheck.txt: TypeScript sem emissao passou; LOC: 891
  modulos dentro do limite.
- native-frontier-owned-physical.txt: oito testes com runner Rust real passaram,
  incluindo retomada e efeito incerto depois de reabrir o journal. Um teste do
  adapter OSS ficou desabilitado por ausencia da configuracao daquele engine.
- native-frontier-writer-before.json e native-frontier-writer-after-idle.json:
  benchmark do writer com recibo em memoria, tres aquecimentos e 20 amostras.
  Para 100/1.000/10.000 turnos, p95 antes: 2,94/13,09/195,04 ms; depois:
  2,84/11,73/159,73 ms. Sao amostras locais, sem disco nem provider e sem
  certificacao estatistica de ganho. O benchmark esta em
  scripts/benchmark-provider-frontier-writer.mjs.

A serializacao canonica e a comparacao do prefixo ainda percorrem o historico;
essa mudanca elimina a decodificacao/copia profunda repetida, nao todo o custo
linear. O instalador candidato identificado acima foi preservado e nao inclui esta
alteracao posterior. A proxima certificacao de pacote deve incluir este writer.

## Preview Electron, browser e bancos existentes — 2026-10-06

O escopo de paridade inclui as ferramentas integradas ao produto, alem de
filesystem, comandos e MCP. A leitura do ASAR congelado do instalador confirmou
22 ferramentas preview_ registradas e ligadas a PreviewWindowService no
Electron, oito browser_ ligadas ao servico de pesquisa e quatro db_ registradas
com o store de conexoes do worker: db_list, db_schema, db_query e db_command.
Essas familias permanecem no fluxo TypeScript; nenhuma esta habilitada no
catalogo nativo de desenvolvimento. O default continua legacy_ts.

Evidencias em scratch/harness-20261003:

- native-installer-built-in-tools.json: nomes, registro e bridges conferidos
  no ASAR do candidato. Inventario estatico, nao execucao de cada ferramenta.
- builtin-preview-database-regression.txt: 51 testes em sete arquivos passaram.
  Banco foi exercitado com store e SQLite temporarios reais, incluindo leitura,
  escrita, escopo e conexao read-only. Preview/CDP e browser foram testados com
  doubles; estes testes nao comprovam navegacao numa janela real do pacote.
- installed-profile-migration/database-config-integrity-report.json: oito
  tabelas de banco/SSH com valores identicos apos migrar a copia do perfil;
  inclui as tres conexoes cadastradas, uma consulta no historico e um host SSH.
  Nao houve conexao aos bancos reais nem exibicao de credenciais.

A integracao Rust deve reutilizar os servicos do host, incluindo a janela do
Electron, e comprovar dispatch, escopo/permissoes, cancelamento, encerramento,
resultados e efeitos incertos. Presenca dos arquivos no pacote nao encerra
esse gate. O manifesto A06 agora explicita essas familias e suas pendencias.

## Extracao do storage e ferramentas no pacote separado — 2026-10-06

A implementacao do fs-store (63 modulos) e os contratos puros de sessao e
compactacao pertencem agora a session-storage. Os caminhos antigos sao reexports
de compatibilidade; 144 consumidores passaram a importar o dono correto.
O store nao depende do executor, dos services nem do motor de pipelines.
As referencias adicionais ao legado cairam de 573 para 459; o gate ainda falha,
assim como os limites gerais (56 arquivos acima de 500 linhas) e as fronteiras
globais de pacotes. Nenhuma baseline foi ampliada para ocultar esses resultados.

O preview passa a serializar operacoes por janela, aguardar aberturas pendentes
antes de fechar e conservar a identidade de servidores cuja parada falhou.
Falha de resposta apos um efeito produz resultado incerto e impede repeticao
automatica. O browser de pesquisa compartilha conexao pendente, controla o ciclo
de vida dos contextos e limita handles/texto antes do transporte.

Evidencias em scratch/harness-20261003:

- storage-preview-final-tools.txt: 1.444 testes aprovados em 174 arquivos.
- storage-browser-storage-tests.txt: 268 testes de storage/consumidores aprovados.
- storage-browser-native-windows.txt: 21 cenarios com processos Rust reais.
- storage-preview-final-types.txt e storage-preview-electron-build.txt:
  TypeScript e build de producao aprovados; dashboard aprovado em
  storage-browser-dashboard.txt. CLIs locais evitam sincronizacao de
  dependencias durante a compilacao.
- tools-review-preview-physical/report.json: 22 handlers com Electron/CDP reais;
  screenshot, efeitos de entrada, redacao de storage e encerramento conferidos.
  Cancelamento reconhecido em 92,5 ms nesta amostra, sem processos remanescentes.
- tools-review-native-final/report.json: matriz combinada de arquivos, imagem,
  busca, contexto, continuacao, interacoes, ConPTY, preparacao, MCP publico e
  stdio; 19 checkpoints recuperados apos restart, sem replay do provider ou da
  mutacao MCP incerta. tools-review-legacy/report.json: fallback legado aprovado.
- tools-review-profile-final/report.json: migracao 266 para 268 numa nova copia
  do snapshot, 30 tabelas com valores identicos e 16 journals comparados com a
  baseline. Dados instalados nao foram alterados.
- tools-review-installer-verification-final.json: os 4.856 arquivos extraidos
  coincidem com o pacote testado. Instalador separado, nao executado:
  dist/electron-tools-review-20261006/CodeStudio-Tools-Candidate-2026-10-06.exe.
  SHA256: 31ab7b3f4a65e505dcbf51e81988df96128c99361c79cdf76a7e03c9592181cf.

A primeira tentativa grafica restrita falhou ao iniciar a GPU; o teste com
acesso ao host passou. A primeira matriz combinada encontrou contexto remoto
de avaliacao destruido na prova de preparacao; os tres cenarios passaram
isolados. A observacao de parada deixou de reter uma avaliacao remota durante
o teardown, e a matriz completa passou. Falhas e relatorios anteriores foram
preservados. Esses resultados nao substituem certificacao de uso prolongado.

O novo pacote inclui a projecao privada do writer descrita acima. O instalador
anterior e a instalacao 0.5.2 continuam preservados. Rust permanece opt-in de
desenvolvimento: 29 nomes habilitados, 218 pendentes de integracao. A lista por
familia e os limites estao em [tool-improvements.md](./tool-improvements.md).
