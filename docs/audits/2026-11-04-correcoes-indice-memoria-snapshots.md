# Correções de índice, memória e curadoria — 04/11/2026

## Estado da entrega

As falhas de índice e memória reproduzidas na [auditoria anterior](2026-11-04-indice-memoria-snapshots.md) receberam correções no código, regressões e uma superfície de curadoria ligada à memória realmente consumida pelos agentes. As notas de contexto antigas continuam disponíveis; sua importação é explícita, idempotente e preserva os originais. Os mecanismos de revisão e desfazer por arquivo, rodada e ferramenta foram mantidos.

**Entrega concluída e validada no candidato isolado:** implementação, typechecks, **464/464 testes em 51 arquivos**, build, smokes gerais/nativos, UI com backend empacotado real e três amostras de CPU ociosa. A contagem de testes usa o resultado mais recente de cada arquivo. O perfil instalado não foi alterado; a eficácia da memória em tarefas e o comportamento com projetos/históricos grandes continuam fora do que essas evidências certificam.

Esta entrega complementa os relatórios de [CPU e harness](2026-11-04-reteste-harness-cpu.md) e [prompts](2026-11-04-prompts-harness.md). Ela não substitui seus escopos nem atribui CPU ociosa à existência de um painel vazio.

## O que foi corrigido

| Área | Problema anterior | Comportamento implementado e evidência de fonte |
| --- | --- | --- |
| Referências estruturais | A remoção da última chamada/importação deixava ocorrências antigas | `process-file-structural.ts` substitui as referências mesmo quando o parser retorna `[]`, na mesma publicação transacional dos outros derivados |
| Reconciliação manual | O endpoint podia confirmar o baseline antigo antes de iniciar a passagem pedida | `ProjectIndexService.reconcileStructural` aguarda a passagem solicitada e as barreiras de watcher; falhas e limites têm resultado explícito |
| Reparação do estoque estrutural | Um scan com fonte/hash inalterado não reparava derivados antigos | A ação manual propaga `forceReparse` pelo serviço, RPC, worker e scanner. Reaberturas e reconciliações automáticas continuam incrementais |
| Fila e propriedade | Trabalho manual enfileirado podia iniciar depois de cancelamento, timeout ou perda da lease | O owner revalida autorização/propriedade após adquirir o mutex e antes de iniciar o worker. Pedidos ainda em fila são descartados; publicação já iniciada termina atomicamente |
| Telemetria de busca | FTS MCP local não tinha sink/origem completos; a UI chamava abertura de resultado de uso | O contexto MCP liga o sink e envia `consumer=agent`/escopo de sessão; o JSONL evita consulta, conteúdo e IDs de sessão. A UI usa `Resultados abertos na interface` |
| Frescor da memória | Captura/comparação de hashes consultava o banco central antigo | O roteamento usa o banco proprietário de cada projeto. Ausência de baseline é desconhecida, não evidência de atualidade |
| Aprendizagem confirmada | Timeout podia avançar a fronteira antes da extração terminar | O harvest exige recibo de conclusão sem erro antes de avançar. Timeout libera o chat sem consumir o trecho; falha deixa possibilidade de retomada |
| Ordem e repetição de aprendizagem | Fronteiras concorrentes ou replay podiam repetir extração ou pular um trecho anterior falho | Há fila por sessão, consulta da fronteira persistida e validação de `sourceStartSeq`; um resumo posterior não cobre silenciosamente uma lacuna anterior |
| Memória no contexto | Candidatos recuperados eram contados como injetados antes dos filtros de montagem | A montagem confirma os IDs efetivamente inseridos, após orçamento/deduplicação; ferramentas explícitas mantêm eventos próprios |
| Preferências | A primeira preferência grande podia produzir bloco vazio; o callback global não chegava ao runner | A montagem inclui a preferência dentro do orçamento total, com abreviação explícita e instrução para aprofundar; o `CoderRunner` encaminha `getUserMemoryIndex` ao bridge |
| Escopo e subagentes | Recall global e contexto dos subagentes tinham contratos incompletos | `recall_memory(scope: user)` permanece disponível com memória de projeto desativada; subagentes herdam callbacks de leitura/recibo sem receber novos direitos de escrita |
| KPIs de memória | Contadores cobriam nomes antigos e podiam reler o histórico completo em cada consulta | Eventos atuais e recibos são reconhecidos; a projeção de chamadas de memória é incremental, com cache e invalidação para append, rollback e reescrita |
| Cobertura semântica | Totais da geração não explicavam memórias vivas ausentes ou com falha | A API conta memórias vivas e seus itens na geração ativa por escopo, distinguindo indexadas, falhas, ausentes e pendências |
| Reparo semântico | Falha de runtime ou troca de alvo podia deixar reparo sem diagnóstico/garantia de consentimento | A ação explícita preserva fences de namespace/projeto, revalida alvo antes/depois da criação de geração e registra falha sanitizada mesmo antes dessa criação |
| Runtime vetorial | Uma primeira falha de carregamento nativo podia envenenar o cache da promise até reinício | `sqlite-vec-store.ts` limpa a promise rejeitada, permitindo tentativa posterior depois do reparo do ambiente; o candidato empacotado passou em carregamento, retry, CRUD vetorial e isolamento de namespace |
| Curadoria | Criar/editar/pinar notas legadas não alterava a base usada pelo recall atual | A UI principal opera em `agent_memory`, com criação, edição, pin, arquivo/restauração, busca e páginas limitadas a 40 registros; nota e seu evento são publicados atomicamente |
| Diagnóstico do painel | “Memória do projeto: 0” contava snapshots legados ao lado do estoque ativo | O card usa a base ativa; estado de erro tem tentativa novamente, sem fingir ausência de registros |
| Notas antigas | Remover o painel diretamente arriscaria perder 16 notas existentes no perfil | A seção legada permanece disponível e permite copiar explicitamente para a memória ativa, preservando a proveniência e sem apagar originais |
| Contexto legado/MCP | Exportação omitia `gotcha/procedure`; descrição citava tools removidos | O agrupamento inclui todas as categorias conhecidas e fallback para futuras; a descoberta MCP descreve o contrato existente |

### Arquivos e contratos principais

- Índice: `packages/indexer/src/indexer/indexer/process-file-structural.ts`, `packages/indexer/src/indexer/scanner.ts`, `packages/services/src/services/project-index/service.ts`, `apps/http-api/server/owned-project-index.ts` e `apps/http-api/server/routes/project-detail-routes.ts`.
- Busca: `apps/mcp-server/context.ts`, `apps/mcp-server/tools/search.ts` e `apps/dashboard/features/project/tabs/index-workspace/RunSection.tsx`.
- Memória e confirmação: `packages/services/src/memory/`, `packages/code-agent/src/core/runner/compaction/memory-harvest.ts`, montagem em `core/runner/assembly` e `packages/session-storage/src/fs-store/memory-call-projection.ts`.
- Frescor e cobertura: `packages/store/src/db.ts`, `packages/store/src/db/agent-memory-coverage.ts`, `agent-memory-references.ts` e `preserved-memory-references.ts`; a regressão em lote está em `packages/store/src/db/__tests__/agent-memory-stale-batch.test.ts`.
- Diagnóstico/reparo: `apps/http-api/server/routes/agent-memory-semantic.ts`, `apps/http-api/server/semantic-coordinator-knowledge-requests.ts` e `packages/store/src/sqlite-vec-store.ts`.
- Curadoria/importação: `apps/http-api/server/routes/agent-memory-curation.ts`, `packages/store/src/db/agent-memory-curation.ts`, `packages/services/src/memory/legacy-memory-import.ts` e `apps/dashboard/features/snapshots/`.

### Preservação, escopo e custos

Editar uma memória mantém os hashes históricos das referências, em vez de recapturar o estado atual e retirar artificialmente um aviso de desatualização. A edição produz uma revisão nova e arquiva a anterior; uma revisão antiga já arquivada não pode sobrescrever a corrente. A importação conserva a relação `source_snapshot_id`, rejeita notas de outro projeto e evita duplicação mesmo quando a cópia anterior foi editada/arquivada.

Notas, tags, versões e referências da origem permanecem no legado. Importar não equivale a mover todo esse histórico para o esquema ativo. As **16 notas reais inventariadas não foram importadas, editadas ou apagadas durante os testes**; as provas usam fixtures. A origem continua sendo a fonte de seu histórico integral.

Nenhum reparo estrutural ou vetorial foi aplicado ao projeto real nesta rodada. O reparo estrutural explícito é mais completo que uma abertura normal, pois precisa corrigir derivados antigos mesmo sem mudança de fonte. O reparo vetorial remoto exige confirmação e fica vinculado ao alvo validado; abertura/reinício não consome uma autorização antiga para outro alvo. Não foi introduzido um loop automático de tentativas para elevar percentuais da UI.

As contagens semânticas são cobertura registrada de itens por memória viva. Não certificam existência/qualidade de cada vetor nem substituem um teste de relevância. Os eventos de injeção comprovam montagem de contexto, não que o modelo aplicou corretamente o conteúdo.

## Validação disponível

Evidências ficam em `.tmp/knowledge-fixes-2026-11-04/`. São artefatos locais, sem conteúdos de chats ou memórias reais. Testes usam fixtures, Electron compatível com a ABI nativa, um worker, diretórios próprios e nenhum provedor remoto.

| Frente | Resultado disponível | Evidência e limite |
| --- | --- | --- |
| Índice, fila, lease, worker e busca | **107 testes únicos aprovados em 14 arquivos** | `structural/summary.md`; resultados iniciais e retestes finais. Quatro bloqueios de `realpath` do sandbox passaram no reteste host autorizado; não foram classificados como defeito do produto |
| Cobertura, roteamento, coordinator, rota e sqlite-vec | **126/126 aprovados em 7 arquivos na integração** | `integration/tests.json`; inclui os casos adicionais de persistência de diagnóstico e estatísticas `project+local` após o lote anterior de 124 |
| Memória, montagem, eventos, harvest e projeção | **188/188 únicos aprovados em 21 arquivos** | `memory/validation-summary.json`, com reteste final de cinco arquivos/30 casos em `memory/incremental-results.json` |
| Curadoria/categorias + busca/stale/embedding | **28/28 únicos aprovados em 5 arquivos** | União de `snapshots/curation.json` com `curation-final.json` (10/10 API); inclui isolamento de memória local e atomicidade de nota/evento |
| UI de curadoria | **9 cenários aprovados, sem erros** | `snapshots/ui-result.json`, quatro PNGs e `process-cleanup.json`; componentes React reais em Vite/Chromium, todas as APIs simuladas e rede externa bloqueada |
| Proteção de alterações por arquivo/rodada/ferramenta | **35/35 aprovados novamente na integração** | `integration/tests.json`; os mesmos seis arquivos da auditoria anterior, sem usar provas que esperavam os bugs antigos |
| Typecheck raiz e dashboard | **Ambos aprovados após os ajustes finais, exit 0** | `typecheck-delivery/result.json` (38,675 s) e `dashboard-types-delivery/result.json` (39,75 s); substituem os recibos anteriores |
| Integração e i18n | **464/464 únicos aprovados em 51 arquivos** | `integration-final-summary.json`: resultado mais recente por arquivo de `integration/tests.json` e `i18n-final/tests.json`; inclui cobertura de catálogos/chaves/literais |
| Build completo | **Aprovado, exit 0, 340,56 s** | `package/result.json` e `package/output.log`; candidato CodeStudio 3.15.7, Electron 42.5.0, em `dist/electron-knowledge-fixes-20261104` |
| Candidato: closure, renderer e workers | **Todos aprovados** | `candidate-validation-yFC8th/verification/report.json`; 2.453 módulos/43 pacotes sem faltas, renderer/deep-link, Tree-sitter, QuickJS, HTML, Sharp e FFmpeg |
| Candidato: contratos do harness e Git | **Ambos aprovados, exit 0** | `candidate-validation-yFC8th/reliability/report.json` e `git/report.json`; code_exec, cancelamento SQLite/reabertura, MCP/mapa, paginação Unicode, oito leituras Git e rejeição de mutação |
| Candidato: vetores nativos e roteamento | **Aprovado, exit 0** | `packaged-native-1dxm5j/report.json`; DLL física em `app.asar.unpacked`, retry, upsert/search/delete, isolamento e fixtures de cobertura/referências |
| Candidato: UI/API reais e CPU ociosa | **Aprovado, exit 0, sem pageErrors** | `snapshots/packaged-runs/2026-11-04T18-57-22-143Z/report.json`; sete grupos de verificação e três cenários ociosos, perfil sintético e backend real |

Não se somam os números das linhas: há arquivos/testes compartilhados entre frentes e resultados históricos. `integration-final-summary.json` preserva proveniência e SHA-256 dos recibos, verifica a correspondência com os 51 arquivos do manifesto e conta cada arquivo apenas uma vez. Provas da auditoria que passavam ao reproduzir um bug não fazem parte desse lote.

A execução integral terminou com 463 aprovações e uma falha de cobertura i18n: um literal visível de `LegacyMemoryNotes` não estava catalogado. O literal foi substituído por uma chave PT/EN, sem modificar o baseline; os oito testes daquele arquivo passaram no reteste. **464/464 é a união final por arquivo, não uma segunda execução integral.** A falha original permanece registrada em `integration/tests.json` e no exit 1 daquela execução.

### Evidência de custo da projeção de memória

`memory/projection-benchmark.json` registra um histórico sintético de 12.686.143 bytes/240 commits:

| Leitura | Trabalho observado | Tempo observado |
| --- | --- | --- |
| Fria | Leitura inicial de aproximadamente 12,1 MiB e 240 commits | 52,58 ms |
| Quente, sem alteração | Zero bytes de journal lidos e zero commits parseados | 0,254 ms |
| Depois de dois commits novos | Append de 1.066 bytes; 3.114 bytes lidos para atualização e validação | 0,333 ms |

É um microbenchmark local sintético, sem comparação entre máquinas ou promessa de p95. Ele demonstra a eliminação de releitura integral no caminho quente. A leitura fria ainda tem custo proporcional ao histórico; não prova que todo polling de estatísticas ou toda CPU da aplicação foi resolvido.

### Runner integrado e reprodução

```powershell
node .tmp/knowledge-fixes-2026-11-04/run-integration.cjs
```

O runner consome somente os 51 caminhos explícitos deduplicados de `integration-files.json`; verifica caminhos dentro do checkout, usa `--maxWorkers=1`, dotenv vazio, perfil/DB/temp separados por execução e remove variáveis de testes remotos `DB_IT_*`. Registra PID e diretórios em `integration/process.json`, stdout/stderr em `output.log`, Vitest em `tests.json` e encerramento em `exit.json`. A execução é coordenada para evitar concorrência com build/typecheck.

O smoke do novo candidato foi executado por `.tmp/knowledge-fixes-2026-11-04/verify-candidate.mjs`, com destino fixo `dist/electron-knowledge-fixes-20261104`. Ele usa o verificador oficial `verifyBuild`, as regressões de confiabilidade do harness e Git empacotado em sequência, perfis separados e PIDs/exit/log. Os hashes de `app.asar` e executável permaneceram iguais antes/depois; `candidate-validation-yFC8th/manifest.json` registra `verified=true`.

- SHA-256 de `app.asar`: `c015d287465745c4d76ba1a93227e26a77dc878dbcb3892f562f70afacf5b54c`.
- SHA-256 do executável: `3a9d54296bcaff75ef276106bcc0ec32cc1715fcf6b6daf5aef8d9bad84ab36d`.
- `candidate-validation-yFC8th/process-cleanup.json`: os oito PIDs conhecidos terminaram; nenhum processo restante do candidato no momento da conferência. Nenhum processo do usuário foi encerrado.

### Conferência nativa e dados reais em leitura

O smoke nativo usou o próprio `CodeStudio.exe` do candidato. A DLL `sqlite-vec-windows-x64/vec0.dll` foi carregada pelo caminho físico de `app.asar.unpacked`; uma falha inicial simulada foi seguida de retry bem-sucedido. As operações vetoriais e o isolamento de namespace passaram em dados descartáveis.

O mesmo recibo registra uma leitura agregada, somente leitura, do projeto real: 263 memórias ativas; o índice central antigo indicava zero referências alteradas, enquanto o índice proprietário identifica 79 referências alteradas em 56 memórias, além de 49 referências sem baseline verificável. A cobertura registrada permanece 216 indexadas/14 falhas/33 ausentes no projeto e 130/50/39 nas 219 memórias globais. Esses dados confirmam o diagnóstico e o roteamento corrigido; **não representam reindexação ou conserto já aplicado ao estoque real**. Nenhum conteúdo privado foi exportado.

### UI empacotada com backend real e CPU ociosa

O aplicativo foi aberto com banco sintético novo, sem credenciais, autenticação de cloud ou turno de modelo. A UI e as APIs são as incluídas no candidato; os targets semânticos estavam desativados antes de iniciar a aplicação. Diferentemente do smoke de componentes, este fluxo não simulou as APIs.

Foram verificados: contagem consistente de 42 notas entre listagem/health/cobertura; paginação 40+2; criação e edição imutável; pin, arquivamento e restauração persistidos; visualização de nota antiga e seu histórico; importação que copia uma vez e preserva o original integralmente; reload do renderer mantendo as 44 notas resultantes e atualização dos cards. Nenhum reparo semântico remoto foi disparado. Os sete grupos passaram sem erros de página. O recibo `process-cleanup-host.json` confirmou os sete PIDs conhecidos encerrados; nenhuma ação de encerramento atingiu processos do usuário.

As amostras de CPU foram feitas sequencialmente, com a janela **visível, focada e não minimizada**, 15 segundos de estabilização e aproximadamente 30 segundos de observação por cenário, numa máquina com 32 processadores lógicos. O total soma os processos observados do aplicativo:

| Cenário ocioso | CPU equivalente a um núcleo | CPU normalizada pela máquina (32 lógicos) |
| --- | --- | --- |
| Tela inicial | 2,381% | 0,0744% |
| Projeto/editor aberto | 2,893% | 0,0904% |
| Chat vazio aberto | 1,484% | 0,0464% |

Esse candidato permaneceu com baixo consumo ocioso nos três cenários da fixture. Não é um comparativo antes/depois sob a mesma carga real, nem prova ausência de travamentos em um chat longo ou em indexação de um projeto grande. O teste de code_exec demonstra contenção do loop pesado em processo separado; a interação da UI com 42–44 notas demonstra o fluxo funcional limitado. A certificação de latência/fluidez sob carga extensa exige outra medição.

## Artefato para instalação

[Instalador CodeStudio 3.15.7](<D:/MCP/dist/electron-knowledge-fixes-20261104/CodeStudio Setup 3.15.7.exe>) — 340.943.638 bytes. É o candidato local desta validação; o instalador não foi executado sobre o perfil do usuário.

SHA-256 do instalador: `656f427a8fa2be340abb7d03109af14043ec6eceb10814a41c6868a7505edd70`, registrado em `installer.json`. A conferência final do screenshot do executável constatou layout íntegro. `root-process-cleanup.json` também registra os sete PIDs conhecidos dessa frente encerrados; os registros de cada frente permanecem separados para não somar processos repetidos.

## Limites e aplicação ao perfil instalado

1. O aplicativo instalado e seus dados não foram migrados. Após atualizar, os reparos explícitos necessários devem ser conferidos no próprio projeto; nenhum diagnóstico autoriza apagar memórias, notas ou snapshots de revisão. As 16 notas legadas reais continuam preservadas.
2. As amostras de CPU e os fluxos de UI usam projeto pequeno, chat vazio e banco sintético. Históricos grandes, múltiplos chats ativos, indexação extensa, interação durante streaming e todos os providers não receberam certificação nesta etapa.
3. A eficácia em tarefas representativas com/sem memória e busca lexical/semântica ainda precisa ser medida por correção, repetição de erros, tokens e latência. Cobertura, acesso e injeção demonstram etapas do mecanismo, não a qualidade final da resposta de um modelo real.

Sem commit, push, publicação, instalação sobre o perfil real ou alteração de bancos reais nesta implementação. A árvore de trabalho contém outras mudanças anteriores; este relatório delimita a entrega de índice/memória/curadoria e não atribui a ela toda a diferença do checkout.
