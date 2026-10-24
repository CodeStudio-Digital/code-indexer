# Coder Rust Windows — entrega validada em 23/10/2026

Estado: compactação, sete ferramentas e pacote Windows R12 aprovados nos gates
desta entrega. Instalador conferido por extração e comparação integral com o
pacote testado. A instalação existente e seu perfil não foram alterados.
Isto certifica o escopo local de preview do Coder, não o rollout global.

## Entrega solicitada

Compactação durável, sete ferramentas restantes do Coder e instalador Windows
validado. O catálogo contém 162 nomes habilitados (161 na entrada e um exclusivo
dos filhos), de 247 nomes próprios. Os 85 restantes pertencem a outras superfícies
da migração; o legado continua disponível. Company não mistura runtimes na árvore.

| Ferramentas | Comportamento implementado |
| --- | --- |
| `collect_agents`, `followup_task` | Jobs nativos, espera, continuação autorizada e orçamento da árvore |
| `send_message`, `send_input` | Inbox durável e deduplicado; entrada interrompe somente pergunta/decisão, nunca aprovação |
| `enter_worktree`, `exit_worktree` | Nova attempt após encerramento da anterior, recibos Git e recuperação explícita |
| `docs_deep_research` | Pesquisa e revisão em filhos Rust com o provider escolhido e corpus restrito |

A opção persistida **Coder Rust (prévia para Windows)** permite ativar o caminho
nativo nas configurações e requer reinicialização. O padrão continua legado.
O gate global de produção não foi removido nem renomeado para simular certificação.

Para ativar: abra **Configurações**, selecione **Sistema → Configurações** e,
em **Comportamento do agente**, ligue **Coder Rust (prévia para Windows)**.
Clique em **Salvar** e reinicie o CodeStudio. A busca por
`CODESTUDIO_NATIVE_CODER_DEV` também localiza a opção. Conversas já gravadas
em Rust continuam precisando dessa opção para retomar; desativá-la permite
novas conversas no legado.

## Compactação e recuperação

O contexto do modelo usa resumo extrativo limitado e janela recente. Não é resumo
gerado por outro modelo. As mensagens substituídas ficam em capítulos Protobuf
autenticados, preservando os pares de chamadas/resultados. O Host confirma os
capítulos antes da fronteira compactada; erro de gravação ou ACK incerto bloqueia
o writer. O histórico público permanece completo e separado do contexto limitado.

A revisão encontrou e corrigiu alias de buffers Protobuf que corrompia argumentos
após zeroização. Encontrou também compactação prematura com ferramentas de 32 KiB:
a janela recente agora se adapta e o limiar suave não encerra uma conversa válida.
Retomada acima de 8 MiB passou: 1.000 leituras de 12 KiB, 11 attempts e
histórico íntegro, sem repetição. A expansão iterativa também cobre 160 capítulos
aninhados, ciclos, limites e irmãos que compartilham a mesma referência.
Filhos transferem os capítulos e anexos herdados para o novo journal antes de
gravar a fronteira; a leitura do transcript inclui esse histórico sem duplicação.

A rodada de 10.000 encontrou um defeito de inicialização depois de 9.000 turnos:
o supervisor iniciava sua janela de Hello de dez segundos enquanto o Host ainda
revalidava o journal. A preparação do writer e dos anexos agora precede a criação
do processo. O prazo original e a autoridade continuam obrigatórios; cancelamento
ou erro antes do spawn fecha o writer e libera leases e reservas do produto.
O teste completo foi repetido com essa correção e passou os 10.000 turnos,
10.001 chamadas ao provider e 11 attempts, incluindo retomadas frias.

O cancelamento público compartilha uma única solicitação por attempt. O wrapper
aguarda o cancelamento ativo antes de abortar o bus público, preservando o ACK e
o resultado terminal confirmado. Preview passou conclusão, cancelamento e
resultado incerto seguido de recuperação sem replay.

A matriz R11 também encontrou cancelamento de `self_review` publicado como
resultado incerto antes de o serviço fechar a revisão. A correção mantém a
classificação de controle: o Host aguarda a operação real e exige recibo privado
da invocation após commit terminal e verificação de autoridade. Timeout, ACK
incerto, autoridade encerrada ou efeito aninhado incerto não viram cancelamento
confirmado. A regressão cobre 63 testes únicos; os 19 testes do serviço fazem
parte desse conjunto e não são somados novamente.

## Evidências já obtidas nesta rodada

Todos os caminhos abaixo são relativos a `scratch/harness-20261003/`.

- `native-coder-r10-large-history-report.json`: 1.000 ferramentas, 1.001 chamadas
  ao provider determinístico, 11 attempts, histórico íntegro; 169,56 segundos,
  journal de 71.141.286 bytes e nenhuma leitura repetida.
- `native-coder-r10-10000-report.json`: 10.000 ferramentas, 10.001 chamadas ao
  provider determinístico e 11 attempts; 1.461,43 segundos, journal de
  135.339.929 bytes e histórico íntegro. O ledger correspondente registra
  49 processos encerrados naturalmente e `verifiedEmpty=true`.
- `native-messaging-physical-report.json`: mensagens, pergunta interrompida,
  coleta e followup, incluindo restauração da inbox antes da próxima fronteira.
- `native-docs-r9-physical-report.json`: pesquisa/revisão e cancelamento; zero
  efeitos sem confirmação e zero leases residuais. ACK de cancelamento 21,8 ms
  em uma amostra; isso não equivale ao p95.
- `native-worktree-transition-physical-r7-processes/`: keep/remove e retomada
  explícita passaram; 242 processos encerrados naturalmente.
- `native-coder-r10-rust-regression-processes/`: 171 testes nos crates alterados.
- `native-coder-r10-clippy-send-processes/`: Clippy com warnings negados.
- `native-messaging-runtime-preparation-r2-processes/`: sete testes físicos,
  incluindo anexo atrasado em 11 segundos, cancelamento, autoridade expirada,
  zero spawn antes da preparação e liberação das reservas do produto.
- `native-messaging-migration-session-compat-r1-processes/`: 54 testes de
  migração 268, projeto sem `semantic_jobs` e storage de sessão; mais dois testes
  de entidades migradas em `native-messaging-migrated-runtime-compat-r1-processes/`.
- `native-pre-spawn-typecheck-r3-processes/`: typecheck completo.
- `native-pre-spawn-loc-r2-processes/`: orçamento de linhas, 917 módulos.
- `native-coder-r10-final-build-r3-processes/`: build final, 65 processos
  encerrados naturalmente, verificação do runtime e smokes QuickJS/web-worker.

Os gates anteriores interrompido em 5.000 e reprovado depois de 9.000 não são
contados como aprovação de 10.000. Seus relatórios foram preservados.
Os providers das fixtures são determinísticos e locais; as medições não incluem
latência de contas reais nem comparação de qualidade entre modelos.

## Pacote final R12

`dist/electron-native-coder-r12-20261023/win-unpacked`, versão 3.15.1.
SHA-256 do ASAR:
`5a9072cac58258749ed70fd633804ef4d461980f6227ac06926bda1f1224eaf3`.

Os seguintes gates passaram no mesmo ASAR:

| Gate | Evidência em `scratch/harness-20261003/` |
| --- | --- |
| Matriz HTTP/SSE/UI, ferramentas, aprovação, cancelamento, ACK perdido e reinício | `native-coder-r12-packaged-matrix/report.json` |
| Quatro tools de mensagens, inbox durável, capítulos/imagem herdados e retomada fria | `native-messaging-r12-packaged/report.json` |
| Pesquisa/revisão Docs em filhos Rust, provider selecionado e opção persistida | `native-docs-r12-packaged/report.json` |
| Preview completo, cancelado e incerto; revisão completa/cancelada/sem configuração | `native-coder-r12-preview-packaged/report.json` |
| Worktree keep/remove/restart, nova attempt e rejeição de cwd incorreto | `native-coder-r12-worktree-packaged/report.json` |
| CLI: conclusão, retomada, aprovação, cancelamento e falha | `native-coder-r12-cli/report.json` |
| Legado e RAG com paginação; smoke de renderer, dependências, LSP, Jobs, QuickJS e conversão web | `native-coder-r12-package-compat/` |

Os typechecks raiz e produção passaram em
`native-coder-r12-root-typecheck-r2-processes/` e
`native-coder-r12-prod-typecheck-r2-processes/`. A emissão dirigida comprova
equivalência com o emit de produção anterior antes de substituir os módulos
alterados (`native-coder-r12-emit-write-report.json`). O runtime Rust não foi
recompilado após os gates de escala e desempenho.

A fonte do produto e dos testes foi congelada em
`scratch/harness-candidates/2026-10-23T05-16-28-565Z/manifest.json`, SHA-256
`44a4ca4d9cd6d14cacd73f6c4ddc2efbd5edaddd16aff4cf614384dba46b14f4`.
A documentação de entrega foi finalizada depois dessa fotografia.

A matriz ampla passou em 701,75 segundos, sem erros registrados. Seus 864
processos encerraram naturalmente, com `verifiedEmpty=true`. O ACK de
cancelamento dessa execução foi de 23,28 ms e a conclusão de 945,02 ms;
esses valores são uma amostra funcional, não o p95.

## Instalador entregue

`dist/electron-coder-rust-r12-installer-20261023/CodeStudio-Coder-Rust-3.15.1-2026-10-23.exe`

- Tamanho: 321.896.944 bytes.
- SHA-256: `a473a8c1a3c7659f4d646406c9c9f13ba971edfd4166f6a365433bae5d3cc054`.
- 4.934 arquivos extraídos e comparados por SHA-256 com o pacote testado.
- Relatório: `scratch/harness-20261003/native-coder-r12-installer-verification.json`.
- Consolidação: `scratch/harness-20261003/native-coder-r12-release-summary.json`.

O NSIS não foi executado: não houve substituição da instalação, alteração do
registro de instalação nem uso do perfil do usuário. A validação cobre geração,
extração, equivalência do payload e execução do aplicativo empacotado em perfis
isolados. O `debug.log` criado pelos testes foi preservado fora do pacote antes
da comparação; nenhum arquivo do produto foi excluído dessa verificação.

O consolidado exige o mesmo SHA do ASAR nos oito relatórios de execução do
pacote, confere os binários com o manifesto Rust fixado e vincula o instalador
ao mesmo ASAR. Os dois relatórios de escala originais não embutem hashes dos
binários: sua associação ao runtime congelado nesta rodada é registrada
separadamente, sem apresentá-la como atestado embutido nesses relatórios.

## Medições do código final

| Gate | p95 | Meta | Escopo |
| --- | ---: | ---: | --- |
| Startup aquecido | 43,025 ms | 250 ms | 100 amostras + 10 warmups, benchmark nativo |
| Dispatch | 0,369 ms | 5 ms | 1.000 amostras + 100 warmups; executor/validação/leitura/encoding |
| ACK de cancelamento | 1,1209 ms | 250 ms | 50 amostras + 5 warmups; runner final `f724c589…` |

`native-coder-r10-performance-context.json` registra SHA e escopo. Startup e
dispatch usam builds separados com a feature de medição; não são a latência de
abertura do Electron nem o tempo total entre chamadas ao modelo. Cancelamento
mede attempts ociosas. Houve carga paralela de build e escala na máquina. Estas
medições não estabelecem uma porcentagem de aceleração da conversa completa.

O trace da inicialização fria do R12 (`native-coder-r12-startup-trace-analysis.json`)
mostra uma tarefa de 946,4 ms no processo principal, com 773,0 ms de amostras em
`better-sqlite3.exec` na cadeia de migrações. A maior tarefa do renderer foi de
207,4 ms, incluindo leitura do ASAR/preload. Portanto, ainda há bloqueio na
migração fria; não se afirma ausência total de pausas nem abertura do Electron
abaixo de 250 ms. Esses registros não isolam a causa do frame histórico de
8.759 ms de outro build.

No teste de 10.000 turnos, o p95 entre chamadas ao provider por lote variou
de 47,5 a 73,7 ms. A recuperação fria inclui releitura validada, projeção do
histórico inteiro e, nos lotes intermediários, expansão dos capítulos e
comparação integral de digest: chegou a 147,3 segundos. Esse número é o custo
do gate de integridade, não uma medição isolada do tempo para retomar o chat.

Cada teste/build usa `scripts/run-tracked-test.ps1`. Os diretórios terminados em
`-processes` conservam `processes.jsonl` e `cleanup.json`. Identidade e data de
criação são verificadas antes de interromper um processo; nenhum encerramento
genérico de Node, Rust ou Electron é usado.

A auditoria final (`native-coder-final-process-audit.json`, `provisional=false`)
fechou 168 de 168 ledgers: 5.800 processos de Job, 168 supervisores contados
separadamente, zero pendências e zero instâncias próprias vivas. PIDs reutilizados
foram separados por data de criação. Seis rodadas históricas solicitaram cleanup
forçado; todas terminaram com `verifiedEmpty=true`. Não se confunde esse pedido
com uma contagem de processos efetivamente mortos. O próprio auditor encerrou
seus dois processos de Job e seu supervisor. O escopo é a rodada selecionada,
não uma varredura de todos os processos do PC.

## Limites da certificação

Os gates globais de produção, demais plataformas, soak, canário e retirada do
legado continuam abertos. O ratchet global de imports do legado também continua
reprovado: 393 adições reais e 135 remoções após excluir dois inventários de
metadados da varredura. A baseline não foi ampliada para aceitar esses imports.
Isso não é apresentado como certificação global da migração.
