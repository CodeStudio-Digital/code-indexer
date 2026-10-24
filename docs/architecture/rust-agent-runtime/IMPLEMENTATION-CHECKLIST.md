# Checklist mestre — Rust Agent Runtime

> **Entrega Coder Windows — 2026-10-23:** compactação durável e sete ferramentas
> implementadas, catálogo 162/85; 10.000 turnos, pacote R12 e payload do instalador
> aprovados. Estado e evidências atualizados no
> [relatório desta entrega](./11-coder-windows-release-2026-10-23.md).
> Os marcos abaixo preservam a história; não descrevem o checkout atual.
> A certificação global, o canário e a retirada do legado continuam separados
> da validação do Coder Windows em preview.

> **Matriz r8 aprovada; correção posterior de retomada — 2026-10-08:** a matriz
> do pacote passou com 155 nomes, 100 checkpoints recuperados, zero replay e
> 621 processos naturais. Compatibilidade e CLI passaram (84 e 56 processos). O novo
> teste de turnos executados encontrou perda dos metadados de truncamento na
> projeção, que impedia retomar uma leitura parcial. A fonte foi corrigida;
> sessões de 100 e 1.000 turnos passaram, incluindo reabertura e zero leituras
> repetidas; 45 testes de regressão e typecheck passaram. A rodada de 10.000
> falhou após 1.024 chamadas: o gateway limita a conversa a 2.048 mensagens.
> O planejador Rust de compactação passou dez testes e a regressão do engine;
> aplicação do resumo, capítulo durável e retomada ainda não estão conectados.
> O limite não foi elevado e esse gate permanece aberto. Provider determinístico,
> sem uso do perfil instalado. A correção ainda não integra o pacote r8.

> **Correção para r8 — 2026-10-08:** a matriz empacotada r7 encontrou
> `list_agents` ausente na preparação do chat comum. O registro foi corrigido
> na fonte; r7 reprovado, r6 permanece a referência empacotada aprovada.
> Cancelamento do DocsAgent, revisão final, busca, reescrita e reranking passou
> 99 testes em 16 arquivos, com 20 processos encerrados naturalmente. Isso
> melhora os serviços existentes e não conclui sua migração Rust. Build e
> nova matriz r8 passaram posteriormente (marco acima). Instalação e padrão legado inalterados.

> **Fonte para r7 — 2026-10-08:** catálogo 155/92, incluindo inventário da
> árvore e espera por eventos. Passaram 334 testes, typecheck/build, 23 cenários
> físicos da árvore e dois posteriores de inventário/espera entre irmãos.
> Orçamento compartilhado validado no novo binário; planos/resultados limitados
> antes dos efeitos, falhas de admissão injetadas antes/depois do commit.
> Pacote r7 posteriormente reprovado; r6 segue como referência aprovada. Instalação e
> padrão legado permanecem; sete ferramentas Coder, Company, DocsAgent,
> MCP aninhado e gates globais continuam abertos.

> **Fonte posterior ao r6 — 2026-10-08:** catálogo 153/94; execute_tasks passou
> 319 testes, typecheck/build e Electron com quatro tarefas, três filhos nativos,
> resultados longos, conclusão inline e restart sem relançar filhos. Sete
> checkpoints, zero replay; 51 processos naturais. Checkpoint de admissão
> permanente e leases impedem repetir efeitos incertos. A correção posterior
> de classificação do orçamento da árvore passou testes Rust/gateway, ainda
> sem validação física do novo binário. Pacote r6 e instalação não alterados.

> **Pacote r6 confirmado — 2026-10-08:** 152 capacidades, incluindo workflow
> e avaliador descartável de code_exec; 96 checkpoints, zero replay e 601
> processos naturais. Compatibilidade e CLI passaram (84 e 56 processos).
> Esse pacote é anterior à integração de execute_tasks documentada acima.
> Nenhum instalador aplicado; padrão legado e gates globais permanecem.

> **code_exec isolado — 2026-10-08:** fonte posterior ao r5 exige avaliador
> descartável contido pelo Job Rust, preservando proxies e recusando fallback
> para VM no worker nativo. Passaram 102 testes, typecheck/build, oito cenários
> físicos (18 processos naturais) e chat/restart (sete checkpoints, zero replay,
> 56 processos naturais). Loop infinito após await não bloqueou o timer Host.
> Essa fonte ainda não está no pacote r5; gates globais continuam abertos.

> **Workflow e pacote r5 — 2026-10-08:** catálogo atual 152/95. Workflow passou
> DAG de escrita/verificação, referência durável antes do provider, recuperação
> sem replay e bloqueio de efeito incerto. Regressão da árvore: 357 testes,
> 22 cenários físicos, 222 processos naturais. Chat/restart: três attempts,
> nenhum filho repetido, 47 processos naturais. Pacote r5 anterior ao workflow
> passou 151 capacidades, 93 checkpoints e zero replay; 577 processos naturais.
> Compatibilidade e CLI passaram, 84 e 56 processos naturais. Nenhum instalador
> novo aplicado; padrão legado, certificação global e missão continuam abertos.

> **Correção posterior ao r4 — 2026-10-08:** o r4 falhou no cancelamento de
> pergunta pendente e não foi aprovado. A correção passou o fluxo Electron
> completo de interações, revisão, conclusão e restart: 12 checkpoints, zero
> replay, 82 processos naturais. Perda do stream também mantém o bloqueio de
> efeitos sem recibo. Passaram 212 testes, typecheck e dois cenários Rust reais
> de ACK incerto. Recuperação de 10.000 checkpoints sintéticos: 1.050–1.053 ms,
> 18 payloads lidos; não equivale a 10.000 turnos reais. Evidências no relatório
> de ferramentas. Catálogo 151/96, padrão e instalação continuam inalterados.

> **Fonte posterior ao r3 — 2026-10-08:** revisão da sessão e conclusão de
> tarefas passaram pelo chat, cancelamento e restart com dados isolados.
> Escrita/patch respeitam o escopo da tarefa. Efeitos incertos bloqueiam retries
> em filhos e workflows, inclusive após reabrir checkpoints: 182 testes e dois
> cenários Rust reais passaram, com 21 processos físicos encerrados naturalmente.
> Catálogo 151 (150 de entrada, 1 exclusivo dos filhos), 96 pendentes.
> Regressão ampla: 3.065 testes em 362 arquivos, 547 processos naturais; build
> passou com 69 processos naturais. Pacote r3 antecede essas mudanças.
> Instalação e padrão legado inalterados; missão e certificação global abertas.

> **Pacote árvore r3 confirmado — 2026-10-08:** matriz física passou com 89
> checkpoints recuperados e zero replay do provider; 552 processos encerrados
> naturalmente. Smoke/legado/RAG e CLI também passaram, com 84 e 56 processos.
> Fonte posterior: `self_review` integrado, 173 testes, typecheck e build;
> validação física posteriormente concluída (ver marco acima). Inventário desse
> marco: 150 capacidades (149 na entrada, memo exclusivo dos filhos), 97 pendentes.
> Padrão legado, instalação inalterada, certificação global ainda aberta.

> **Fonte 148 / árvore integrada — 2026-10-08:** criação, retomada, revisão e
> consulta de subagentes entraram no catálogo de desenvolvimento. Reservas
> agregadas cobrem os Jobs dos executores e auxiliares do worker; leitura de
> auditoria sobrevive à expiração sem renovar permissão de retomada. Passaram
> 339 testes focados (17 cenários físicos), build e 3.031 testes amplos.
> HTTP/SSE + worker + Electron passaram com cinco attempts Rust, escrita sem
> replay e histórico após restart; 51 processos encerrados naturalmente.
> O pacote anterior r2 confirmou a correção da referência sanitizada, mas
> antecede o catálogo 148. A matriz empacotada posterior r3 passou. Este marco tinha catálogo 148 / 99,
> padrão legado, instalação inalterada e missão ainda aberta.
> [Evidências e limitações](./tool-improvements.md).

> **Candidato journal verificado / árvore em implementação — 2026-10-08:**
> pacote passou matriz com 84 checkpoints e zero replay, smoke, legado,
> RAG e CLI. Instalador extraído: 4.935 arquivos iguais; não instalado.
> Runner startup aquecido p95 20,162 ms, executor de leitura 0,234 ms e
> cancel ACK ocioso 1,023 ms; escopos e limites no relatório de ferramentas.
> Fonte posterior acrescenta transcrição limitada/cancelável, reserva durável
> de filhos, isolamento do terminal do pai, validação da ancestralidade,
> delegação de workspace com bloqueio das escritas do pai e contadores de
> consumo compartilhados. 104 testes de autoridade e 58 das portas passaram.
> Build e 3.013 testes amplos do adapter passaram (617 processos encerrados
> naturalmente). Oito cenários físicos cobrem pai/filho, aprovação/negação,
> cancelamento isolado, spawn_agent e read_agent_transcript reais. A referência
> do journal é validada por reserva durável, sessão, ator e árvore; sobrevive
> à reabertura e pode ser lida por uma nova execução, sem relançar o filho.
> A fonte seguinte também passou a leitura pela ponte da interface após o pai
> terminar: 37 testes e typecheck, 73 processos naturais. A retomada dos filhos
> também passou 76 testes (dez cenários físicos) e typecheck: 101 processos
> naturais, imagem preservada, escrita confirmada sem replay e reserva exclusiva
> do checkpoint de origem. Lotes de filhos também passaram: 81 testes, incluindo
> 12 cenários físicos com leitores simultâneos e escritores sequenciais;
> 124 processos encerrados naturalmente. A rodada posterior passou 178 testes,
> incluindo 16 cenários físicos: revisão, memo confirmado, netos com progresso
> visível, leitura sem executor ativo e patch com escopo. Foram 170 processos
> naturais; typecheck da leitura fria também passou. Ainda faltam
> recursos agregados, superfícies restantes e prova empacotada da árvore.
> Catálogo 144 / 103, padrão legado e gates abertos.
> [Evidências e pendências](./tool-improvements.md).

> **Pacote e instalador 144 com retomada — 2026-10-08:** matriz com 84 checkpoints
> e zero replay, smoke, legado com worktree, RAG e cinco cenários CLI passaram.
> Os 672 processos encerraram naturalmente; 4.935 arquivos extraídos do instalador
> correspondem ao pacote. Não instalado. Fonte posterior compacta o índice do
> journal, agrupa bootstrap SQLite e impede criação por junction externa:
> 100.000 registros físicos, 18 testes SQLite, 33 de Git e clippy passaram;
> restante da validação em andamento. Catálogo 144 / 103, padrão legado,
> missão e gates globais abertos. [Evidências](./tool-improvements.md).

> **Fonte posterior ao pacote 144 — 2026-10-08:** preparação de retomada usa
> somente o último checkpoint completo e seus deltas, preservando a varredura
> de todos os efeitos. Git de worktree no legado ficou assíncrono/cancelável;
> falha de preparação não continua na pasta principal. Build, nove cenários
> físicos Windows e 2.859 testes amplos passaram. Pacote posterior pendente;
> catálogo permanece 144 / 103. [Medições e limites](./tool-improvements.md).

> **Pacote 144 verificado / instalador 143 — 2026-10-08:** MCP interno abre sob demanda;
> catálogo local, conexão compartilhada e encerramento físico comprovados.
> `mcp__index_project` integrado ao projeto proprietário, com aprovação,
> cancelamento, recibos e resultado incerto sem repetição. 182 testes focados,
> 2.824 amplos e build passaram. Pacote: 84 checkpoints recuperados sem replay;
> smoke, legado, RAG e cinco cenários CLI passaram, com 638 processos encerrados.
> Retomada otimizada é fonte posterior ainda em validação; nada foi instalado.
> Catálogo 144 habilitados / 103 pendentes. Padrão legado e gates globais abertos.
> [Evidências e limites](./tool-improvements.md).

> **Pacote e instalador 143 verificados — 2026-10-08:** matriz física passou
> com 81 checkpoints e zero replay, junto de smoke, legado, RAG e cinco cenários
> CLI. Os 721 processos dessas execuções encerraram. Os 4.935 arquivos extraídos
> do instalador correspondem ao pacote testado. Não instalado; padrão legado.
> Catálogo 143 habilitados / 104 pendentes, missão e gates globais abertos.
> Preparação MCP sob demanda é fonte posterior, ainda em validação.
> [Evidências, hashes e limites](./tool-improvements.md).

> **Fonte 143 posterior — 2026-10-08:** rotas de jobs agora consultam o worker,
> com páginas limitadas e seleção específica do job atual. 58 testes, build e
> fixture de 10.000 jobs passaram: zero listagens no main, quatro consultas em
> 28,1 ms nesta amostra. Leituras de agentes isoladas passaram antes/depois de
> restart, incluindo outro projeto. Pacote anterior passou CLI/smoke/legado/RAG,
> mas a matriz encontrou erros de fixture, corrigidos. Novo pacote pendente;
> último instalador verificado continua 138. Missão e gates globais abertos.

> **Fonte 143 / pacote certificado 138 — 2026-10-08:** quatro consultas de
> agentes usam a aplicação e o projeto da sessão, com limites e cancelamento.
> 178 testes focados, 2.743 testes amplos, build e fluxo físico passaram:
> consultas antes/depois de restart, cinco checkpoints, zero replay. Catálogo
> 143 habilitados / 104 pendentes. Pacote 139 r2 passou a matriz mas falhou em
> RAG/CLI; correções de admissão fria e drain semântico passaram nos testes
> focados e aguardam pacote 143. Último instalador certificado: 138, não
> instalado. Missão e gates globais continuam abertos. [Provas](./tool-improvements.md).

> **Fonte 139 / pacote 138 — 2026-10-08:** pacote de exportação aprovado com
> 76 checkpoints, zero replay, cinco cenários CLI, smoke, legado e RAG. Instalador
> conferido nos 4.935 arquivos, não instalado. Fonte posterior corrige relógio
> compartilhado (514 testes Host + 12 focados, incluindo processos Rust) e integra
> memória MCP (193 testes, build, fluxo físico com 7 checkpoints/zero replay e
> 2.616 testes amplos passaram). Primeiro pacote 139 falhou na inicialização
> nativa; correção separa o prazo de admissão física dos comandos (47 testes
> focados e 522 Host passaram), ainda aguardando novo pacote. Catálogo
> 139 habilitados / 108 pendentes. Missão e gates globais continuam abertos.
> [Evidências e limitações](./tool-improvements.md).

> **Atualização 2026-10-08 — fonte 138 / pacote 137:** exportação nativa integrada;
> 148 testes focados, build e fluxo físico com 601 símbolos, aprovação dentro de
> scripts, cancelamento, ACK perdido e restart passaram. Fonte 138 / 109 pendentes;
> regressão ampla e pacote em preparação. Pacote 137 aprovado: 72 checkpoints,
> zero replay, cinco cenários CLI, smoke, legado e RAG. Instalador 137 comparado
> em todos os 4.935 arquivos, não instalado. [Provas](./tool-improvements.md).
> Missão e gates globais continuam abertos.


> **Fonte 137 — 2026-10-08:** code_exec integrado a autoridade nativa, com permissoes por chamada, budget compartilhado, drain fisico e incerteza persistente. 213 testes focados, 2.566 amplos, build e fluxo fisico com retomada passaram. Cancelamento e ACK perdido tambem passaram, com sete checkpoints e zero replay; 59 processos encerrados. Pacote em preparacao. Pacote anterior CLI 136 passou cinco cenarios CLI, matriz de 68 checkpoints, smoke, legado e RAG; nao instalado. [Provas](./tool-improvements.md). Missao e gates globais permanecem abertos.

> **Pacote 136 — 2026-10-08:** especificações e retomada aprovadas na matriz
> empacotada: 68 checkpoints, zero replay, UI com rejeição/aprovação/retry.
> 509 processos encerrados; smoke, legado e RAG direto passaram, mais 60 encerrados.
> Instalador comparado integralmente por SHA-256, não instalado. Fonte posterior
> corrige resultado incerto em scripts e inclui CLI no ASAR; 77 e 29 testes
> focados, além do build, passaram. Validação empacotada da CLI em preparação.
> Catálogo 136 / 111; missão e gates globais continuam abertos.


> **Atualização 2026-10-08:** pacote 135 com transferência de contexto em partes
> aprovado na matriz (66 checkpoints, zero replay), smoke, legado e RAG direto.
> Instalador conferido por SHA-256 em todos os 4.933 arquivos; não instalado.
> A fonte posterior integra `submit_spec` (catálogo 136 / 111) e otimiza a retomada
> pela última cadeia completa. 165 testes de especificação/política/interações e
> 23 de recovery passaram, além de 2.540 testes amplos. Fluxo físico de
> especificação, rejeição/aprovação e leitura/escrita após restart aprovado;
> 69 processos encerrados. Pacote dessa fonte em preparação.
> A missão e todos os gates globais permanecem abertos. [Provas](./tool-improvements.md).

> **Pacote 135 / 112 — 2026-10-08:** nove ferramentas de tarefas/checklists,
> aprovação identificada e limpeza preservada no restart. Corrigido também o
> limite do writer que rejeitava checkpoints acima de 256 KiB. 182 testes focados,
> 2.446 amplos e build aprovados. Matriz empacotada: 66 checkpoints, zero replay,
> upgrade existente preservado; 491 processos encerrados sem cleanup forçado.
> Smoke, legado e RAG direto aprovados, 60 processos encerrados. Instalador com
> 4.933 arquivos comparados por SHA-256; não instalado. Nenhum gate global promovido.
> Este registro descreve o pacote anterior de checkpoints; o pacote posterior de
> contexto em partes foi validado conforme a atualização acima.

> **Fonte posterior ao pacote 126 — 2026-10-07:** cancelamento encaminhado nas
> revisões próprias/de subordinados, no provider e no failover; backoff cancelável,
> listeners liberados e busca auxiliar aguardando encerramento real. Build e
> 2.422 testes/297 arquivos aprovados; 68 processos do build e 386 da regressão
> encerrados. Alterações incluídas no pacote 135 acima, sem admissão nativa dessas ferramentas.

> **Pacote 126 / 121 — 2026-10-07:** `manage_path` nativo com rename exclusivo,
> correção do upgrade 268 e fechamento de SQLite em falha de inicialização.
> Build, 2.336 testes/287 arquivos, quatro testes físicos Rust e Clippy aprovados.
> Matriz empacotada: 64 checkpoints, zero replay e upgrade de projeto existente
> com dados preservados. Smoke, chat legado e RAG direto aprovados. Os 476
> processos da matriz e 60 da compatibilidade encerraram. Instalador corrigido
> gerado, sem instalação no PC. [Provas e limites](./tool-improvements.md).

> **Regressão reportada pelo usuário — 2026-10-07:** o pacote 125 falha ao abrir
> certos projetos existentes: migração 268 assume `semantic_jobs`, tabela
> intencionalmente ausente no banco de projeto. Os testes anteriores cobriam
> perfis novos e não certificavam esse upgrade. Correção no fonte, 13 testes
> de banco e upgrade físico pelo chat no pacote 126 aprovados.
> O pacote 125 não está aprovado para esse cenário de upgrade.

> **Skills empacotadas — 2026-10-07:** pacote **125** aprovado: 63 checkpoints,
> zero replay, smoke, legado e RAG direto. Os 468 processos da matriz e 60 da
> compatibilidade encerraram. Essa aprovação histórica cobria perfis novos;
> a regressão de upgrade acima exige o pacote 126. Fonte, hash e relatórios em
> [provas](./tool-improvements.md). Instalação preservada.

> **Memória empacotada — 2026-10-07:** pacote **124** aprovado: 60 checkpoints,
> zero replay, smoke, legado e RAG direto. Os 450 processos da matriz e 60 da
> compatibilidade encerraram naturalmente. Fonte **125 / 122** acrescenta criação
> de skills com catálogo de gatilhos limitado e atualização sob autoridade;
> 2.309 testes em 283 arquivos, build e fluxo físico de reinício aprovados.
> Pacote de skills em preparação. Instalação do usuário e runtime padrão preservados.

> **Memória e cleanup — 2026-10-07:** pacote **122** aprovado após retomar os
> testes interrompidos: 59 checkpoints, zero replay, smoke, legado e RAG direto.
> Job do Windows confirmou zero ativos entre 441 processos da matriz e 60 da
> compatibilidade. Fonte **124 / 123** integra escrita/arquivo de memória,
> com **2.291 testes em 281 arquivos**, build e teste físico de reinício aprovados.
> Os 44 processos físicos, 68 do build e 370 da regressão encerraram. Pacote em curso.
> Todos os testes novos registram PIDs e contêm a árvore inteira.
> [Provas](./tool-improvements.md) e [cleanup](./test-process-ownership.md).

> **Descoberta e dados de sessão — 2026-10-07:** pacote de **117 ferramentas**
> aprovado: 58 checkpoints, zero replay, nenhum Electron de teste restante,
> smoke, legado e RAG direto. Descoberta respeita o catálogo da attempt e replay
> de histórico não dispara exportação de diagramas.
> Fonte **122 / 125** acrescenta notas, planos e histórico: **2.220 testes em
> 275 arquivos** e build aprovados; sessão legada preservada no fluxo físico,
> incluindo capítulos, plano, notas e reinício. Novo pacote ainda pendente.
> Instalação e runtime padrão preservados. [Provas](./tool-improvements.md).

> **Leitores MCP — 2026-10-07:** pacote de 97 ferramentas aprovado na matriz
> completa, smoke, legado e RAG direto; nenhum Electron de teste restante.
> Hierarquia, implementações e corpo atual de símbolos levam a fonte a
> **100 / 147**, em validação. Instalação do PC preservada. [Provas](./tool-improvements.md).

> **Custos e modelos — 2026-10-07:** pacote de 94 ferramentas validado, com 49
> checkpoints sem replay, nenhum Electron de teste restante, smoke, legado e
> RAG direto aprovados. Diretórios passaram no produto; leitura e símbolos MCP
> levam a fonte a **97 / 150**, ainda em validação. [Provas](./tool-improvements.md).

> **LSP corrigido e validado no pacote — 2026-10-07:** o crash fatal do V8 foi
> reproduzido e o candidato afetado reprovado. Novo pacote de 92 ferramentas usa
> processo LSP contido: matriz com 47 checkpoints, zero replay, nenhum Electron
> de teste restante, legado, RAG direto e 45 términos físicos aprovados. Custos
> e modelos posteriores elevam a fonte a **94 / 153**, em validação. Runtime
> padrão e instalação continuam legados. [Provas](./tool-improvements.md).

> **Consultas estruturais MCP — 2026-10-07:** pacote com 89 ferramentas aprovado;
> 47 checkpoints sem replay, nenhum processo Electron de teste restante, smoke
> do ASAR e fallback legado aprovados. Os aliases de documentação posteriores
> levam o catálogo fonte a **92 / 155**, com 1.891 testes aprovados; validação
> física em andamento. [Provas e limites](./tool-improvements.md).

> **Navegação de código — 2026-10-07:** pacote Windows com 84 ferramentas
> aprovado; 46 checkpoints sem replay, nenhum processo Electron de teste restante.
> Paginação, alterações em dependências, cancelamento e terminação do worker TS
> real passaram; fallback legado e smoke do ASAR aprovados. As consultas
> estruturais posteriores levam o catálogo fonte a **89 / 158**, com 1.880 testes
> aprovados; a validação empacotada consta no registro acima. [Provas e limites](./tool-improvements.md).

> **Diagnóstico e recursos MCP — 2026-10-07:** pacote Windows com 80 ferramentas
> aprovado; 44 checkpoints sem replay, checker e descendente encerrados após
> cancelamento, nenhum processo Electron de teste restante. Fallback legado e
> smoke do ASAR aprovados. A integração LSP posterior eleva o catálogo fonte
> a **84 / 163**, ainda em validação. [Provas e limites](./tool-improvements.md).

> **Documentação indexada — continuação de 2026-10-06:** pacote Windows com 77
> ferramentas validado, 42 checkpoints sem replay, nenhum processo de teste
> remanescente. Paginação de documentos grandes e busca por projeto passaram
> no produto; fallback legado e smoke do ASAR aprovados. A etapa posterior de
> diagnóstico e recursos MCP leva o catálogo fonte a **80 / 167**; 1.857 testes
> aprovados, validação física em andamento. [Provas e limites](./tool-improvements.md).

> **Web pública — continuação de 2026-10-06:** pacote Windows com 74 ferramentas
> validado, 41 checkpoints sem replay, nenhum processo de teste remanescente.
> Sobreposição de leituras HTTPS, publicação individual, cancelamento e fechamento
> dos sockets passaram; fallback legado e smoke real dos workers no ASAR também.
> A documentação indexada posterior eleva o catálogo fonte a **77 / 170**;
> regressão de 1.823 testes aprovada, etapa física em validação. Default legado
> e instalação preservados. [Provas e limites](./tool-improvements.md).

> **Coleções de API — continuação de 2026-10-06:** pacote Windows com 72
> ferramentas validado, 39 checkpoints sem replay e nenhum processo de teste
> remanescente. Importação, execução, login, cancelamento de rede e scripts,
> ACK perdido e fallback legado passaram. QuickJS executa no ASAR em worker
> isolado; 1.756 testes na regressão ampla. A integração posterior de web
> está validada conforme o registro acima. Default legado e
> instalação do usuário preservados. [Provas e limites](./tool-improvements.md).

> **HTTP nativo — continuação de 2026-10-06:** 65 ferramentas habilitadas no
> pacote Windows validado, 34 checkpoints recuperados sem replay e sem processos
> de teste remanescentes. Cookies, cancelamento, perda de ACK e bloqueio de
> retomada comprovados; fallback legado aprovado. Regressão ampla: 1.599 testes.
> As sete ferramentas de API posteriores elevam o catálogo fonte a **72 / 175**;
> ainda estão em validação, incluindo correção do módulo de scripts no Electron.
> [Provas e limites](./tool-improvements.md).

> **Recuperação nativa de resultados grandes — continuação de 2026-10-06:**
> `get_tool_output` lê conteúdo confirmado pelo writer Rust, inclusive após
> restart e alteração da fonte. Falha de persistência não publica um ID como
> durável. 82 testes focados, 1.585 na regressão ampla e fluxo físico aprovados.
> Catálogo dessa etapa: **64 habilitadas / 183 pendentes**. Matriz empacotada
> e fallback legado aprovados: 30 checkpoints sem replay e nenhum processo de
> teste remanescente. A etapa HTTP posterior está registrada acima.

> **Bancos nativos — continuação de 2026-10-06:** quatro ferramentas integradas
> com conexões privadas por attempt, revisão do cadastro, segredos no gateway e
> barreira de resultado incerto. SQLite executa em processo contido pelo Rust;
> Redis não repete comandos cuja confirmação foi perdida. Fluxo físico do
> produto passou em conclusão, cancelamento, ACK perdido e restart, preservando
> conexões emprestadas. Catálogo atual: **63 habilitadas / 184 pendentes**.
> Matriz empacotada aprovada: 29 checkpoints sem replay, nenhum processo de
> teste remanescente, fallback legado aprovado no mesmo pacote. Regressão ampla:
> 1.572 testes. Todos os engines remotos e gates de rollout seguem abertos.
> [Provas e limites](./tool-improvements.md).

> **Browser nativo — continuação de 2026-10-06:** oito ferramentas integradas
> com contextos isolados por attempt e fechamento confirmado. Teste físico
> Rust/Electron/Chrome passou em conclusão, cancelamento, ACK perdido e restart;
> seis checkpoints recuperados sem replay, nenhum processo de teste restante.
> Catálogo atual: **59 habilitadas / 188 pendentes**, entre 247 nomes próprios.
> Regressão ampla: 1.533 testes; build e matriz empacotada aprovados: 25 checkpoints
> recuperados sem replay. Fallback legado aprovado no mesmo pacote.
> O runtime padrão e a instalação do usuário permanecem os certificados anteriores.
> [Provas e limites](./tool-improvements.md).

> **Preview nativo no checkout — continuação de 2026-10-06:** 22 ferramentas
> integradas à autoridade da attempt, com fencing no CDP, janelas isoladas e
> servidores em Jobs nativos. 132 testes focados e fluxo físico Rust/Electron
> das 22 ferramentas passaram, inclusive cancelamento e ausência de órfãos.
> Catálogo atual: **51 habilitadas / 196 pendentes**, entre 247 nomes próprios.
> Matriz empacotada, ACK perdido e restart aprovados: 22 checkpoints recuperados,
> nenhuma repetição do efeito incerto e nenhum órfão. Regressão ampla: 1.497 testes.
> Há também correções posteriores de bancos, com 213 testes aprovados, ainda fora
> desse pacote. Os instaladores anteriores continuam preservados.
> [Provas atuais](./tool-improvements.md).

> **Persistência e ferramentas no pacote em 2026-10-06:** fs-store e contratos
> puros de compactação foram extraídos para session-storage, preservando APIs e
> formatos. Passaram 1.444 testes de ferramentas, 268 de persistência/consumidores
> e 21 cenários Rust físicos. O pacote separado validou os 22 previews em Electron
> real, a matriz Rust com 19 checkpoints recuperados sem replay e o fallback
> legado. Catálogo nativo continua com 29 nomes; integração das demais famílias
> e gates globais permanecem abertos. [Provas e limites](./tool-improvements.md).

> **Instalador de ferramentas separado:**
> `dist/electron-tools-review-20261006/CodeStudio-Tools-Candidate-2026-10-06.exe`.
> Seus 4.856 arquivos conferem com o pacote testado. O código desse pacote
> preservou 30 tabelas de configuração numa nova cópia do banco e leu os 16
> journals da amostra anterior. Instalador sem Authenticode, não executado;
> perfil e aplicativo instalados continuam intactos. [Detalhes](./tool-improvements.md#entrega-e-instalação).

> **Todas as ferramentas em 2026-10-06:** inventário reproduzível registra 247
> nomes próprios, com 29 habilitados no Rust de desenvolvimento e 218 pendentes.
> Melhorias comuns de cancelamento, MCP, preview/browser, streaming de plugins e
> pools de banco estão no checkout, posteriores ao instalador congelado.
> [Inventário completo](./tool-inventory.md) · [Alterações, provas e pendências](./tool-improvements.md).

> **Perfil instalado em 2026-10-06:** migrations do candidato passaram numa
> copia consistente do banco 0.5.2; valores de 22 tabelas de configuracao
> permaneceram identicos. Leitor empacotado validou uma amostra de 16 journals.
> Instalacao do usuario continua aberta e sem atualizacao; confirmacao para
> encerrar o aplicativo esta pendente. [Evidencias e escopo do backup](./10-harness-performance-2026-10-03.md#compatibilidade-do-perfil-instalado-e-trace-do-candidato--2026-10-06).

> **Writer posterior ao candidato:** projecao privada evita copiar novamente
> o prefixo dos checkpoints. 21 testes focados e oito fisicos passaram;
> serializacao ainda linear. Incluído no pacote separado tools-review-20261006,
> cuja matriz de conversa/restart e fallback passou; não foi instalado no PC.
> [Evidencias e benchmark](./10-harness-performance-2026-10-03.md#projecao-privada-do-checkpoint-do-provider--2026-10-06).

> **Instalador candidato em 2026-10-06:** gerado localmente, ainda nao instalado
> no PC. MCP em worktree valida o lease admitido; provisionamento fisico ocorre
> depois do carregamento dos modulos. 25 testes, pacote/restart e fallback
> passaram. Payload do instalador confere com o pacote testado. Candidato sem
> Authenticode; default legado e gates de certificacao permanecem.
> [Evidencias](./10-harness-performance-2026-10-03.md#mcp-em-worktrees-e-provisionamento-tardio--2026-10-06).

> **Perfis em 2026-10-06:** coordenacao compartilhada preserva o ledger antigo
> de cada perfil. Leituras nativas coexistem; escritas e geracoes conflitantes
> sao recusadas entre processos/perfis. MCP confirma ambas as autoridades.
> Matriz Windows combinada e fallback passaram; 19 checkpoints sem replay.
> Drain de ativacao e reconciliacao de owners anteriores permanecem gates.
> [Evidencias](./10-harness-performance-2026-10-03.md#coordenacao-de-workspace-entre-perfis--2026-10-06).

> **MCP em 2026-10-06:** listagem usa metadados limitados e carrega somente
> a pagina solicitada. Quota inclui ativos antigos e falha fechada quando a
> consulta de ownership falha. Pacote/restart e fallback passaram; benchmark
> sintetico de 10.000 sessoes p95 2,71 ms mede apenas o componente de consulta.
> [Evidencias](./10-harness-performance-2026-10-03.md#consulta-limitada-de-runs-mcp--2026-10-06).

> **Preparacao/ACK em 2026-10-06:** writer e autoridade permanecem retidos ate
> confirmar preparacao e drain. ACK de inicio perdido nao admite outro executor;
> sem ACK de limpeza, HTTP preserva o comando e informa estado incerto. Tres
> cenarios passaram no pacote; matriz combinada recuperou 19 checkpoints sem
> replay e fallback legado passou.
> [Evidencias](./10-harness-performance-2026-10-03.md#preparacao-interrompida-e-ack-perdido--2026-10-06).

> **Interacoes em 2026-10-06:** perguntas, decisoes e planos usam a fachada
> nativa com ID duravel, sem runner legado. Recarga, falha/reenvio da resposta,
> escrita condicionada ao plano e cancelamento passaram na interface do pacote
> Windows. A matriz combinada recuperou 16 checkpoints sem replay; fallback
> legado passou. Crash do owner durante interacao, spec/tasks/goals e paridade
> das demais superficies continuam pendentes.
> [Evidencias](./10-harness-performance-2026-10-03.md#interacoes-humanas-na-fachada-nativa--2026-10-06).

> **CLI e MCP publico em 2026-10-06:** a CLI usa o gateway/fachada do produto
> sem importar o executor legado. Conversa, retomada, escrita aprovada, cancelamento
> e falha passaram em processos CLI reais. MCP publico preservou resultados e
> classificacoes depois de restart no pacote Windows, com 11 checkpoints sem replay.
> ACK de cancelamento, recibo terminal e drain fisico agora possuem barreiras
> distintas. Distribuicao CLI independente, paridade completa e rollout permanecem
> pendentes. [Evidencias](./10-harness-performance-2026-10-03.md#cli-e-mcp-publico-pela-fachada--2026-10-06).

> **Historico paginado em 2026-10-06:** janelas e contagens sao resolvidas
> antes do transporte worker/main, sem copiar toda a conversa. Runner real,
> pacote com consultas ao vivo/restart e fallback legado passaram.
> A prova de 10.000 turnos e sintetica no componente de transporte; a sessao
> nativa completa desse tamanho continua pendente.
> [Evidencias](./10-harness-performance-2026-10-03.md#historico-com-transporte-limitado-por-consulta--2026-10-06).

> **Contexto proativo em 2026-10-06:** memoria e capitulos entram na fronteira
> do provider com espera maxima de 300 ms por tarefa. Resultados tardios entram
> apenas na proxima fronteira, cujo conteudo exato e persistido antes do envio.
> Runner real, checkpoint/cancelamento, pacote Windows e fallback legado passaram.
> Compaction e preparacao das demais superficies continuam pendentes.
> [Evidencias](./10-harness-performance-2026-10-03.md#contexto-proativo-na-fronteira-nativa--2026-10-06).

> **Terminal real em 2026-10-06:** tty=true usa ConPTY nativo com geometria
> validada e Job Object. O pacote confirmou isTTY, stdin entre turnos,
> aprovacao por efeito, restart do historico e reap dos processos rastreados.
> Servidores entre attempts e reconexao de processos vivos continuam pendentes.
> [Evidencias](./10-harness-performance-2026-10-03.md#terminal-conpty-no-pacote-windows--2026-10-06).

> **Comandos persistentes em 2026-10-06:** exec_command/write_stdin/list_sessions
> usam sessoes pipe pertencentes a attempt e processos contidos por Job Object.
> O pacote confirmou stdin entre turnos, stderr ao vivo, aprovacao e historico
> apos restart. Corrigida corrida no recibo de cancelamento com fila cheia.
> PTY/ConPTY e servidores que sobrevivem a attempt continuam pendentes.
> [Evidencias e limites](./10-harness-performance-2026-10-03.md#comandos-persistentes-contidos--2026-10-06).

> **Worktrees em 2026-10-06:** criacao e reabertura entram antes do contexto
> selado, com Git contido e raiz validada. O pacote confirmou escrita isolada,
> persistencia, follow-up e restart. Corrigido o catalogo de metadados obsoleto
> do processo principal. [Evidencias e limites](./10-harness-performance-2026-10-03.md#worktrees-no-fluxo-nativo-e-metadados-atualizados--2026-10-06).

> **Exclusao de geracoes em desenvolvimento:** reserva duravel por perfil no
> ponto comum Coder/CLI/Company, com retencao de efeitos incertos e heranca por
> subagentes. Drain de ativacao, multiplos perfis e reconciliacao de processos
> legados continuam gates; isso nao certifica Company/subagentes em Rust.
> [Implementacao e provas](./10-harness-performance-2026-10-03.md#exclusao-entre-geracoes-no-cohort-de-desenvolvimento--2026-10-06).

> **Limites de canal em 2026-10-06:** o Coder interrompe o provider antes de
> esgotar identidades Data/Control/Management, preservando reserva para terminal
> e reap. Texto parcial confirmado entra na continuacao; recovery continua
> bloqueado para efeitos incertos. Data + retomada e Management passaram em
> processos reais. Rotacao autenticada, soak de 24h e canario continuam abertos.
> [Evidencias](./10-harness-performance-2026-10-03.md#encerramento-antes-do-limite-de-canal--2026-10-06).

> **Autoridade em 2026-10-06:** renovacao confirmada pelo supervisor, sem
> ampliar hard deadline nem reativar lease vencido. Corrigido o teto acidental
> de 257 mensagens Control; 1.000 heartbeats e a execucao fisica de 610 segundos
> passaram. Pacote nativo/legado, recovery e cleanup passaram.
> [Evidencias e limites](./10-harness-performance-2026-10-03.md#renovacao-da-autoridade-fisica--2026-10-06).

> **Streaming em 2026-10-06:** corrigidos os limites de resposta e de conexao
> que reutilizavam a cota de IPC. Deltas contiguos sao agrupados com limites
> de tempo/bytes e primeiro fragmento imediato. Credito autenticado por consumo
> limita a fila Rust durante persistencia; 58 testes fisicos passaram.
> [Contrato e evidencias](./10-harness-performance-2026-10-03.md#streaming-nativo-e-limites-independentes--2026-10-06).


> **Orcamentos em 2026-10-06:** policy selada limita turnos, ferramentas e
> tempo no runner. O teto artificial de dois minutos foi removido; deadlines
> de execucao e confirmacao foram separados, inclusive durante aprovacao.
> Renovacao da autoridade foi integrada ao Coder Windows e validada em uma
> attempt fisica de 610 segundos. Cotas sao finitas; encerramento antecipado
> foi integrado, sem promover duracao ilimitada nem certificar o soak.
> [Implementacao e evidencias](./10-harness-performance-2026-10-03.md#orcamentos-de-execucao-e-confirmacao-duravel--2026-10-06).

> **Inventario A01–A20 em 2026-10-06:** [manifesto do checkout](./surface-manifest.json)
> registra entry points existentes, cobertura nativa, pendencias e condicoes
> de retirada por superficie. O default permanece legacy_ts; nenhuma linha
> esta marcada como certificada. Disposicao completa de simbolos/dados e
> grafo resolvido ainda precisam fechar M0.

> **MCP stdio em 2026-10-06:** transporte local contido por Job Object,
> filas limitadas e encerramento comprovado de descendentes. Runner Rust e
> pacote Windows passaram por resposta perdida, bloqueio de continuação e
> restart; sete attempts reconciliadas sem replay.
> [Evidência e limites](./10-harness-performance-2026-10-03.md#mcp-stdio-contido-e-integrado-ao-produto--2026-10-06).

> **MCP de rede nativo em 2026-10-06:** sete attempts recuperadas no pacote,
> efeito remoto executado uma vez e continuação bloqueada antes/depois do reinício.
> [Evidência e limites](./10-harness-performance-2026-10-03.md#mcp-de-rede-no-cohort-rust--2026-10-06).

> **Skills/memória e MCP em 2026-10-06:** o pacote nativo validou seleção de
> skill no compositor, contexto preservado na continuação, consulta explícita
> de memória cancelável e reinício com seis attempts sem replay. O transporte
> MCP compartilhado agora usa o catálogo em cache, preserva resultados completos
> e não repete chamadas após perda de resposta. Resultado incerto encerra a
> execução e permanece no histórico; 77 testes focados/físicos passaram.
> MCP HTTP/SSE foi integrado ao cohort nativo e validado no pacote, incluindo
> resposta perdida, autoridade no envio e bloqueio após reinício. Stdio foi
> integrado na atualização acima; plugins fora do MCP, reconciliação operacional e exclusão de workspace entre runtimes seguem pendentes.
> [Evidências](./10-harness-performance-2026-10-03.md#skills-selecionadas-e-contexto-durável--2026-10-06).

> **Histórico ativo em 2026-10-06:** consultas HTTP agora usam a projeção
> incremental do writer nativo no worker. Fotografias do writer não releem o
> journal; snapshots parciais preservam os resultados concorrentes. O pacote
> passou por três leituras de histórico com provider pendente, continuação por
> max_turns com imagem e reinício sem replay. Isso amplia M3/M5; scans de
> abertura/admissão, histórico extenso, transporte paginado e gates globais
> permanecem abertos. [Evidência](./10-harness-performance-2026-10-03.md#histórico-incremental-no-writer-ativo--2026-10-06).


> **Continuação em 2026-10-06:** `/continue` agora inicia um novo comando nativo
> sobre histórico validado, sem mensagem artificial nem repetição da ferramenta.
> O contrato distingue `SESSION_CONTINUATION` da recuperação de uma attempt.
> Resultado incerto permanece bloqueado, e histórico divergente é rejeitado.
> O pacote Windows passou por continuação, ferramentas, cancelamento e reinício;
> seis attempts reconciliadas sem provider replay. M3 continua parcial para
> recovery automático, fronteira posterior a efeitos sem checkpoint e sessões
> extensas. [Evidência](./10-harness-performance-2026-10-03.md#continuação-entre-comandos-e-resultados-incertos--2026-10-06).

> **Busca e comandos em 2026-10-06:** `mcp__search`/`mcp__grep_code` têm contrato
> explícito de leitura e cancelamento; `run_command` e ferramentas Git usam
> Job Objects Windows pela ponte nativa. Aprovação, recusa, cancelamento com
> descendente vivo, limite de saída e reap passaram em testes físicos. O pacote
> Windows aprovou comando + Git, busca MCP, imagens e reinício com doze mensagens.
> A leitura de histórico reabre no máximo três vezes quando uma gravação invalida
> sua fotografia. Isso amplia M2/M4; não fecha isolamento entre runtimes,
> PTY/sessões persistentes, MCP externo/plugins, retomada ou canário.
> [Evidência](./10-harness-performance-2026-10-03.md#busca-comandos-contidos-e-disputa-no-histórico--2026-10-06).

> **Catálogo e conteúdo em 2026-10-06:** escrita aprovada, recusa, cancelamento
> durante aprovação e `view_image` atravessam a composição nativa. O pacote
> Windows exibiu a imagem pela prévia lazy, preservou onze mensagens após novo
> comando/reinício e reconciliou quatro attempts sem provider replay. Falha de
> preparação anterior ao launch libera o lease que adquiriu. Isso amplia M2/M3/M4;
> comandos/Git, catálogo MCP/plugins, retomada interrompida e gates de rollout
> permanecem pendentes. [Evidência](./10-harness-performance-2026-10-03.md#imagens-de-ferramentas-no-provider-interface-e-replay--2026-10-06).

> **Execução de 2026-10-06:** outbox física agora durável em Rust e reconciliada
> no startup, inclusive com a flag nativa desligada. Reinício completo do pacote
> Windows preservou nove mensagens/anexos e reconciliou três attempts sem
> repetir provider nem deixar PIDs. Anexos idênticos deixam de ser duplicados
> entre commands. M2 segue parcial: essa prova ainda não cobre rehydration antes
> do reap ou processos Host sobreviventes. [Evidência atual](./10-harness-performance-2026-10-03.md#outbox-durável-reinício-e-anexos-sem-duplicação--2026-10-06).

> **Execução após aprovação do plano, 2026-10-05:** o worker agora oferece uma
> rota nativa explícita de desenvolvimento (`CODESTUDIO_NATIVE_CODER_DEV=1`).
> A conversa digitada no compositor atravessou a fachada, provider TS,
> quatro leituras Host, segundo turno e cancelamento no pacote Windows.
> O histórico nativo também sobreviveu ao reload pela API pública, sem abrir
> outro writer; duas mensagens consecutivas na mesma sessão produziram nove
> mensagens recuperadas no pacote Windows. Locks de writer/workspace passaram
> na prova de morte do processo. Essa evidência fecha o cenário funcional de M1 no cohort de
> leitura; M0 completo, M2–M6, paridade e promoção continuam pendentes.
> [Registro de implementação](./10-harness-performance-2026-10-03.md#integração-do-produto-e-histórico-em-2026-10-05).

> **Plano executivo vigente: 2026-10-05.** A sequência, os critérios de entrega
> e as estimativas estão em [Plano de execução atualizado](#plano-de-execução-atualizado--2026-10-05).
> O fluxo normal do aplicativo ainda usa o legado. O E2E empacotado de outubro
> não certifica cutover Rust. Os snapshots anteriores abaixo são históricos.

> Atualização de desempenho (2026-10-03): [implementação, medições e lacunas](./10-harness-performance-2026-10-03.md).
> Projeções incrementais, paginação Rust por fotografia e correções do renderer
> foram implementadas. Isso não certifica integração da fachada, paridade ou cutover.
> **Atualização física de 2026-10-05:** admission/ativação nativa pelo ledger do
> produto, contexto com histórico/anexo, ferramentas Host reais, recusa durável,
> lotes de quatro leituras Host com resultado imediato e cancelamento/reap foram
> implementados e testados. [Evidências e lacunas](./10-harness-performance-2026-10-03.md#continuação-de-2026-10-05-preparação-real-conteúdo-durável-e-leituras-host-concorrentes).
> O worker principal ainda usa `legacy_required`; os gates globais abaixo não
> são considerados concluídos por essas provas de integração.
> **Candidato medido em 2026-10-05:** concorrência também no dispatcher do
> produto; seleção de jobs de documentos no worker; IDs públicos de tool por
> turno; `message_complete`, usage e thinking preservados no fluxo nativo.
> 832 testes backend/contratos, 231 renderer, 27 SQL, 652 Rust e 13 cenários
> físicos passaram. Pacote Windows validado com leitura/retomada/aprovação/cancel.
> [Medições, hashes e pendências](./10-harness-performance-2026-10-03.md#candidato-validado-em-2026-10-05-produto-interface-e-continuidade-nativa).

> **Status inicial histórico:** nenhum gate aprovado
> **Versão histórica da implementação:** 1.36.0
> **Atualização:** este é o único arquivo do corpus em que checkboxes de avanço
> são alterados.
> **Snapshot operacional histórico:** 2026-08-05. O pacote Windows candidato e o E2E
> process-real atravessam lifecycle, provider TS, policy Host, engine Rust,
> `native.read_file`, nove commits no session journal filesystem Rust e o
> segundo provider turn. Uma prova duplex adicional cruza sete receipts.
> Falha live do executor pós-started agora termina como `outcome_unknown`, sem
> retry, e volta ao provider como resultado de erro.
> Store/bridge/Host também paginam receipts, leem payloads por prova exata e
> detectam started órfão com teto total fail-closed.
> Pulse/heartbeat, métricas reais, Cancel/Fence, Control/Data/management
> permanentes, Exited/Reaped duráveis e o Gateway de capability também foram
> reexecutados. Os gates globais de CI,
> soak, canário e matriz multiplataforma
> continuam abertos.

“Spec final” significa texto normativo congelado; não significa implementação
concluída. Por isso todos os checks começam vazios até owner e evidência serem
registrados.

## Plano de execução atualizado — 2026-10-05

### Situação verificada e limite desta revisão

**Nota de execução:** os parágrafos desta subseção registram o ponto de partida
do planejamento. A integração e as provas posteriores constam no registro acima;
não usar a descrição histórica de “handoff pendente” como estado atual de M1.

Esta revisão conferiu código, entry points, manifestos e relatórios locais. Não
alterou implementação nem reexecutou as suítes. Os resultados de testes abaixo
são os relatórios do candidato de 2026-10-05, não uma nova certificação.

O caminho normal ainda termina em `runCoder → CoderRunner.run`; o adapter SSE
seleciona `legacy_required`. `activateNativeCoderRuntimeFacade` e
`prepareNativeCoderContext` existem, mas não recebem a conversa iniciada pelo
worker normal. Esse handoff é a primeira entrega funcional pendente.

| Área | Implementação/evidência existente | Trabalho que falta para uso normal |
|---|---|---|
| Entrada e providers | Fachada, preparação nativa, gateway TS e admission pelo ledger real; testes com processos Windows | Ligar preparação/seleção do worker à fachada sem iniciar também o runner legado; conservar provider/modelo e opções da sessão |
| Ferramentas e desempenho | Leituras concorrentes, resultados individuais duráveis, barreiras de mutação, HostCapability e policy; melhorias também no dispatcher legado | Autoridade real de workspace, catálogo completo no fluxo do produto, imagens/artefatos devolvidos por tools e certificação dos contratos públicos |
| Persistência | Projeção incremental, paginação por fotografia validada, checkpoint da fronteira do provider e detecção de efeitos incertos | Leitores HTTP/histórico nativos, reabertura real, recuperação autorizada e projeções completas sem criar um segundo writer |
| Supervisor | Management permanente e fatos físicos confirmados no Host | Outbox Rust sobrevive apenas em memória; faltam recovery/rehydration duráveis e prova de multi-launch pela composição do produto |
| Interface e Electron | Virtualização do turno ativo, orçamento de eventos, scans pesados de jobs em worker e consultas limitadas | Medir a composição nativa empacotada com projetos/sessões representativos; consultas pontuais síncronas ainda existem |
| Outras superfícies | MCP já consome HTTP; CLI chama `runCoder`; Company/DocsAgent ainda dependem de runners legados | Adaptar CLI e demais entradas; verificar MCP sobre os leitores nativos; migrar Company/subagentes por árvore inteira |

Foram registrados 832 testes backend/contratos, 231 renderer, 27 SQL, 652 Rust
e 13 cenários físicos aprovados, com os skips discriminados no
[relatório do candidato](./10-harness-performance-2026-10-03.md#candidato-validado-em-2026-10-05-produto-interface-e-continuidade-nativa).
Esses totais não medem percentual de migração.

O E2E empacotado aprovado executou **legacy**, com provider determinístico em
loopback. O benchmark de dispatch de 0,301 ms não inclui IPC Host, policy ou
journal; o cancelamento nativo de 1,401 ms foi medido em attempts ociosas.
O trace novo não reproduziu o congelamento antigo de 8,759 s; isso não identifica
a causa nem prova que o problema desapareceu em projetos reais.

### Entregas e estimativa de esforço restante

Premissa de capacidade: uma frente dedicada, aproximadamente seis horas de
engenharia focada por dia útil, sem tarefas concorrentes. Estimativas incluem
implementação e verificação; são julgamento técnico a partir das lacunas, não
velocidade histórica medida. Não representam execução automática em segundo
plano nem compromisso de data sem essa capacidade alocada.

| Entrega | Definição de concluído | Estimativa restante |
|---|---|---|
| E1 — programação Windows em piloto interno | Conversa pela interface em Rust, leitura/busca, edição/patch, comandos/Git, imagens, MCP/plugins como tools, interações, cancelamento, histórico e retomada; pacote validado, C0 e rollback | Base de 22–35 dias úteis + cerca de 25% de reserva: planejar **28–44 dias úteis (6–9 semanas)**; inclui o piloto I0 exigido pelo corpus |
| E2 — migração funcional das demais superfícies Windows | E1 mais CLI, MCP público, DocsAgent/plugin assistant e Company/subagentes/pipelines/AppStudio aplicáveis, com árvores inteiras e paridade por superfície | **12–20 dias úteis adicionais**, incluindo reserva; total acumulado de aproximadamente **8–13 semanas**, antes da certificação global |
| E3 — promoção completa e retirada global do legado | Plataformas/ambientes restantes certificados, C0–C5, drain comprovado, rollback exercitado e remoção dos imports/flags/workers antigos autorizada pelos gates | **Piso de 35 dias corridos de canário**, contado desde C0, além do volume mínimo e do trabalho restante de plataformas/limpeza; esse trabalho ainda precisa de estimativa em M0 |

A faixa de E1 tem confiança moderada-baixa até M1/M2: a preparação do produto
ainda está acoplada ao runner, e lease/recovery cruzam várias fronteiras. E2 tem
confiança menor até o inventário A01–A20 de M0. Não converter essas faixas em
uma data garantida. Reestimar ao fechar M1 e M2, com esforço real e lista
restante, sem reiniciar a contagem do que já foi gasto.

O indexador Rust completo `GI/indexd` é um trilho separado. Entretanto, o corpus
atual exige seu **piloto I0 (walker/hasher)** antes do canário do agente. Não há
`native/index-runtime` no checkout. O plano conservador inclui 3–5 dias base para
I0; I1–I4 ficam fora de E1/E2. A retirada dessa dependência exigiria revisão
explícita da decisão arquitetural, não uma omissão no cronograma. As otimizações
do serviço semântico/Electron continuam no escopo.
Providers, credenciais e ferramentas Host podem permanecer em TypeScript,
conforme o plano solicitado. Não condicionar a entrega a portar todas as tools.
O adapter OSS permanece versionado e em comparação; nenhum modelo é trocado.

### Sequência obrigatória para E1

| Marco | Trabalho e dependência | Esforço base | Evidência necessária para fechar |
|---|---|---:|---|
| M0 — fixar candidato e escopo | Registrar diff e arquivos novos da tarefa, hashes, ambiente, matriz A01–A20 e baseline comparável; separar mudanças alheias | 1 dia | Candidato reproduzível e matriz de superfícies/funcionalidades com destino, estado e owner; comandos e relatórios ligados ao mesmo build |
| M1 — primeira conversa nativa pela interface | Após M0, extrair preparação necessária de `runCoder`, compor contexto/provider/tools existentes e ligar worker/fachada; autoridade real mínima para leitura; manter gate de desenvolvimento isolado | 3–5 dias | Na interface do build candidato: mensagem → provider TS → leitura Rust/Host → segundo turno → texto/usage; cancelamento. Identidade/telemetria comprovam Rust e ausência de `CoderRunner.run` nessa attempt |
| M2 — autoridade e lifecycle recuperáveis | Após M1, implementar lease real de workspace e fencing de escrita; persistir/reconciliar outbox do supervisor; certificar múltiplos launches, crash/restart e encerramento de descendentes | 4–6 dias | Duas sessões concorrentes não violam ownership; lease vencido impede efeito; crash/ACK perdido não perde fato nem repete mutação; supervisor recupera/reap sem órfãos |
| M3 — sessões, retomada e conteúdo completo | Após M2, ligar leitores/projeções nativos às APIs e histórico; reabrir a partir de fronteira validada; transportar e reter anexos/artefatos de tool, incluindo `extraUserBlocks` | 3–5 dias | Fechar/reabrir aplicativo e reconnect preservam histórico, IDs, imagens, resultado de tools e usage; sessão antiga continua legível; efeito incerto exige reconciliação |
| M4 — paridade do fluxo de programação | Após M3, integrar preparação por turno, compactação, memória, seleção de tools, skills/MCP/plugins, contexto IDE/worktree, permissões e interações/tarefas/metas existentes | 3–5 dias | Mesmas tarefas/modelos/permissões passam no legado e no nativo; leitura, patch, shell, Git, imagem, aprovação/recusa e waiting/resume funcionam no app |
| M5 — certificar pacote e desempenho | Após M4, rodar matriz funcional/chaos/perf e qualidade/custo no aplicativo empacotado; corrigir regressões desta matriz | 3–5 dias | Gates Windows aplicáveis comprovados por hashes/relatórios, sem skip convertido em aprovação; custo e qualidade comparáveis; streaming/replay responsivos; soak 24 h/1.000 ciclos |
| M5-I0 — dependência de packaging do corpus | Após M5 e antes de C0, reutilizar a cadeia nativa para o piloto walker/hasher exigido por `GI-03`; não iniciar a reescrita completa do indexador | 3–5 dias | Paridade de arquivos em três repositórios, incluindo Assets/68k; packaging/signing/cohort e CPU de walk fora do main; `IDX-GATE-0` |
| M6 — canário interno, rollback e entrega E1 | Após M5/I0, habilitar C0 Windows limitado e ensaiar rollback de novas attempts | 2–3 dias ativos + mínimo de 48 h em C0 | Zero stop condition; rollback mantém sessões e efeitos; pacote nativo validado para o piloto interno; demais cohorts continuam fechados |

As 48 h de C0 são tempo decorrido, não horas de programação. Podem
coincidir com parte do trabalho ativo, mas precisam de execução e observação
reais. Defeitos de soak consomem a reserva; não abreviar o período para preservar
uma data. C0 não aprova automaticamente G6, C1–C5 nem a retirada do legado.

**Primeiro resultado visível:** M0+M1, cerca de 4–6 dias úteis de trabalho
dedicado. É uma demonstração nativa integrada em desenvolvimento, ainda não
uma liberação geral. Esse é o primeiro ponto de cobrança; se ultrapassar a
faixa, registrar o impedimento concreto e reestimar, sem substituir a entrega
por mais testes de componentes isolados.

M1 usa a composição `test|shadow` somente em ambiente de desenvolvimento
isolado. Não basta mudar `legacy_required`, remover uma asserção ou colocar
`productionReady: true`. A promoção de modo depende das provas de M2–M6 e dos
gates aplicáveis. O loop management permanente já existe em Rust: revisar a
composição/status e certificar o comportamento, sem reescrever o loop por
causa de um status antigo `multiLaunchManagementLoop: 'absent'`.

O lease de M2 deve vir do serviço de autoridade do produto, com raiz canônica,
versão/epoch monotônicos, conflito entre workspaces sobrepostos, revogação e
liberação após término dos efeitos/processos. Os fixtures de lease usados nos
testes físicos não servem como implementação de produção.

Pontos de partida confirmados para a implementação:

| Marco | Arquivos/contratos existentes a conectar ou completar |
|---|---|
| M1 | `apps/http-api/workers/coder-worker.ts`, `sse/coder-runtime-facade.ts`, `sse/native-coder-runtime-facade.ts`; `packages/code-agent/src/index.ts` e `runtime/native-coder-context.ts` |
| M2 | `packages/agent-runtime-contracts/src/environment.ts`; `HostSupervisorFactIntegrationGate.ts`; `agentd-supervisor/src/management/async_service/service_loop.rs` e `management/driver/lifecycle_fact_outbox.rs` |
| M3 | `NativeProviderFrontierRecovery.ts`, `NativeRustHostAttemptRuntime.ts`, APIs de sessão/histórico e `tool-registry-host-capability-executor.ts` |
| E2 | `apps/cli/commands/agent.ts`, `apps/mcp-server/agent-run-manager.ts`, `packages/docs-agent/src/index.ts` e entradas A12–A15/A20 do manifesto |

### Sequência de E2 e retirada posterior

Depois de E1, fechar nesta ordem, reaproveitando seus contratos:

1. **CLI, MCP, DocsAgent e plugin assistant (3–5 dias base):** CLI passa a
   consumir a fachada/serviço neutro. MCP já é cliente de `/api/coder`; verificar
   start/list/get/result/cancel e histórico nativo, sem criar outro executor.
   Retirar os loops próprios das outras entradas conforme o manifesto.
2. **Company, subagentes e orquestrações atuais (4–8 dias base):** pin de runtime
   por árvore, authority e orçamento dos filhos, waiting/interações, cancelamento
   recursivo, resume e persistência. Migrar cada árvore inteira; incluir as
   superfícies de pipelines/AppStudio que o inventário confirmar.
3. **Validação por superfície (2–3 dias base):** E2E público e empacotado,
   falhas de árvore, admissão em canário e rollback. A reserva eleva os 9–16 dias
   base para a faixa de 12–20 dias adicionais. Reutilizar a matriz, sem refazer
   a base.

O esforço de E2 não elimina o tempo de observação de cada cohort. Pelo
[protocolo vigente de rollout](./06-rollout-gates-and-retirement.md#103-escada-de-canário),
C0 exige 48 h; C1, 48 h e 200 attempts; C2, 72 h e 1.000 attempts; C3 e C4,
sete dias cada; C5, 14 dias. A soma mínima é **35 dias corridos**, desde C0,
se houver amostra suficiente e nenhuma regressão. São pelo menos 33 dias após
o primeiro C0 concluído. Não iniciar a contagem em testes isolados nem usar
tráfego sintético como substituto silencioso da amostra exigida.

Parte do rollout de uma superfície estável pode ocorrer enquanto outra é
implementada. Uma superfície adicionada depois precisa de sua própria evidência;
não herda retroativamente a observação de uma versão sem aquela funcionalidade.
Por isso não é correto somar todas as durações como se fossem serializadas,
nem prometer que toda observação caberá dentro do prazo de programação.

Sprite e Design Systems removidos não voltam como alvos de paridade.
AppStudio/roles de design e QA ainda presentes são inventariados separadamente;
`candidate-pipeline` existente não é considerado removido por semelhança de nome.

E3 só começa com uma matriz por plataforma/ambiente, incluindo CI e backend
Unix, e inventário de dependências legadas. O término global exige todos os
gates correspondentes e drain, sem sessões ativas abandonadas. Enquanto isso,
plataformas não certificadas continuam no runtime certificado. Preservar leitura
das sessões antigas; retirar o executor legado não autoriza apagar históricos.

### Validação que decide a entrega

- **Tempo:** medir preparação, provider, ferramenta, commit, transporte e
  apresentação separadamente, correlacionados por sessão/attempt/turno/tool.
  Heartbeat não conta como progresso de ferramenta. Medir o dispatch completo
  e suas parcelas; o benchmark isolado atual é somente parte da evidência.
- **Metas existentes:** startup aquecido p95 ≤250 ms, overhead nativo de dispatch
  p95 ≤5 ms, ACK de cancelamento p95 ≤250 ms e zero processos órfãos. Medir cancel
  também durante provider, tool e processo filho sem cooperação, não apenas idle.
- **Concorrência:** quatro leituras explicitamente independentes se sobrepõem;
  resultado rápido aparece antes do lento; ordem para o modelo é preservada;
  escrita/comando/interação/desconhecida fecha a janela; cancelar impede a próxima
  barreira. Não habilitar paralelismo pelo nome da ferramenta apenas.
- **Durabilidade:** históricos nativos de 100/1.000/10.000 turnos, commits quentes
  sem releitura integral, fotografia invalidada diante de corrupção/mudança,
  disco cheio, crash antes/depois de `started`, efeito com ACK perdido e restart.
  Resultado incerto nunca permite retry automático de mutação.
- **Interface:** streaming longo, replay, reconexão, consumidor lento, digitação
  e rolagem no Electron empacotado; projeto e perfil representativos além do
  perfil vazio. Capturar trace quando houver bloqueio; associar causas à thread
  correta. Os 192 ms do trace atual ainda não são ausência de tarefas longas.
- **Qualidade/custo:** tarefas, provider/modelo, permissões e cache equivalentes;
  corpus congelado em M0, resultados por tarefa e dispersão. Shadow de escrita
  usa replay com executor falso ou execução exclusiva no runtime selecionado,
  sem duplicar mutações. Não disparar providers faturáveis em duplicidade no shadow.
  Preservar os gates existentes de TTFT (regressão p95 ≤5%) e eficácia (limite
  inferior do IC 95% de Rust − legado ≥−2 pontos percentuais), além dos gates de
  memória, reliability, segurança e isolamento do documento 06.
- **Compatibilidade:** preservar `start`, `resume`, `cancel`, `resolveInteraction`,
  `getSnapshot`, `subscribeEvents`, HTTP/SSE, IDs, consumo MCP e CLI. Runtime
  fixado por attempt/árvore; fallback somente em nova attempt, com recuperação
  válida. Nunca adicionar writer TypeScript concorrente ao journal Rust.

### Controle de conclusão e evidências

Manter uma entrega crítica em andamento. Testes de componentes modificados
acompanham cada mudança; suíte ampla e pacote completo são repetidos no fechamento
do candidato ou por regressão relevante, não a cada edição sem necessidade.

Cada marco registra **implementado → integrado na entrada real → validado no
pacote → certificado no escopo**. Código e testes unitários não pulam etapas.
Guardar diff da tarefa, comandos, hashes dos binários, JSON/trace, demonstração
da jornada, riscos restantes e procedimento de rollback junto ao marco.

O checkout inspecionado contém 849 entradas no `git status` (415 removidas,
309 modificadas, 125 novas); elas não são todas atribuíveis a esta tarefa.
O HEAD `2d24020c28785bf181c178c72b9eaea8c1bfcdea` sozinho não identifica o build.
M0 precisa preservar essas mudanças e registrar um candidato reproduzível;
não limpar o checkout nem atualizar allowlists para ocultar drift.

Os números e hashes já medidos permanecem no relatório de desempenho citado
acima. Evidência em `scratch/` deve ser arquivada com o candidato antes de
certificar uma release. Os checkboxes normativos abaixo continuam sendo a
autoridade de aprovação; esta revisão não marcou novos gates.

**Sequencia atualizada em 2026-10-06:** a conversa da interface ja usa a
composicao Rust no cohort de desenvolvimento e passou no pacote Windows,
incluindo ferramentas, imagens, MCP, worktrees, ConPTY, memoria e retomada.
O transporte limitado do historico ja passou no pacote. Seguem a paridade
publica MCP/CLI, preparacao/compaction e tarefas/metas/hooks, paridade
das outras entradas, coordenacao de producao e os gates de certificacao.
M0 ainda exige classificacao de simbolos/dados e grafo resolvido; as capturas
de candidato ja identificam os builds locais. O gerador buf.build esta autorizado.

## 1. Regra de marcação

Marque um item somente quando:

1. a implementação correspondente existe;
2. os testes automatizados exigidos passam no commit candidato;
3. a evidência runtime/benchmark/chaos solicitada foi registrada;
4. nenhum stop condition relacionado permanece aberto.

Ao marcar, preencha `Evidência` com links ou paths imutáveis e identifique
commit/build, plataforma e data quando aplicável. Não marque itens em massa pela
existência de um PR. O checkbox de gate é sempre o último da fase.

## 2. Estado atual das fases

Checkbox mede **conclusão formal do requisito**, não simples existência de
código. Para impedir que `0/N` seja lido como “nada foi feito”, o inventário
operacional e o fechamento formal aparecem separados abaixo. As atualizações
datadas dentro dos itens são histórico de evidência; esta tabela é o snapshot
corrente.

| Fase | Implementação existente | Checks formais | Bloqueador atual |
|---|---|---:|---|
| G0 — spec e baseline | corpus normativo, ADRs, gates e medições locais de outubro | 0/13 | congelar candidato/corpus comparável, reconciliar manifesto A01–A20 e fronteira de imports, fechar evidências formais |
| G1 — workspace, IDL, Host e packaging | Protobuf TS/Rust; bridges; pacote nativo Windows; integrações físicas; app empacotado validado com runner legado | 6/23 | CI do candidato, handoff da entrada real para Rust, certificação instalada por plataforma e classificação dos exports legados |
| G2 — supervisor, lifecycle e isolamento | loop management permanente, Windows Job, runner single-tenant, Cancel/Fence/reap, fatos físicos persistidos no Host | 0/16 | outbox Rust durável/recovery, rehydration e multi-launch certificados na composição; autoridade de workspace, métricas agregadas, Unix e soak/isolamento |
| G3 — engine e Provider Gateway | múltiplos provider turns, histórico/anexo de entrada, thinking/usage, contexto preparado e checkpoint de fronteira; IDs públicos por turno | 0/18 | entrada do worker ainda legada; paridade da preparação/compactação entre turnos, uso dos checkpoints na retomada do produto e gates de memória/TTFT |
| G4 — capabilities e tools | leitura nativa, Host tools reais, aprovação/recusa durável, lotes de quatro leituras e resultados individuais; unknown e ACK perdido testados | 0/19 | lease de workspace de produção, catálogo completo no fluxo normal, artefatos devolvidos por tools e gates funcionais/security/perf completos |
| G5 — durability, waiting e run-tree | journal Rust, fotografias validadas pagináveis, provider-frontier recovery, detecção de efeitos incertos; projeção incremental legada | 0/17 | leitores/projeções HTTP nativos, reabertura real, recovery/waiting integrados, artifacts e árvores de subagentes |
| G6 — shadow, chaos e canário | composição `test|shadow`, falhas físicas focadas e medições locais; pacote legacy testado | 0/21 | replay comparativo de qualidade/custo, matriz completa de chaos, soak, I0 e cohorts C0–C4 do produto |
| G7 — default e limpeza | plano de superfícies/retirada; produto permanece `legacy_required` | 0/29 | C5, paridade A01–A20/plataformas, drain, rollback e prova de retirada de cada dependência |
| GI — indexador nativo | especificação; não há `native/index-runtime` no checkout | 0/8 | I0 é dependência explícita do canário; restante I1–I4 segue em trilho separado |

### 2.1 Histórico técnico até o candidato 1.36.0

Os termos “concluído” e “próximo” desta seção descrevem a fatia histórica.
Não são a fila atual; a sequência vigente é M0–M6 do plano de 2026-10-05.

1. **Concluído:** `Host → supervisor → runner → RunnerPulse inicial/periódico →
   hidratação → Prepared → Activate/ACK → Active → Heartbeat semântico →
   expiry ou close/reap`,
   inclusive falha fechada de hidratação e liveness target-specific sem renovar
   o hard deadline.
2. **Concluído:** Control Host full-duplex e Cancel/Fence process-real pós-`Active`,
   com ACK correlacionado, revogação após commit e saída comprovada do PID
   runner sem derrubar o supervisor.
3. **Concluído:** outbox/emissor Rust e receptor Host permanente de
   `AttemptProcessExited/AttemptProcessReaped`, com prova física capturada antes
   de descartar ownership, validação/correlação, commit durável e progressão
   somente após cada ACK; E2E process-real confirma os cinco fatos.
4. **Concluído:** após o receipt Control, Cancel/Fence passam também pelo canal
   management permanente, compartilham a sequência com ACKs de fatos e aguardam
   ACK exato do schedule físico; E2E confirma `CANCELLED`/`FENCED` e reap durável.
5. **Concluído:** a mesma command lane Host constrói/valida/serializa Reap com
   identity, runtime instance, ceiling e ACK exatos; a API permanece interna até
   o fechamento Control por hard-reap ser classificado como terminal esperado.
6. **Próximo:** recovery durável da outbox; depois métricas
   agregadas de descendentes/spool e
   `UpdateAttemptAuthority`.
7. **Concluído em paralelo seguro:** primeiro loop `agent-engine` determinístico
   por ports, bounded por bytes/eventos/usage e com terminal durável, composto
   no runner por `ProviderDataGateway` sem transportar authority pelo contexto.
8. **Concluído em paralelo seguro:** wire Provider v1 gerado em TS/Rust para
   start/accepted/cancel, deltas públicos, tool call completo, usage e terminal;
   canal, direção e identidade possuem testes fail-closed.
9. **Concluído em paralelo seguro:** primitiva Provider Gateway TS sem
   `code-agent`, com resolver injetado, binding exato, adaptação bounded,
   deadline/cancel/fence, agregação de tool args, usage/terminal e registry
   evicted. Sete testes focados e 333 testes Host passaram.
10. **Concluído:** o canal Data pós-hidratação faz handoff single-use ao owner
    Provider Host; Accepted é resposta autenticada/replayável, eventos dividem
    lane outbound bounded, Cancel entra durante stream e falha tardia chega ao
    coordinator. Dois testes Data end-to-end em memória e 336 testes Host
    passaram.
11. **Concluído em paralelo seguro:** peer Data Rust e adapter do runner exigem
    Accepted autenticado, stream monotônico e terminal completo; uma prova
    duplex cross-crate percorre Start→Accepted→texto→usage→terminal e conclui o
    turno no engine.
12. **Concluído em paralelo seguro:** a spec validada vira um execution seed
    single-owner, redigido e não clonável; ele atravessa hidratação, permanece
    inacessível antes de `Active`, é retirado uma vez e termina nos recursos do
    owner ativo sem iniciar efeitos.
13. **Concluído em paralelo seguro:** `EngineAuthority` implementa o port do
    engine sobre o mesmo `EffectGate` revogável do Control; authority só existe
    após `Active` e passa a falhar após close/Cancel/Fence, sem disparar efeito.
14. **Concluído em paralelo seguro:** agent definition, capability set e preset
    possuem payloads Protobuf V1 gerados; o composer valida materiais hidratados
    antes de `Prepared` e produz contexto inicial bounded/canônico.
15. **Concluído em paralelo seguro:** o sink runner-side implementa o port do
    engine e a fronteira Host→Rust session store possui payload Protobuf V1
    bounded, receipt físico, sequência local/global, replay exato e terminal
    fail-closed.
16. **Concluído:** `EngineEventProposal/EngineEventCommitted` atravessam o owner
    Data process-real; o engine Rust inicia o provider TS e só termina depois de
    cinco receipts físicos no journal filesystem Rust.
17. **Concluído:** `CapabilityPrepare/CapabilityUpdate` atravessam o mesmo owner
    Data autenticado; descriptors ligam nome do provider a capability
    ID/versão/classe/mutação, o engine revalida authority antes do prepare e o
    Host responde `allow|ask|deny` por `operation_id/tool_use_id`. Aceite produz
    grant selado, bounded e revalidado no runner. O caminho termina antes de
    qualquer efeito e possui prova duplex física em memória.
18. **Concluído em prova duplex:** `native.read_file` executa somente após grant
    com binding/root/quota selados; o Windows valida o path final pelo handle,
    `started/terminal` recebem receipts autoritativos distintos, o resultado
    bounded mantém pairing/cursor e abre o segundo provider turn. O loop aplica
    `maxTurns/maxToolCalls` antes do efeito e compartilha contexto por
    `Arc<[u8]>`.
19. **Concluído:** policy Host fail-closed confere o SHA-256 do catálogo
    hidratado, canonicaliza a raiz confiável fora do input do modelo e sela
    environment, lease/fencing, quotas, policy, nonce e expiry. O E2E
    process-real lê o arquivo pelo executor Rust, persiste nove records e prova
    o conteúdo exato no segundo provider turn.
20. **Concluído para falha live:** erro do executor depois do receipt `started`
    executa uma única vez, vira terminal `outcome_unknown`, cruza o wire
    autoritativo e chega ao provider como `tool_result` de erro.
21. **Concluído para inventário:** store pagina até 256 receipts e revalida a
    cadeia inteira; bridge expõe metadata path-free; Host lê payload por receipt
    exato, detecta started órfão e falha se o teto total não alcançar o tail.
22. **Próximo funcional:** persistir a decisão de recovery numa nova
    attempt/interaction e introduzir probe somente para handlers que o suportam;
    depois ampliar reads (`glob/grep/Git/HTTP`) e avançar transcript/checkpoint.
    Shadow/chaos/canário vêm após essas fatias.

### 2.2 Evidência histórica do candidato 1.36.0

- pacote:
  `runtime-v1-f6496fb120c29da50913e04eba033f98b67f85468e85035e34fe5aba6ba39930`;
- manifesto:
  `807b861d2d7093c58af749ef74566fefa5b4389cbc1268acc2f9e336a740fd6e`;
- package verify e smoke read-only passaram, incluindo load do addon e
  launch/kill de runner e supervisor;
- `cargo fmt`, Clippy de todos os targets/features com `-D warnings` e a suíte
  completa do workspace Rust passaram;
- contratos gerados: 51 testes; Host: typecheck e 355 testes aprovados, 5
  ignorados por desenho;
- suíte process-real Windows completa: 5/5 cenários; o cenário produtivo
  confirma dois provider turns e nove records físicos;
- capability/read: testes Host cobrem replay exato, divergência,
  rejection/grant e correlação; teste duplex Rust cruza provider tool call,
  prepare/accepted, started, leitura real, terminal, pairing/cursor e segundo
  provider turn em sete records/receipts. O process-real 5/5 agora confere o
  catálogo hidratado na policy Host, emite o grant, lê arquivo real e verifica
  o resultado no segundo turn;
- ambiguity live: teste do engine prova um único dispatch e terminal
  `outcome_unknown`; teste do wire prova classification/reason autoritativos e
  teste do composer prova `tool_result` de erro sem resultado inventado;
- recovery inventory: paginação store/bridge testa cursor, fencing e cadeia;
  scanner Host cobre started órfão, terminal exato/divergente e teto truncado;
  E2E físico confirma inventário vazio depois dos nove records;
- orçamento: 755 módulos produtivos, todos com no máximo 250 LOC; grafo: 11
  crates/14 arestas internas;
- `check:agent-boundary` global permanece vermelho por 126 referências novas e
  55 remoções no legado presentes no worktree compartilhado. Esta fatia não
  altera a baseline, não toca esses módulos e não usa o drift para aprovar gate.

## 3. G0 — spec, ownership e baseline

- [ ] `G0-SPEC-01` — Corpus `README`, `DECISIONS` e specs `00..08` revisado e
  aceito como autoridade.
  - Spec: `SCOPE-001..013`, `D-RUST-001..029`, `MIG-011`
  - Evidência:
- [ ] `G0-SPEC-02` — Nenhuma decisão bloqueadora permanece aberta sobre Rust,
  process-per-attempt, Host TS, filesystem session store, SQLite, provider V1,
  IDL, `code_exec`, fachada de migração ou separação código/dados.
  - Spec: `D-RUST-001..029`, `ADR-001`
  - Evidência:
- [ ] `G0-SCOPE-01` — Limite “sem remendos arquiteturais no code-agent legado”
  está registrado no backlog e no critério de review.
  - Spec: `SCOPE-005`, `D-RUST-012..015`, `MIG-001..010`
  - Evidência:
- [ ] `G0-OWN-01` — Owners nominais definidos para Runtime, Platform, Protocol,
  Host Adapter, Capabilities, Durability, Security, Observability, Data e
  Rollout.
  - Spec: `RUST-R001..060`
  - Evidência:
- [ ] `G0-BASE-01` — Matriz versionada de tarefas, workspaces, providers,
  tools, subagentes e falhas criada.
  - Spec: `MIG-003..006`
  - Evidência:
- [ ] `G0-BASE-02` — Harness mede árvore de processos, private/PSS, CPU, threads,
  handles, IPC, TTFT, eventos, spool e órfãos.
  - Spec: `OBS-001..008`
  - Evidência:
- [ ] `G0-BASE-03` — Baseline do legado repetida três vezes em build empacotada,
  com dispersão e ambiente registrados.
  - Spec: `MIG-002..006`
  - Evidência:
- [ ] `G0-BASE-04` — Baseline do Electron main/renderer ocioso registrada
  separadamente da árvore de agentes.
  - Spec: `OBS-002..003`, `RUST-R040`
  - Evidência:
- [ ] `G0-BASE-05` — Corpus, métricas e método estatístico do benchmark de
  eficácia foram congelados antes da implementação funcional.
  - Spec: `GATE-QUAL-01/02`, `RUST-R044`
  - Evidência:
- [ ] `G0-CUT-01` — Manifest A01–A20 lista entry points, símbolos, imports,
  dependencies, workers, scripts, flags, eventos, dados, owner e destino.
  - Spec: `CUT-001`, seção 8 de `08`
  - Evidência:
- [ ] `G0-CUT-02` — CI bloqueia novos imports/path-fonte/tipos do legado por
  allowlist versionada que só pode encolher.
  - Spec: `CUT-002`, `CUT-022`, `RUST-R045`
  - Evidência:
- [ ] `G0-CUT-03` — Contrato de `AgentRuntimeFacade`, `AgentRunHandle`,
  RuntimeRouter, IDs e projector está aprovado.
  - Spec: `CUT-003..005`, `CUT-015..020`
  - Evidência:
- [ ] `G0-GATE` — Gate G0 aprovado.
  - Spec: `MIG-011`
  - Evidência:

## 4. G1 — workspace Rust, IDL e packaging

- [ ] `G1-RUST-01` — Workspace `native/agent-runtime` criado com crates e
  dependências direcionadas como no README.
  - Spec: `SCOPE-006`, `SCOPE-013`
  - Evidência:
- [ ] `G1-RUST-02` — Toolchain Rust e lockfile fixados; `fmt`, `clippy`, testes,
  licença/audit e build release fazem parte do CI.
  - Spec: `SCOPE-007..011`
  - Evidência parcial (2026-07-25): `Cargo.lock` fixa `zeroize 1.9.0`;
    `cargo fmt --check`, Clippy do workspace com `-D warnings` e testes
    `--locked` passam. Revisão automatizada de licença/advisory e build release
    no CI candidato ainda permanecem pendentes; item continua aberto.
- [ ] `G1-RUST-03` — Quantidades de Tokio workers, blocking workers, channels e
  operation maps são explícitas e testadas.
  - Spec: `RUN-032..035`, `RUST-R005..007`
  - Evidência parcial (2026-07-26): cada launch físico usa um worker OS
    single-owner com stack explícita de 1 MiB; os canais de estágio, comando e
    cleanup têm capacidade 1. O efeito bloqueante não ocupa o loop Tokio, e
    testes determinísticos cobrem cancelamento, watchdog concorrente e shutdown.
    Ainda faltam selar e testar a configuração global de Tokio, blocking pool,
    operation maps e os leak tests de longa duração; item aberto.
- [ ] `G1-HOST-01` — `packages/agent-runtime-host` existe sem depender de
  `packages/code-agent` no contrato público; facade, router, adapters e
  projectors possuem boundaries explícitas.
  - Spec: `CUT-003`, `CUT-015..018`
  - Evidência parcial (2026-07-26): facade, router, framing IPC e lifecycle
    possuem diretórios e ports separados; `RustHostAttemptCoordinator` continua
    interno e o teste de API pública impede export acidental do driver. O
    package não importa o executor legado. Adapters/projectors de produção e a
    composição de todas as superfícies ainda são pendentes; item aberto.
- [ ] `G1-EXT-01` — Cada export consumido externamente do legado está
  classificado como `move`, `replace`, `fixture-only` ou `delete`.
  - Spec: `CUT-022`, `RUST-R045`
  - Evidência:
- [ ] `G1-EXT-02` — Prompts/assets e contracts cross-language necessários ao
  novo runtime possuem owner fora do package legado.
  - Spec: `CUT-024`, `CUT-027`
  - Evidência:
- [ ] `G1-IDL-01` — `.proto` v1 criado em
  `packages/agent-runtime-contracts/proto/codestudio/agent/v1`.
  - Spec: `IPC-001..009`
  - Evidência parcial (atualizada em 2026-07-29):
    `runner_bootstrap.proto` separa o handoff privado do management oneof;
    `runtime.proto` exige `idempotency_key = 5` também em `FenceAttempt`;
    `RunnerLaunchHandoff.runtime_provenance = 14` transporta a identidade do
    binário somente após o match confiável e a liga ao runtime/PID físicos.
    `session_store.proto` acrescenta leitura path-free do payload comprometido,
    ligada ao writer/authority/operation/kind/hash/tamanho exatos; hash isolado
    não autoriza leitura. `supervisor_bootstrap.proto` agora separa o handoff
    físico single-use do canal management permanente e descreve
    `SupervisorProcessHandoff/Ready`, sem argv/env para segredos. Bindings
    TS/Prost foram gerados e compilados a partir do IDL; `buf lint` e
    `buf build` passam localmente. Item aberto até o CI candidato.
  - Evidência adicional (2026-08-04, spec 1.29.0): `runtime.proto` formaliza
    os payloads executáveis `AgentDefinitionSnapshotV1`,
    `CapabilitySetSnapshotV1` e `ProviderPresetSnapshotV1`; mapas de tags
    impedem renumeração silenciosa. `buf lint`, `buf build`, geração e os 50
    testes de contrato passaram. O item continua aberto até o CI candidato.
- [ ] `G1-IDL-02` — Bindings TS/Rust são gerados; nenhum tipo de wire é mantido
  manualmente em paralelo.
  - Spec: `IPC-001..002`
  - Evidência parcial (atualizada em 2026-07-29): `buf generate` regenerou
    os bindings TS e o módulo Prost compartilhado a partir dos mesmos `.proto`,
    incluindo o bootstrap físico do supervisor. O plugin Prost está fixado em
    `v0.5.0`, `revision: 1`; existem sete módulos TS gerados e um módulo Prost
    agregado. Nenhum binding foi escrito manualmente.
  - Evidência adicional (2026-08-04, spec 1.29.0): os três snapshots
    executáveis foram regenerados no mesmo `runtime_pb.ts` e módulo Prost
    agregado; nenhuma representação wire paralela foi criada.
- [ ] `G1-IDL-03` — Golden fixtures cobrem IDs opacos, `uint64`, optional/oneof,
  canonical JSON, hash, enum desconhecido e frame máximo.
  - Spec: `IPC-003..005`, `IPC-007`, `IPC-010..012`, `IPC-035`,
    `IPC-043..044`, `RUST-R014..015`
  - Evidência parcial (2026-07-25):
    os fixtures Windows, Unix e `RunnerEndpointsReady` são codificados byte a
    byte por TS e Rust; preservam fencing `uint64`, optional UID, slots,
    três endpoints e o digest domain-separated. Campo Protobuf desconhecido
    também fica ligado aos bytes originais, sem normalização por re-encode.
    Os mapas completos de tags de `CancelAttempt` e `FenceAttempt` também ficam
    fixados no teste de contrato. A suíte host/contracts passou 331 testes; o
    workspace Rust passou 410
    testes (11 helpers child/E2E ignorados por desenho), incluindo 194 de
    `agent-protocol` e 91 de `agent-runner`, mais 14 doc-tests `compile_fail`.
- [ ] `G1-IDL-04` — Lint e breaking-change detection do IDL rodam no CI.
  - Spec: `IPC-033..035`
  - Evidência parcial (2026-07-25): `rust-agent-ci.yml` executa lint, descriptor
    build, `buf breaking`, geração reproduzível e diff dos bindings. O item
    permanece aberto até o run de CI desta revisão.
- [x] `G1-HS-01` — Hello, Prepare, Prepared e Activate funcionam nos dois
  canais; execução antes de Activate falha fechado.
  - Spec: `IPC-006..016`, `IPC-036..040`, `RUN-001..004`
  - Estado corrente (2026-08-01): **concluído** no pacote Windows candidato.
    `NativeRustHostAttemptRuntime` compõe uma attempt single-use e o E2E opt-in
    percorre Host TS→supervisor→runner, hidratação, commit de `Prepared`, grant
    durável, `Activate/ACK` e `Active`. Antes do fechamento, o teste comprova
    supervisor e runner ainda vivos; depois, comprova reap dos dois. Um segundo
    cenário corrompe o último snapshot, impede `Prepared/Active` e também
    termina sem PID órfão. As entradas abaixo preservam o histórico que levou
    a esta conclusão.
  - Evidência parcial (atualizada em 2026-07-26):
    `ActivationAuthoritySeal` nasce tipado em `LaunchAttemptProcess` com
    versões e `SHA-256(raw_activation_nonce)`, é validado e copiado sem mint
    pelo supervisor para o handoff exato. O runner retém o commitment no
    `RunnerLaunchContext` e rejeita versões ou nonce divergentes antes do ACK.
    `HostHello.write_timeout_ms` agora sobrevive à negociação; o deadline do
    `ActivateAck` usa o mínimo entre attempt e timeout de write e é verificado
    antes/depois do write físico. Retorno no/após deadline, regressão de clock
    ou falha de write fecham o driver sem instalar `ActiveAuthority`.
    `RustHostAttemptCoordinator`, ainda interno e restrito a `test|shadow`,
    somente abre control depois de `LaunchAccepted → Spawned → Containment`
    duráveis e confirmados; seu `run()` só resolve depois de
    `AgentHello → Prepare → Prepared → durable grant → Activate → Ack → Active`.
    Testes cobrem ordem, cancelamento, expiry e revogação de settlement tardio.
    No runner, um owner Tokio crate-private aceita o Host fisicamente esperado
    e conduz o mesmo fluxo sobre o stream real. `Prepared` e `Active` só
    avançam depois dos writes físicos correspondentes; cancelamento, EOF,
    clock inválido, deadline, hydration failure ou future abandonada revogam
    canal/authority. Depois do ACK, `ActiveRunnerLifetime::advance` retém
    control, handoff, data e pulse no mesmo owner e conduz um evento bounded.
    `CancelAttempt` e `FenceAttempt` possuem handlers semânticos: validam
    authority e idempotência, revogam effects antes do ACK, instalam
    `Cancelling` somente após receipt físico válido e devolvem cleanup tipado
    em `Exiting`. Deadline, regressão de clock, conflito, cancelamento local ou
    abandono não restauram authority. Isso ainda não é o pump completo:
    heartbeat/pulse, drain cooperativo, cancelamento host-owned, ligação do
    cleanup/exit do processo runner ao registro físico do supervisor e E2E
    físico Host TS↔runner continuam pendentes. Atualização 2026-07-29: o `main`
    Windows de produção agora consome o bootstrap herdado, valida
    supervisor/handoff, materializa os três endpoints e entra no accept/pump
    control. A proveniência comparada pelo supervisor é encaminhada no handoff
    protegido e validada contra runtime/PID. Um E2E com Host, supervisor e
    runner em processos distintos comprova PID bilateral, `AgentHello →
    HostHello`, nonce, proveniência, negociação, estado ainda `Reserved` e reap
    a zero. O teste encontrou e corrigiu dois defeitos reais da composição:
    `EnterGuard` sobreposto ao `block_on` e timer Tokio não habilitado.
    Atualização adicional 2026-07-29: o store e o bridge Rust agora leem bytes
    comprometidos sem path somente após validar writer/authority/operation/
    kind/hash/tamanho e caps. O runner ganhou verifier/owner one-shot que exige
    cobertura exata dos snapshots/artifacts, valida metadata, SHA-256 e budgets
    selados e retém os bytes até `Active`. Atualização 2026-07-29 (spec 1.4.7):
    o runner agora materializa também o data endpoint de produção, exige
    `BindAttemptChannel` Host→runner como primeiro frame, valida o token
    endpoint-bound e responde `AttemptChannelBound` antes de expor o stream.
    O pump conduz `Manifest → Progress → Chunk/Progress → Complete/Committed`
    com stop-and-wait, digest do payload opaco, SHA de chunk/conteúdo,
    zeroization, cap de bytes e budget total de frames. Chunks devem consumir o
    crédito exato. O `PrepareAttempt` permanece a transação stop-and-wait
    pendente durante Data; por isso o mesmo receiver Control não admite outra
    frame até `AttemptPrepared`. Cancelamento local, fechamento dos endpoints,
    deadline e reap do supervisor continuam sendo os guards assíncronos. A
    responsividade Control concorrente exigida em `G3-IPC-01` permanece um
    trabalho explícito de protocolo, não uma capacidade já entregue.
    Atualização 2026-07-29 (spec 1.4.8): o Host agora possui framing
    channel-sealed Control/Data, correlação Data por request, sender
    `Bind/Bound → Manifest/Progress → Chunk/Progress → Complete/Committed`,
    source filesystem streaming e adapter físico interno `test|shadow`.
    O adapter consome owners opacos distintos de endpoint/conexão Data, liga
    reservation/resource group/runtime/PID aos fatos duráveis, exige limites
    físicos exatos, reapeia settlement tardio e mantém token/chunks
    single-use com zeroization. `prepareHydrated` grava `Prepare`, conclui Data
    e somente então admite o `Prepared` correlacionado; falha ou cancelamento
    revoga os dois caminhos. Um E2E in-memory do transporte físico prova
    bind, hidratação integral a partir da fonte de disco e commit.
    A promoção continua fail-closed: o bridge core ainda precisa ser carregado
    in-process e transferir o owner opaco sem reabrir o HANDLE/FD; o E2E Named
    Pipe Host TS↔runner ainda deve completar Prepare/Activate.
    Evidência automatizada atual: 542 testes Rust passaram/14 helpers físicos
    ignorados por desenho; os 8 E2E Windows explícitos passaram 8/8; 14
    doc-tests; contracts+Host TS 349 testes; `buf lint/build`, typecheck,
    clippy workspace `-D warnings`, rustfmt e build release verdes; LOC 578
    módulos/250 cap e grafo 9 crates/9 edges. Dois fixtures Windows antigos
    foram alinhados ao contrato vigente: IPC agora deixa crédito positivo após
    a reserva de envelope Data e proveniência não pode ser vazia. O ratchet
    global de imports legados continua vermelho por 87 referências novas e 56
    removidas da migração filesystem concorrente, fora desta fatia; o baseline
    não foi regenerado.
    Atualização 2026-07-29 (spec 1.4.9): o IDL ganhou o request único
    `HostAttemptBridgeOpenRequest`, composto por launch, fatos duráveis,
    deadline de abertura e containment requerido. O novo crate
    `agent-host-bridge` decodifica e apaga os segredos, revalida identity,
    budget, reservation, resource group, runtime, proveniência, containment,
    tempos e conjunto exato Control/Data/Pulse antes de qualquer I/O. No
    Windows, ele abre Control e Data diretamente e verifica o PID do runner no
    mesmo Named Pipe; o resultado é um owner Rust único dos dois transports.
    Divergência durável falha antes do open, PID falso é rejeitado pelo SO e
    falha ao abrir Data descarta Control. O Host TS produz esse request por um
    owner single-use e zera os bytes após sucesso, erro ou abort explícito; um
    finalizer é apenas o backstop para owner abandonado. O ADR-002 fixa que o
    próximo binding será um wrapper Node-API in-process fino, nunca sidecar,
    probe/reopen ou handle bruto em JavaScript.
    Evidência desta fatia: 545 testes Rust passaram/14 ignored; 353 testes
    contracts+Host TS; 3/3 testes físicos do novo bridge; typecheck, Protobuf
    lint/build/generate, rustfmt, Clippy estrito, 11 doctests e build release
    verdes; o caminho fail-closed também passou check/Clippy cruzado para
    `x86_64-unknown-linux-gnu`; os 8 E2E Windows opt-in passaram 8/8; LOC 587
    módulos/250 cap e grafo 10 crates/11 arestas.
    Atualização 2026-07-29 (spec 1.5.0): o crate
    `agent-host-bridge-napi` implementa o wrapper Node-API 8 in-process. Um
    owner Rust único retém Control/Data, oferece read/write em chunks máximos de
    64 KiB, impede operação concorrente por direção, compartilha cancelamento e
    fecha ambos os clientes por `close()` explícito; GC/Drop permanece somente
    backstop. Request e chunks de saída são zerados nos dois lados da ABI. O
    loader TS recebe um `VerifiedRuntimePackage`, exige ABI/contrato/target
    exatos e transfere o request opaco sem expor path, token ou HANDLE. O
    package manifest agora liga três artefatos — addon, runner e supervisor —
    por tamanho/SHA-256/build ID. Package verify e smoke read-only passaram; o
    addon carregou, provou que a classe owner não possui constructor público e
    rejeitou request inválido no Node 22 e Electron 42.5 Windows x64. Evidência
    consolidada: 545 testes Rust passaram/14 ignored;
    355 testes contracts+Host TS; 14 doctests; typecheck, rustfmt, Clippy
    workspace e Clippy cruzado Linux estritos; LOC 599 módulos/250 cap e grafo
    11 crates/12 arestas. O item permanece aberto somente até o adapter ligar
    esse owner ao framing/driver e o E2E process-real completar
    Prepare/Activate.
    Atualização 2026-07-29 (spec 1.6.0): o adapter agora existe. O addon entrega
    endpoint ID, connection ID, PID atestado e caps dos dois canais sem expor
    address/token/HANDLE. `NativeHostBridgeDuplex` adapta reads/writes nativos
    ao `DelimitedByteChannel` em chunks físicos de 64 KiB; Control e Data
    compartilham uma única close authority e qualquer poison inicia cleanup
    explícito retido por `native_reaper`. O composition root
    `createNativeShadowAttemptAdapters` abre o owner Rust uma vez depois dos
    fatos duráveis e transfere cada transporte aos adapters sem probe/reopen.
    O teste integrado percorreu
    `AgentHello → HostHello → Prepare → Data bind/hydration →
    AttemptPrepared → Activate → ACK → Active` e o teste de fragmentação
    comprova que uma frame pode atravessar múltiplos reads nativos sem stall.
    Evidência local: 361 testes contracts+Host TS; 3/3 testes físicos Windows
    do core; package verify, smoke Node read-only e smoke Electron 42.5 verdes;
    LOC 607 módulos/250 cap e grafo 11 crates/12 arestas.
    Atualização 2026-07-29 (spec 1.7.0): o `agentd-supervisor` Windows deixou de
    ser scaffold no caminho autorizado. Ele recebe um handoff físico bounded
    por handles allowlisted, exige EOF, verifica o PID Host derivado do mesmo
    pipe, conecta o Named Pipe management protegido, devolve Ready e compõe
    `SupervisorAsyncService` no `main`. Um smoke multiprocesso real passou
    Hello, `ShutdownSupervisor`, ACK, exit 0 e reap físico. Invocação direta
    continua exit `78`. Naquela fatia, o item permanecia aberto até o
    launcher/owner N-API do Host ligar esse caminho ao control plane e o E2E
    alcançar Active com supervisor e runner de produção.
    Evidência consolidada desta fatia: 550 testes Rust passaram/14 ignored; 361
    testes contracts+Host TS; 14 doctests; o smoke multiprocesso
    Host→supervisor passou 1/1. `buf lint/build/generate`, typecheck, rustfmt,
    Clippy workspace e Clippy cruzado Linux estritos, build release, package
    verify, smoke Node read-only e smoke Electron passaram. LOC: 616 módulos de
    produção sob cap 250; grafo: 11 crates/12 arestas. Pacote verificado:
    `runtime-v1-d76461a228c334fa035efcca41c12be1fc2825589f3bff642c1085876c9b870f`.
    Atualização 2026-07-30 (spec 1.8.0): o launcher/owner Host foi ligado ao
    caminho process-real. O core Rust valida o request Protobuf bounded, hashes,
    nomes, paths absolutos, target e policy do package; cria o Named Pipe
    management protegido; lança `agentd-supervisor.exe` em Job Object com
    handles bootstrap allowlisted e sem segredos em argv/env; revalida os
    binários pós-spawn; exige Ready/EOF/connection/address/PID exatos e aceita
    somente o peer físico esperado. O wrapper Node-API retém stream + Job,
    oferece I/O management bounded e uma única close authority com reap
    explícito. O Host TS produz um request single-use com scrub, adapta o stream
    ao framing existente e fecha o owner em todo fail path. O teste process-real
    percorreu `open → Ready → HostHello/SupervisorHello → Shutdown/ACK →
    exit 0 → reap` com `forced=false`; testes TS cobrem scrub, consumo único,
    provenance divergente, composição sem reopen e close. Naquela validação,
    o item permanecia aberto até o supervisor lançar o runner empacotado e o
    E2E físico alcançar `Prepare/Activate/Active`. Evidência consolidada: 554
    testes Rust
    passaram/14 ignored; 364 testes contracts+Host TS; typecheck,
    `buf lint/build/generate`, rustfmt e Clippy Windows/Linux estritos; LOC 630
    módulos/250 cap; grafo 11 crates/12 arestas; package verify, smoke read-only
    e smoke Electron verdes. Pacote:
    `runtime-v1-6fa52342994e93fa0ed1c8b48b088610572853e4ea3a8b2ab2ac05e501612eb2`.
    Atualização 2026-08-01 (spec 1.8.2): o composition root process-real
    `NativeRustHostAttemptRuntime` passou a possuir supervisor, adapters
    Control/Data e coordinator em uma única lifetime. O E2E
    `native-process-real-active.windows.test.ts` passou 3/3: Hello management
    bruto; caminho completo até `Active` com runner vivo; e hidratação
    divergente fail-closed. A investigação encontrou e corrigiu um erro real:
    o loop Data chamava `receive_next()` enquanto o `Prepare` ainda era o
    pending inbound, recebia `PrepareInFlight` imediatamente e fechava os
    pipes. O runner agora respeita stop-and-wait e, após o ACK, executa o loop
    permanente de `ActiveRunnerLifetime` em vez de sair. Correlação de timestamps
    entre processos Windows aceita apenas skew local bounded de 50 ms; payload,
    digest, token, PID, connection e deadline continuam exatos. Pacote validado:
    `runtime-v1-e62476bf447df35ee8ef41a083f484bc44150ad60a7cbd013140c0aec08a8f14`.
    Gates locais desta atualização: typecheck Host; 13/13 testes TS focados;
    101/101 testes de `agent-runner`; workspace Rust `--all-targets`; rustfmt e
    Clippy workspace `-D warnings`; package verify/smoke; 632 módulos produtivos
    sob cap de 250 LOC; grafo de 11 crates/12 arestas. O gate global
    `check:agent-boundary` segue vermelho por drift concorrente fora desta fatia
    (56 referências removidas e 109 imports legados novos no worktree); a
    baseline não foi regenerada para ocultar esse estado.
    Atualização 2026-08-01 (spec 1.9.0): o runner agora abre o endpoint privado
    de pulse somente para o PID esperado do supervisor e envia, antes do accept
    de Control, um frame `Negotiating` autenticado. O supervisor exige esse
    frame antes de produzir `LaunchAccepted`, valida identity/PID/connection,
    contador inicial, progress e HMAC, e falha fechado em divergência. O framing
    é limitado a 4 KiB, possui hard deadline imutável, timeout por operação,
    counter sem gap/replay, progress monotônico e authority single-use com
    scrub do token original. O E2E process-real passou 3/3 e os oito testes
    físicos Windows executados pela CI com `--ignored` passaram 8/8 após o
    fixture de sucesso reutilizar o entrypoint produtivo. Pacote validado:
    `runtime-v1-0dc0d3c8d73a000ada3889af3f53c66a8b554545350869870763866cd865d782`
    (manifest
    `6372c87a4cbfce45a4dafa5432452deaffa1b2c68c6cd1d57123cc9404b4e2bb`).
    Gates finais desta fatia: workspace Rust `--all-targets` verde; rustfmt;
    Clippy workspace `-D warnings`; typecheck Host; package verify/smoke; E2E
    process-real 3/3; 641 módulos produtivos sob o cap de 250 LOC; grafo de 11
    crates/12 arestas.
    Atualização 2026-08-01 (spec 1.10.0): o receipt do pulse passa ao
    `SupervisorLifecycleCore` somente depois do commit físico de
    `LaunchAccepted`. Um runtime Tokio compartilhado pelo provisioner mantém o
    receiver permanente; `PulseRegistry` é limitado por
    `max_active_attempts`, retém apenas a observação mais recente e participa do
    próximo deadline do lifecycle. O runner emite imediatamente nas transições
    `Hydrating`, `Prepared` e `Active` e periodicamente em `interval =
    pulse_timeout / 3`, com missed ticks em `Skip`. Silêncio, erro de framing ou
    autenticação expiram somente a ownership alvo e agendam termination/reap
    imediato; liveness é sempre limitada pelo hard deadline imutável. O E2E
    físico manteve supervisor e runner vivos por 1.200 ms sob timeout negociado
    de 500 ms, depois comprovou reap de ambos. Testes unitários cobrem falha
    target-specific e impedem pulse fresco de renovar o hard deadline. Gates:
    workspace Rust `--all-targets`; 218 testes `agent-protocol`, 101
    `agent-runner`, 171 `agentd-supervisor` e 8/8 físicos ignorados por padrão;
    50 testes de contrato; 365 testes Host/contrato com 3 skips esperados;
    rustfmt; Clippy workspace `-D warnings`; typecheck Host; package
    verify/smoke e smoke do addon no Electron; E2E process-real 3/3; 643
    módulos produtivos sob cap de 250 LOC; grafo de 11 crates/12 arestas. Pacote:
    `runtime-v1-77948e909b807e069afef9622271b402fc3b5c489249c59bd391a245bd31acac`
    (manifest
    `5c326cc77337a76d77adeb7c2896c3ae5feea8d5a5caea2cf1f32493cdc9e85a`).
    Heartbeat semântico e resource sampling real ainda permaneciam abertos
    neste snapshot histórico.
    Atualização 2026-08-04 (spec 1.11.0): cada emissão inicial, de transição ou
    periódica de `RunnerPulse` amostra o processo Windows corrente via
    `K32GetProcessMemoryInfo`, `GetProcessTimes` e `GetProcessHandleCount`.
    `rss_bytes`, `peak_rss_bytes`, `cpu_time_ms` e `open_handle_count` agora são
    observações reais; `process_count = 1` e `spool_bytes = 0` continuam fatos
    estruturais corretos desta etapa, pois o runner ainda não abre filhos nem
    spool. A API segura vive em `agent-platform`, o FFI cru fica isolado em
    `windows/sys` e os testes provam RSS/pico, CPU monotônica e handles físicos.
    A autoridade Host de `AttemptPrepared` também passou a aplicar a mesma
    tolerância bounded de 50 ms já normativa para peers locais, removendo a
    flutuação interprocesso sem afrouxar identity/digest/correlação. Evidência:
    workspace Rust `--all-targets`, rustfmt e Clippy `-D warnings` verdes;
    40 testes `agent-platform` com 6 físicos ignorados; suíte Host/contratos
    366 testes com 3 skips; typecheck; package verify/smoke; addon Electron;
    cinco execuções E2E process-real consecutivas, todas 3/3; 645 módulos de
    produção sob cap de 250 LOC; grafo de 11 crates/12 arestas. Pacote:
    `runtime-v1-ebba683a13f7ec595bd91d1195ca9211066e353276bfacf07070b5baf3e01ce6`
    (manifest
    `2c91bb5934ac60071060ab0e586462c50bd6bc9cc191653a571c6c6bbf084bc6`).
    Atualização 2026-08-04 (spec 1.12.0): o framing async agora acorda uma
    leitura ociosa no prazo do heartbeat sem consumir bytes nem envenenar o
    mesmo stream; após o primeiro byte, volta a ser progress-bounded e
    fail-closed. A authority outbound Rust emite eventos novos sem `reply_to`,
    com sequência commitada somente após write físico. Pós-`Active`, o runner
    alterna receive/heartbeat pelo intervalo negociado e envia identity,
    runtime, `lastAliveAt`, `lastProgressAt`, `lastEventSeq`, fase e resource
    sample real. O Host mantém pump/timeout permanente, valida relógio local
    bounded, monotonicidade, IDs e recursos, commita o inbound e retém somente
    o snapshot mais recente; silêncio revoga Active, enquanto o guard de hard
    deadline permanece independente e nunca é renovado. O E2E físico verifica
    o heartbeat e RSS/pico/handles reais após 1.200 ms. Evidência: workspace
    Rust `--all-targets`; 219 testes `agent-protocol`, 103 `agent-runner`, 171
    `agentd-supervisor`, 40 `agent-platform` com 6 ignores físicos esperados;
    rustfmt; Clippy workspace `-D warnings`; 368 testes Host/contratos com 3
    skips; typecheck; package verify/smoke e addon Electron; cinco E2Es
    process-real consecutivos, todos 3/3; 653 módulos produtivos sob cap de 250
    LOC; grafo 11 crates/12 arestas. Pacote:
    `runtime-v1-fa3682044947bd7163f29fb503a91b16ac1ef57b806a27f35e6fd55c3c19d6f0`
    (manifest
    `5ad25e731abe24cfb3483f3f199a33c18befbf3ab5b233f074a5a71d92702003`).
    Permanecem abertos rollup de descendentes/spool e authority lease
    management.
    Atualização 2026-08-04 (spec 1.13.0): o canal Control Host passou de uma
    exclusão global para lanes inbound/outbound independentes, mantendo no
    máximo um reader e um writer. Uma resposta que chega antes do retorno do
    write aguarda o commit da correlação outbound antes de ser validada. O pump
    pós-Active aceita heartbeat e exatamente um ACK de comando pendente, com
    timeout próprio, digest/message-id/reply-to autenticados e receipt ligado
    ao inbound. `CancelAttempt` e `FenceAttempt` são construídos a partir do
    handle de authority, validados no Host e revogam Active somente após ACK.
    A suíte Host passou 321 testes com 3 skips; typecheck passou; o E2E Windows
    3/3 atravessou Cancel no mesmo stream, recebeu ACK real, manteve o
    supervisor vivo e comprovou a saída do PID runner.
    Atualização 2026-08-04 (spec 1.14.0): Fence atravessa a mesma composição
    process-real com epoch substituto maior, ACK autenticado, revogação após
    commit e saída do runner alvo, mantendo o supervisor vivo. O E2E passou
    4/4. Os comandos management e a emissão/outbox dos fatos continuam como
    próximo marco.
    Atualização 2026-08-04 (spec 1.15.0): o owner Host management aceita agora
    a cadeia `LaunchAccepted → Spawned → Containment → Exited → Reaped`, valida
    identity, provenance, runtime, resource group, exit cause, resource sample
    e released resources, cruza os fatos com o spawn original, chama o writer
    durável e só então emite o ACK correlacionado. Ordem, transplante e payload
    inválidos falham antes do commit. Evidência: 43 testes focados; suíte Host
    322 testes com 4 skips; typecheck; LOC 657 módulos sob cap 250; grafo 11/12.
    O emissor/outbox Rust e a prova process-real dos fatos permanecem abertos.
    Atualização 2026-08-04 (spec 1.16.0): o reaper Rust agora reserva capacidade
    antes da liberação física, captura provenance/PID/exit/resource peak e os
    recursos PROCESS/RESOURCE_GROUP liberados, preserva a causa terminal sob
    escalada Reap e coloca a prova em outbox FIFO bounded. O serviço async dá
    prioridade ao outbox, emite `AttemptProcessExited` e só cria/emite
    `AttemptProcessReaped` depois do ACK exato do primeiro fato. No Host, um
    pump owned continua lendo após `Active`; a barreira de launch vira
    pass-through para o writer durável após liberar Containment. Cancel e Fence
    process-real agora aguardam reap durável e comprovam a cadeia completa
    `LaunchAccepted → Spawned → Containment → Exited → Reaped`, mantendo o
    supervisor vivo. Evidência: 174 testes `agentd-supervisor` aprovados/8
    ignorados por desenho, Clippy `-D warnings`, dois testes novos de sequência
    Rust, 11 testes Host focados, typecheck, E2E Windows 4/4, package
    verify/smoke, 661 módulos sob cap 250 e grafo 11/12. Pacote:
    `runtime-v1-c8f1a6199b26dc79358876526aecc5beea905f9a57982af51c3a2ea9acb7c334`
    (manifest
    `9c56287a5bcc1085625f23d03ef9519bf51ebdde12a33507b0e3b789300745a5`).
    A outbox ainda é memória bounded: replay após restart do supervisor e os
    comandos management process-real permanecem abertos.
    Atualização 2026-08-04 (spec 1.17.0): o Host management possui agora uma
    command lane bounded, com um único comando pendente e uma sequência outbound
    compartilhada com ACKs de fatos. Cancel/Fence validam identity, deadline,
    fencing epoch, idempotência, `reply_to`, message-id, payload digest e relógio;
    ACK inválido ou vencido envenena o canal. O pump permanente aceita o ACK de
    comando sem interromper `Exited → Reaped`, e o coordenador só envia o comando
    físico depois do ACK Control. Evidência: 26 testes focados; suíte Host
    330/330; typecheck; E2E Windows 4/4 com schedule no supervisor Rust, saída do
    PID e causas físicas `CANCELLED`/`FENCED`; módulos novos separados e canal
    principal com 249 LOC. Permanecem abertos Reap no Host e recovery durável da
    outbox após restart.
    Atualização 2026-08-04 (spec 1.18.0): `ReapAttemptProcess` entrou na mesma
    lane bounded e na autoridade de sequência do Host. A primitiva liga identity
    selada, runtime instance, ceiling futuro, reason/idempotency e valida ACK
    exato antes de resolver. O teste de canal percorre agora Cancel → Fence →
    Reap → Exited → Reaped sem segundo reader/writer; suíte Host 326 testes
    aprovados e 4 E2E físicos opt-in, typecheck aprovado, canal principal em 249
    LOC. O método ainda não é exposto pela facade do runtime: falta tornar EOF do
    Control esperado durante hard-reap e provar esse caminho process-real.
- [ ] `G1-HS-02` — Management é bounded e runner conecta control/data
  diretamente ao host; supervisor não recebe payload de provider/tool.
  - Spec: `IPC-036..040`, `D-RUST-003`
  - Evidência parcial (2026-07-26): management usa frame/replay/command limits
    selados, janela física de um fato aguardando ACK e processamento Host
    limitado por sequência. O handoff entrega endpoints control/data/pulse
    diretamente ao runner; o supervisor retém somente fatos de launch,
    containment e ownership, sem payload de provider/tool. O mesmo serviço
    management de biblioteca aceita múltiplos `LaunchAttemptProcess` e conduz
    Launch/Cancel/Fence/Reap. A cadeia
    `LaunchAccepted → AttemptProcessSpawned → AttemptContainmentReport` é
    correlacionada e limitada pela janela negociada. O data endpoint e o pump
    de hidratação runner-side agora são concretos, autenticados e bounded; o
    pulse físico também é concreto, autenticado, obrigatório antes de
    `LaunchAccepted` e mantido por owner permanente bounded com emissão
    periódica e expiry target-specific. Os pulses já incluem RSS/pico/CPU e
    handles reais do runner. O heartbeat semântico agora percorre Control
    direto runner→Host e não leva payload de domínio ao supervisor. Composição
    multi-launch process-real, rollup de descendentes/spool, recovery e
    rehydration ainda são
    pendentes; item aberto. O `main` Windows
    já possui composition root permanente e smoke real de Hello/Shutdown. O
    owner N-API de attempts já chega ao
    framing/driver Control/Data sem reopen e o sender Data/adapter
    `test|shadow` usa o PID atestado no mesmo transporte, nunca um path ou PID
    fornecido como prova pelo JavaScript.
- [ ] `G1-HS-03` — Bootstrap entrega o mesmo stream a um canal estabelecido com
  cap físico exato; seed transplantado, reject, poison e write failure não
  produzem receipt de commit. Header de saída é gerado por authority única e
  replay físico não avança sequence, enquanto retry semântico gera novo header.
  Connection ID de cada stream é igual no launch, endpoint e handoff; control
  repete-o em `FrameHeader`/`HostHello`, data em `FrameHeader` do bind, e pulse
  sela-o no handle/FD autenticado sem repeti-lo em cada frame. Transições cruas
  de sessão não são públicas e a ordem dos Hello é comprovada pelo owner físico.
  - Spec: `IPC-009..012`, `D-RUST-017`, `D-RUST-019`, `D-RUST-023..027`
  - Evidência parcial (atualizada em 2026-07-26): adapters
    `agent-platform::windows::ipc` e
    `agent-platform::unix::ipc` implementam owner one-shot, deadline/cancel,
    peer PID bilateral (e UID bilateral no Unix), root UDS sem symlink e cleanup
    condicional que preserva ownership se a identidade divergir; IDL agora
    carrega `connection_id` por endpoint. O spawn Windows consome uma allowlist
    bounded de duplicatas herdáveis próprias, usa `JOB_LIST + HANDLE_LIST` e
    possui testes de inclusão/exclusão em processo real. Outro teste físico
    prova que Named Pipe herdado preserva o PID do criador, por isso D-RUST-025
    agora exige criação dos pipes pelo runner contido. O IDL
    `runner_bootstrap.proto`, o codec Rust non-cloneable, caps 64 KiB/4 KiB,
    limite de token 16..512 bytes, ownership
    `PreparedRunnerLaunchHandoff → AwaitingRunnerEndpointsReady`, scrub
    auditável, ACK do handoff exato e golden TS↔Rust também estão implementados.
    O decode é deliberadamente apenas validação de forma/autoconsistência;
    tokens viram verifiers non-cloneable ligados ao endpoint e ao hash do
    handoff exato, enquanto o nonce permanece em owner zeroizing single-use.
    O mesmo verifier do endpoint data agora só pode produzir
    `AsyncBoundDataAttemptChannel` após bind Host→runner exato; o typestate
    unbound não expõe recepção de domínio. O framing estabelecido foi
    generalizado por canal sem permitir transplante Control↔Data, e
    bind/bound possuem direções fixas e sequências independentes.
    A transição pós-Ready mantém context+verifier+nonce inseparáveis até o
    `AgentHello`; callbacks crus e split de listeners não são API pública.
    Decode parcial, early return, erro de write, panic e drop sobrescrevem
    `AgentHello`/`HostHello`, e Debug não renderiza os segredos.
    A fatia física de probe Windows agora cria dois pipes anônimos mais `NUL`,
    instala o stdio indivisível por `HANDLE_LIST + JOB_LIST` antes da primeira
    instrução, faz o runner bloquear no receiver após `ResumeThread` e comprova
    que handles alheios, argv e env não carregam a autoridade. O mesmo teste de
    processo real prova request/response, PID criador bilateral e EOF do Ready
    enquanto o runner continua vivo. O transporte exige exatamente um frame e
    EOF em cada direção; o runner verifica o PID criador antes de clock/bind,
    valida
    PID/deadline/plataforma, cria os três Named Pipes nos endereços canônicos
    exatos e só produz Ready depois dos três binds. Falha de write libera os
    listeners e permite rebind imediato dos mesmos nomes.
    Atualização 2026-07-29: outro E2E usa Host, supervisor e runner em processos
    distintos; o Host conecta pelo endereço real, verifica o PID servidor,
    recebe/valida `AgentHello` e envia `HostHello`, enquanto o runner verifica o
    PID cliente antes do protocolo. A proveniência protegida coincide com os
    fatos de spawn e Hello não altera o estado físico `Reserved`.
    Validação local desta fatia: 527 testes Rust de workspace passaram, com 14
    helpers ignorados no harness principal; 14 doctests e os cinco E2E Windows
    explícitos passaram. Também passaram 340 testes Host/contratos, lint/build
    Protobuf, rustfmt, Clippy `-D warnings`, build release, orçamento de 538
    módulos produtivos sob cap de 250 LOC e grafo de 9 crates/9 arestas. O gate
    global de boundary legado continua vermelho por drift concorrente da
    migração TypeScript filesystem (56 remoções/87 imports fora desta fatia);
    a baseline não foi regenerada para mascará-lo.
    No supervisor, `prepare → spawn contido → prova física/containment →
    complete_after_spawn` substituiu o receipt pré-spawn; handles são consumidos
    pelo registry, falha posterior agenda cleanup apenas da tentativa e
    `LaunchAccepted` não é emitido. Request/facts/seal carregam também authority
    lease e peer authority; PID/UID cru e mint de receipt não possuem construtor
    de produção, somente helpers `cfg(test)`.
    O provisioner Windows de produção cria dois pares de Named Pipes privados
    com nome CSPRNG não exposto, `FIRST_PIPE_INSTANCE`, rejeição de clientes
    remotos e DACL do logon. As pontas parent são overlapped/non-inheritable; as
    pontas child síncronas entram somente pela `HANDLE_LIST`. Um único deadline
    monotônico, derivado em `prepare` do mínimo entre hard deadline, authority
    lease e startup timeout, cobre pipe, spawn e handoff, com nova amostragem
    antes do receipt. O provisioner Windows não cria helper thread próprio; o
    pipeline físico externo executa no worker de launch dedicado.
    Falha de send/receive transfere reader, writer, `OVERLAPPED`, evento e buffer
    a `ProtectedLaunchCompletion::CleanupRequired`. O registry retém esse owner
    pela mesma `OwnershipKey`; a ordem é terminate Job → cleanup nonblocking →
    reap físico, sem devolver admissão antes da prova. Retry de cleanup possui
    limite explícito; stall fecha admissão, preserva ownership e exige restart
    duro. `Drop` de I/O ainda pendente é fail-stop e limitado, nunca uma espera
    infinita nem liberação de memória referenciada pelo kernel.
    Os E2E Windows usam helpers pertencentes a `agent-runner`, mantêm o grafo
    `supervisor → runner` proibido e provam success/Ready/EOF com o owner dos
    três endpoints ainda vivo, além de timeout+retry e cancel externo na ordem
    física terminate Job → cleanup I/O → reap.
    Dois testes adicionais percorrem o canal management e o
    `SupervisorPhysicalDriver` reais com `WindowsContainment` e
    `WindowsProtectedLaunchProvisioner`, sem fabricar fatos físicos. No sucesso,
    `LaunchAccepted` mantém o processo `Reserved` e sem autoridade de efeito
    antes de `ActivateAttempt`; EOF fecha admissão e
    `SupervisorCleanupPump::advance` termina e reapeia até ownership, memória,
    processos, cleanup registry e scheduler chegarem a zero. No timeout
    pós-spawn, `LaunchRejected` mantém exatamente um owner em `Cancelling`,
    reservation e cleanup sob a mesma `OwnershipKey`; só após cleanup I/O e
    reap o registro marca `physical_reaped`.
    O pump só aceita ownership com admissão fechada e todas as attempts
    agendadas, sela o hard deadline na transferência, preserva owner/deadline se
    seu await for cancelado e limita cada tick a um item por fase. Deadline é
    verificado antes/depois do tick, retries rotacionam em round-robin e o único
    failure outcome mantém ownership em `HardRestartRequired`.
    O framing Tokio agora amostra deadlines estritamente antes e depois de cada
    I/O, sobrescreve frame recebido tarde e cria guards RAII antes do primeiro
    poll. Testes diretos cobrem future de receive/commit nunca pollada, fechamento
    físico do peer e ausência de response write; o runner cobre também
    `AgentHello`. A leitura control pós-Active mantém silêncio entre frames
    saudável até hard deadline/cancel/EOF e aplica `read_timeout` somente ao
    progresso desde o primeiro byte; frame parcial estagnado envenena o stream.
    O mesmo `Instant` selado governa a espera externa e o framing, e uma
    verificação semântica pós-I/O impede continuar `Active` no deadline. Replay
    calcula seu deadline de write somente depois do read e qualquer
    cancelamento fecha o stream único. No Host, o adapter
    interno `test|shadow` liga reservation/resource group/runtime/provenance e
    exige cleanup `closed | native_reaper`. O core `agent-host-bridge` já cria
    owners Control/Data e verifica o peer no mesmo HANDLE/FD. O wrapper
    `agent-host-bridge-napi` já os mantém no processo Host com I/O bounded e
    cleanup explícito. O adapter já transfere Control/Data ao framing/driver
    sem reopen; o E2E process-real de 2026-08-01 agora comprova o mesmo owner até
    `Active` e reap. D-RUST-027 permanece dependência para as superfícies de
    produto, mas não bloqueia mais esta prova física.
    No runner pós-`Active`, Cancel/Fence seguem uma transação própria:
    validação → revogação síncrona → ACK bounded → reamostragem do clock →
    receipt → `Cancelling`. Testes cobrem write bloqueado/abandonado, deadline
    exato, regressão, corrida com cancelamento local, replay físico de bytes,
    retry semântico de Cancel e Fence e conflitos de payload/chave/tipo.
    No supervisor, cada launch protegido instala watchdog inicial em
    `min(hard deadline, authority lease)`. `CancelAttemptProcess`,
    `FenceAttemptProcess` e `ReapAttemptProcess` validam o target físico,
    reservam chave/digest/causa em ledger bounded antes do efeito, instalam
    schedule monotônico e somente então gravam `ManagementAck`. A precedência
    `Cancel < Fence < Reap` nunca alonga o menor deadline; Cancel respeita a
    grace solicitada e selada, Fence deriva a grace do budget selado e Reap
    torna imediatamente due também retries de termination/reap e mantém ceiling
    próprio. Replay físico, retry semântico inclusive pós-reap, conflito,
    colisão de chave entre tipos/attempts, ACK perdido, sibling isolada, stale
    identity/runtime e ceiling expirado possuem testes dedicados.
    `reap_after_cleanup` preserva exit cooperativo já observado; disconnect não
    alonga o watchdog vigente. Expiração temporal de Cancel/Reap ocorre no
    planner depois da classificação: intenção nova expirada falha fechado,
    retry scheduled pós-reap converge, e conflito contra tombstone não cria
    cleanup sem owner.
    O workflow constrói ambos os helpers antes de executar os seis testes
    `ignored`; o run remoto de CI ainda é pendente.
    Validação local desta fatia: 500 testes Rust de workspace passaram, com 12
    helpers ignored no harness principal; os seis E2E de produção passaram 6/6 em
    execução explícita. Também passaram 14 doctests, 331 testes host/contratos
    TS, typecheck host, `rustfmt`, Clippy `-D warnings`, build release, lint/build
    Protobuf, codegen idêntico em 6 arquivos, 482 módulos produtivos sob o cap de
    250 LOC e grafo de 7 crates/7 arestas. Os dois binários release continuam
    fail-closed com exit code `78`. O gate de boundary legado segue vermelho no
    worktree global por dois imports Anthropic fora desta fatia e por um
    baseline que aguarda ratchet de duas remoções concorrentes.
    A suíte específica de `agentd-supervisor` desta etapa passou 168 testes,
    com 6 helpers físicos ignorados por desenho no harness padrão.
    O loop permanente de biblioteca agora compõe o ator management async real
    com o lifecycle físico em um owner único; Cancel/Fence/Reap compartilham o
    mesmo planner do adapter síncrono, ACK espera write físico sem bloquear o
    watchdog, e EOF/write failure preservam schedule/owner enquanto fecham
    admission. O receipt de fatos foi normalizado entre transportes, e o evento
    async de `ManagementAck` preserva o corpo validado após o commit único.
    Writes já enfileirados agora permanecem owned pelo
    `SupervisorAsyncService`: cancelar `advance()` depois do enqueue não perde
    a continuação do ledger, e a retomada conclui receipt/tracking antes de
    aceitar outro frame ou declarar drain. Backpressure real também comprova
    que o watchdog continua avançando enquanto o write permanece bloqueado.
    `ShutdownSupervisor` agora é uma transação nativa do serviço async:
    `Drain` fecha admission sem alterar schedules por attempt e usa ceiling
    global; `TerminateAfterGrace` agenda owners por mínimo e pode escalar drain,
    nunca ser enfraquecido. O ledger possui um slot bounded por modo; replay
    físico, retry semântico, conflito chave/digest, ACK cancelado/write failure
    e deadline expirado antes do dispatch possuem cobertura determinística. O
    loop continua selecionando management e lifecycle enquanto drena.
    O mesmo owner recebe `LaunchAttemptProcess` pelo pending inbound
    correlacionado e executa o core compartilhado
    classify/reserve/provision/spawn/handoff/watchdog/facts. A emissão preparada
    sobrevive ao cancelamento de `advance()`, e cada continuação só avança após
    receipt do write/ACK correspondente. Falha de write de `LaunchAccepted`
    fecha admission, termina imediatamente o owner vivo e preserva
    reservation/cleanup. Falha ou regressão de clock após spawn ou completion
    também preserva o owner linear e converge para cleanup/hard-restart, sem
    drop silencioso. ACK tardio de Accepted/Spawned depois de reap confirmado
    consome o fato sem recriar cleanup para `OwnershipKey` ausente; failure key
    stale segue a mesma prova. Ausência sem tombstone física correspondente
    continua sendo erro de ownership, nunca no-op genérico.
    A regressão temporal revelada pela suíte agregada também está coberta:
    `ManagementClockAuthority` soma o anchor Unix com precisão sub-ms ao elapsed
    monotônico antes de projetar milissegundos, eliminando o double-floor de até
    1 ms entre peers com fases distintas. Testes determinísticos cobrem carry,
    equivalência entre fases e overflow fail-closed; nenhum gate muda de estado
    por essa correção.
    `prepare`, spawn contido e `complete_after_spawn` agora executam fora do loop
    Tokio em um worker OS dedicado, owned e joinable, com stack de 1 MiB e
    canais de estágio/cleanup com capacidade 1. O serviço preserva pending
    inbound, estado físico, worker, cleanup owner e reservation se
    `advance()` for cancelado. Testes determinísticos provam retomada sem
    duplicar spawn/completion, watchdog de sibling durante spawn bloqueado e
    shutdown sem drain prematuro. `Launching` e `BootstrapPending` impedem reap
    antes do handoff; retries não entram em spin e terminação diferida não é
    repetida imediatamente. O efeito físico de spawn possui um único callsite
    de produção no supervisor, ratchetado pelo gate de arquitetura.
    O binário de produção do runner já compõe o accept/pump físico, completa
    `AgentHello ↔ HostHello`, autentica o data endpoint e conduz a hidratação
    chunked até o owner pós-Active. O Host possui sender, adapter `test|shadow`
    e o composition root process-real; core e wrapper N-API materializam e
    retêm os owners opacos no mesmo HANDLE/FD até `Active`.
    O `main` Windows agora liga o serviço ao bootstrap físico single-use e ao
    management protegido; o smoke multiprocesso comprova Ready, Hello,
    Shutdown/ACK e reap sem usar o CodeStudio.
    O E2E Host TS↔binários já cobre Hello, Prepare, hydration, Activate, owner
    vivo pós-Active, pulse periódico além de duas janelas de timeout, heartbeat
    semântico com métricas reais, falha fechada e Reap. Os receivers de pulse e
    heartbeat pertencem a owners permanentes bounded; silêncio expira somente
    a attempt alvo sem renovar hard deadline. Pendente: integrar o owner
    pós-Active com effects, rollup de descendentes/spool, drain cooperativo e
    cancelamento host-owned de effects produtivos,
    `UpdateAttemptAuthority`, `QuerySupervisorState`, recovery durável da
    outbox e comandos management. Cancel/Fence e os fatos Exited/Reaped já
    passam no E2E pós-Active; ainda faltam testes de expiry nas
    fronteiras do spawn/Ready, matriz Windows packaged/nested/breakaway,
    backend de spawn Unix e unlink Unix descriptor-relative. O item permanece
    aberto.
- [ ] `G1-HS-04` — `Prepared` e `ActiveAuthority` só são instalados após receipt
  ligado ao mesmo inbound; EOF/error/drop revogam e nenhuma API pública permite
  check→dispatch com TOCTOU.
  - Spec: `IPC-012..014`, `D-RUST-017..018`, `D-RUST-022`
  - Evidência parcial (2026-07-26): Host e runner mintam `Prepared` somente
    depois do commit físico ligado ao inbound. O Host instala autoridade ativa
    após ACK correlacionado ao `ActivateAttempt`; o runner só a instala depois
    do receipt do ACK e de nova amostragem do deadline. EOF, write failure,
    cancelamento, future nunca pollada e expiry envenenam/revogam os owners. O
    coordinator Host também revoga após `Active`; no runner, o lifetime guard
    pós-ACK cobre idle além do read timeout, EOF, pre-cancel, hard deadline,
    frame parcial, drop antes/depois do primeiro poll, replay exato, conflito e
    expiry semântica pós-I/O. Cancel/Fence seguem a mesma fronteira: o gate é
    revogado antes do await do ACK, enquanto lifecycle/cache/outcome só são
    instalados depois do receipt ligado ao inbound e da verificação pós-write.
    Write failure, expiry, clock regression, conflito ou drop fecham sem
    restaurar authority. O dispatch gate produtivo de provider/tools e o
    cancelamento das operações in-flight ainda não existem; item aberto.
- [ ] `G1-HS-05` — Replay é limitado por entries e bytes físicos, outcome e
  replay físico compartilham buffer sem permitir transplante entre canais, e
  hidratação perdida/expirada é abortada/reaped sem pin de processo ou heap.
  - Spec: `IPC-010..014`, `D-RUST-020..021`
  - Evidência parcial (2026-07-26): replay possui limites selados por entries e
    bytes, tombstones bounded e binding por canal; replay físico exato de
    `Prepared` e `ActivateAck` reutiliza os mesmos bytes sem avançar sequence.
    Cancel/Fence também cobrem replay físico com ACK byte a byte idêntico e
    retry semântico com novo header somente para mesma idempotency key e digest;
    conflito ou troca de tipo fecham o canal.
    No management, o ledger bounded do launch retém no máximo uma intenção
    Cancel/Fence/Reap de cada tipo e, enquanto a tombstone estiver retida,
    proíbe a mesma chave entre tipos ou attempts; replay físico não volta ao
    handler e retry semântico idêntico recebe ACK novo sem repetir o schedule,
    inclusive após reap.
    `LaunchAttemptProcess` também cobre replay físico byte-identical e retry
    semântico da mesma chave/digest sem novo provisionamento ou spawn. O
    `SupervisorDriverStep` marca a aceitação reutilizada nos estados
    Reserved/Running/Cancelling/Exited/Reaping e depois do reap enquanto o
    accepted snapshot bounded estiver retido. O snapshot é redigido e não retém
    nonce, token, handles ou receipt. Digest divergente conflita; o ACK do replay
    não cria sucessores Spawned/Containment, e uma tombstone sem owner vivo não
    agenda cleanup.
    O cleanup pump preserva ownership sob cancelamento e deadline em vez de
    abandonar processo/heap. O runner cancela/revoga hydration interrompida,
    expirada ou nunca concluída sem publicar `Prepared`. O término do lifetime
    ativo agora devolve `ActiveRunnerCleanup<R>` com os recursos lineares ainda
    retidos. O bridge management→schedule/reaper físico já existe no core do
    supervisor. O primeiro E2E com o `agent-runner.exe` de produção real passou
    `spawn contido → handoff/Ready → Reserved → EOF management → terminate Job
    → reap`, liberando ownership, reservation e cleanup a zero; a suíte física
    explícita passou 7/7. O accept/pump data runner-side já está ligado e retém
    o stream autenticado no owner pós-Active; o sender/pump Host `test|shadow`
    já é bounded e ligado ao gate de `Prepared`. O bridge físico e a correlação
    até `Active` e Cancel/Fence Control com saída do runner estão comprovados;
    ainda faltam fatos duráveis de exit/reap e comandos management process-real e
    os gates longos de leak/soak; item aberto.
- [x] `G1-STOR-01` — Workspace contém crate folha `agent-session-store` sem
  dependência de engine/runner/supervisor, com identidade UUID canônica, layout
  explícito e limites simultâneos de records/payload.
  - Spec: `D-RUST-029`, `DUR-001`, `DUR-025`, `DUR-030`
  - Evidência (2026-07-28): `native/agent-runtime/crates/agent-session-store`;
    10 testes focados; workspace all-targets 512 passed/12 ignored; 14 doctests;
    clippy `-D warnings`, rustfmt e release aprovados; LOC 503 módulos/250 cap;
    grafo 8 crates/7 edges.
- [x] `G1-STOR-02` — Writer Rust possui lease físico fenced por
  `storageGeneration + leaseEpoch`, recovery de tail/hash, commit
  content-addressed e receipt idempotente.
  - Spec: `DUR-002`, `DUR-015..018`, `DUR-027..030`, `ADR-001`
  - Evidência (2026-07-28): manifesto imutável `rust_fs_v1`; authority log
    append-only/hash-chained com epochs contíguos e rejeição de stale/gap;
    lease físico validado antes de cada commit; journal e receipt ligados a
    session/generation/epoch/writer/operation/sequence/hashes/durability;
    replay idempotente, payload content-addressed, recovery de tails
    incompletas, revalidação e quotas. 10 testes focados e todos os gates Rust
    aprovados. O IDL/bridge e a transferência do writer pertencem aos próximos
    itens `G1-STOR-03/04`.
- [x] `G1-STOR-03` — `session_store.proto` e bridge nativo autenticado cobrem
  open/commit/read/query/transfer/archive sem entregar path mutável ao
  TypeScript.
  - Spec: `D-RUST-010`, `D-RUST-027`, `D-RUST-029`, `DUR-027..031`
  - Evidência (atualizada em 2026-07-29): `session_store.proto` gera bindings
    TS/Prost path-free para open/commit/read/query/projection/transfer/archive/
    close. A leitura exige writer/authority/operation/kind/hash/tamanho exatos,
    revalida lease físico, faz leitura bounded e reverifica tamanho/SHA-256;
    hash isolado nunca é capability. O crate `agent-session-bridge` possui
    owner opaco ligado ao processo, registry bootstrap-only de `root_id`, frame bounded com
    instance/sequence/deadline/hash pré-decode, writer handles e receipts
    fenced. Open/commit/query/archive/close executam no store; projection e
    transfer passam exclusivamente por extension port Rust compilado e o
    bridge valida o receipt. O port default rejeita fail-closed; a transferência
    física real continua isolada em `G1-STOR-04`. Evidência desta atualização:
    6 testes do bridge, 17 do store e 340 testes Host/contracts; workspace Rust
    532 passed/14 ignored, 14 doctests e 5 E2E físicos explícitos; Clippy
    `-D warnings`, rustfmt, release, `buf lint/build` aprovados; LOC 544
    módulos/250 cap; grafo 9 crates/9 edges. A repetição adicional do codegen
    ficou sem evidência nova porque o plugin remoto do Buf estava indisponível;
    os bindings gerados anteriormente nesta fatia compilam e passam as suítes.
- [x] `G1-STOR-04` — Transferência de um bundle real
  `typescript_fs_v1 → rust_fs_v1` passa drain, verificação, crash injection e
  rejeita dual-writer/stale epoch.
  - Spec: `DUR-027..031`, `CUT-064`, `ADR-001`
  - Evidência (2026-07-28): `agent-session-store` implementa lock físico
    serializado, guard `create_new` compatível com o lease TypeScript,
    inventário content-addressed com limites simultâneos, staging no mesmo root,
    snapshot integral em `legacy/typescript_fs_v1`, checkpoint authoritative,
    swap por rename+directory sync e activation receipt idempotente. O bridge
    path-free executa a operação pelo
    `FilesystemSessionStoreExtensionPort`; nenhum path cruza o IDL. Cinco testes
    físicos cobrem bundle real, replay, writer ativo, stale epoch, mutação,
    idempotency divergente e crash em cada uma das quatro barreiras; um teste
    adicional percorre o wire autenticado real. Store/bridge: 21 testes focados;
    workspace all-targets 523 passed/12 ignored, 14 doctests, clippy
    `-D warnings`, rustfmt e release aprovados; LOC 522 módulos/250 cap e grafo
    9 crates/9 edges. O gate global `check:agent-boundary` permanece vermelho
    por drift concorrente da baseline TypeScript (56 referências removidas/87
    imports existentes fora da baseline, nenhum nos arquivos desta etapa);
    deliberadamente não foi mascarado por regeneração.
- [x] `G1-PKG-01` — Supervisor e runner release são empacotados, possuem
  manifest/build ID/hash e verificação de integridade.
  - Spec: `SCOPE-011`, `IPC-033`
  - Evidência (2026-07-28): o build Electron produz somente o target corrente
    em `extraResources/native-agent-runtime/<target>` e embute no ASAR um
    anchor separado. Manifest determinístico liga os dois executáveis a
    versão, commit fonte, target, contrato, tamanho e SHA-256; `buildId` é
    derivado desses campos. O Host faz parse estrito, valida o anchor,
    containment, arquivo regular sem link, identidade durante leitura, tamanho
    e hash em streaming antes de expor paths verificados. Build real
    `--release --locked` e verificação cruzada Host passaram no Windows x64;
    reconstrução preservou manifest/anchor; 5 testes de tamper/target passaram,
    suíte contracts+Host 340 testes e typecheck aprovados. CI repete package e
    verificação Host em Linux, macOS e Windows; orçamento LOC permanece em 527
    módulos de produção sob cap 250. Assinatura, AV, launch instalado e path
    somente leitura continuam deliberadamente abertos em `G1-PKG-02`.
  - Atualização 2026-07-29 (spec 1.5.0): o manifesto passa a exigir também
    `agent-host-bridge.node`; build ID e anchor cobrem os três artefatos. Build
    release `--locked`, verificação Host, carga do addon a partir do pacote
    verificado e smoke Node/Electron passaram no Windows x64.
- [ ] `G1-PKG-02` — Smoke da build instalada passa em cada plataforma
  suportada, inclusive antivírus/assinatura e path somente leitura.
  - Spec: `GATE-PKG-01`, `RUST-R037`
  - Evidência parcial (2026-07-28): `agent-platform` fornece package probe
    inerte, token-gated e sem authority; runner/supervisor continuam retornando
    `78` no modo normal. O smoke extrai o anchor do `app.asar`, exige as fuses
    de integridade/ASAR-only, revalida inventário e hashes, copia o pacote para
    ACL read/execute-only, prova negação de escrita e mata fisicamente os dois
    processos após readiness com PID conferido. Uma build `dir` Windows x64
    real passou esse fluxo; `packageManager=pnpm@10.22.0` eliminou o OOM de
    4 GiB causado pela detecção incorreta como npm. O gate `required` rejeitou
    corretamente CodeStudio, runner e supervisor sem Authenticode. Microsoft
    Defender não concluiu o custom scan no ambiente sem elevação. CI foi
    preparado para package/Host/read-only/launch/kill em Linux, macOS e Windows,
    mas a execução remota ainda não constitui evidência. Regressão local:
    workspace Rust com 526 testes aprovados/12 ignorados por desenho, Host e
    contratos com 340 testes aprovados, clippy estrito, typechecks, grafo de 9
    crates/9 edges e orçamento LOC com 528 módulos de produção sob cap 250.
    O smoke read-only atual também carrega o addon em processo filho bounded,
    valida ABI/target/contrato, prova rejeição fail-closed e só então encerra o
    filho para liberar a DLL antes da limpeza. O mesmo addon passou no Electron
    42.5 em modo Node. A carga instalada local do terceiro artefato está
    comprovada, mas não altera os bloqueios de assinatura/AV/matriz abaixo.
    Permanecem bloqueantes: certificado e AV válidos no Windows, Developer
    ID/notarização no macOS, assinatura destacada no Linux e smoke instalado
    aprovado em todos os targets declarados.
- [ ] `G1-PERF-01` — Spawn até `AttemptPrepared` tem p95 ≤ 250 ms na matriz
  definida.
  - Spec: `GATE-PERF-01`
  - Reexecução Windows x64 (2026-10-05): 100 amostras após 10 aquecimentos,
    p95 39,130 ms, máximo 82,876 ms; passou no target local. Relatório em
    `.tmp/rust-agent-performance/GATE-PERF-01-win32-x64.json` e log em
    `scratch/harness-20261003/final-native-startup-performance.txt`. A matriz
    multiplataforma ainda não está certificada.
  - Evidência parcial (2026-07-29): feature `performance-harness` não
    empacotada inicia o binário release real em target directory separado,
    exige flag/token efêmero e percorre o driver
    `AgentHello → HostHello → PrepareAttempt → AttemptPrepared`. O parent mede
    antes do spawn até decodificar o segundo frame, exige exit limpo e timeout
    de 5 s; não envia `ActivateAttempt` nem cria authority de efeito. Windows
    x64 local, após 10 warm-ups e 100 processos medidos: p50 16.830 µs, p95
    41.095 µs, p99 53.908 µs e máximo 103.644 µs, contra threshold 250.000 µs.
    Relatório JSON foi produzido e a CI executará/guardará a mesma evidência em
    Linux, macOS e Windows. Regressão all-features: 527 testes Rust aprovados/12
    ignorados por desenho, clippy estrito, rustfmt, grafo 9 crates/9 edges e 536
    módulos de produção sob cap 250. A build default foi reconstruída sem a
    feature e devolveu `78` tanto sem argumento quanto diante do argumento do
    harness. O checkbox permanece aberto até a matriz remota comprovar as três
    plataformas.
- [ ] `G1-GATE` — Gate G1 aprovado.
  - Spec: `MIG-012`
  - Evidência:

## 5. G2 — supervisor, lifecycle e isolamento

Estado corrente (2026-08-04): a composição process-real Windows completa até
`Active`, pulse físico inicial/periódico, heartbeat semântico, Cancel/Fence nos
canais Control e management, owners permanentes, expiry target-specific e reap
estão comprovados. Pulse e heartbeat carregam RSS/pico/CPU/handles reais do
runner. Os checks permanecem abertos por métricas agregadas de
descendentes/spool, backend Unix, recovery durável da outbox,
`UpdateAttemptAuthority`, coordenação pública de hard-reap e gates quantitativos
de isolamento/soak ainda não provados.
`0/16` significa “nenhum requisito formal encerrado”, não “supervisor
inexistente”.

- [ ] `G2-PROC-01` — Cada `AgentRunAttempt` recebe um processo single-tenant e
  nenhum processo é reutilizado.
  - Spec: `RUN-001..011`
  - Evidência:
- [ ] `G2-PROC-02` — Supervisor não retém transcript, provider state, artifact
  body ou catálogo privado de run.
  - Spec: `D-RUST-003`
  - Evidência:
- [ ] `G2-ADM-01` — Admission reserva memória, processos e budget do run-tree
  antes do spawn e devolve reserva após reap.
  - Spec: `RUN-021..023`, `RUST-R002`, `RUST-R031`
  - Evidência parcial (2026-07-26): o E2E físico do driver comprova memória e
    processos reservados antes/durante bootstrap e timeout, inclusive enquanto
    cleanup permanece retido; ambos voltam a zero somente depois da prova de
    reap pelo `SupervisorCleanupPump::advance`. O pump só toma o driver depois
    do fechamento de admissão e da cobertura integral por cleanup. O ledger
    target-specific também mantém owner e reservation depois de ACK perdido ou
    ceiling expirado e só os libera após reap atribuído; cancelar uma attempt
    não altera sua sibling. O ledger agregado de child run-tree ainda é
    pendente.
- [ ] `G2-ISO-01` — Windows Job Object inclui descendentes, caps e
  `KILL_ON_JOB_CLOSE`; nested/breakaway tests passam.
  - Spec: `RUN-024..028`, `RUST-R003`
  - Evidência parcial (2026-07-26): o caminho físico completo lança o helper
    suspenso no Job, aplica limites, termina a árvore e comprova reap tanto no
    sucesso quanto no timeout. A matriz nested/breakaway permanece pendente.
- [ ] `G2-ISO-02` — Linux cgroup v2 e macOS process-group/rlimit/watchdog
  declaram e provam seu nível real de contenção.
  - Spec: `RUN-029..031`, `RUST-R004`
  - Evidência:
- [ ] `G2-LIFE-01` — State machine cobre spawn, handshake, hydrate, run,
  checkpoint, cancel, terminal, exit e reap.
  - Spec: `RUN-006..023`
  - Estado corrente (2026-08-04): **parcial**. Spawn, bootstrap, hidratação,
    Activate e reap estão compostos no E2E process-real único; Cancel/Fence
    Control pós-Active já possuem prova física completa. Run produtivo,
    checkpoint/terminal duráveis, recovery da outbox e comandos management
    process-real ainda faltam. O pulse
    inicial já é exigido antes de `LaunchAccepted`; o pump periódico e o
    expiry target-specific já estão no owner permanente.
  - Evidência parcial (2026-07-26): as máquinas atuais cobrem reservation,
    spawn contido, bootstrap/Ready, management EOF, cleanup e reap, além da
    transação `AgentHello → Prepare → Prepared → Activate → Ack → Active`. O
    coordinator Host propaga abort/failure pós-Active aos owners de control e
    management. No runner, Cancel/Fence aceitos percorrem
    `Active → Cancelling` somente depois do ACK físico; o lifetime os converte
    em `RemoteCancelled`/`Fenced`, fecha em `Exiting`, revoga authority e
    preserva ownership para cleanup. No supervisor, Cancel/Fence/Reap percorrem
    ledger bounded → schedule → ACK → termination/cleanup/reap, com precedência
    monotônica e ownership target-specific. O `SupervisorAsyncService` já
    serializa o ator async real e os ticks do mesmo core, preserva o owner sob
    cancelamento do future e devolve o core fechado ao completar drain. O mesmo
    core de Launch é usado pelos adapters síncrono e assíncrono e cobre
    reservation, provisionamento, spawn contido, handoff, watchdog, fatos
    correlacionados, replay e cleanup fail-closed. Continuam pendentes Run,
    checkpoint, terminal durável, comandos management process-real, recovery
    da outbox sob restart, rollup de
    descendentes/spool e drain cooperativo; item aberto.
- [ ] `G2-LIFE-02` — Liveness e progress são distintos; hard deadline não pode
  ser renovado por heartbeat.
  - Spec: `RUN-005..008`, `IPC-047..048`
  - Evidência parcial (2026-07-26): hard deadlines são imutáveis no launch,
    bootstrap, activation e cleanup pump; Activate/ACK verificam o limite antes
    e depois do write. O framing async também verifica antes/depois de read,
    write e replay, e cancelamento de futures/`advance` não recria sua janela.
    No control pós-Active, idle não consome `read_timeout`; depois do primeiro
    byte, progresso parcial é bounded por esse timeout e pelo hard deadline
    imutável. ACKs de Cancel/Fence usam o mínimo entre write timeout e hard
    deadline; Cancel inclui também seu grace deadline selado. No supervisor,
    todo launch instala watchdog inicial em `min(hard deadline, authority
    lease)`, e disconnect só pode encurtá-lo. O tick owner-clock já aplica esse
    limite antes e depois de termination, cleanup de provisionamento e reap.
    `SupervisorOnlineLifecycle` acorda pelo próximo deadline sem tráfego
    management; igualdade expira, regressão/tempo inválido falham fechado e
    shutdown fecha admissão e agenda todos os owners. O gate pós-reap roda antes
    da liberação da reservation; falha após sucesso físico deixa a entry
    quarantined e contabilizada. O lifecycle agora está composto com o
    `AsyncEstablishedManagementActor` real em owner único e cancel-safe:
    watchdog vence receive pendente, frame/timer são serializados, ACK de
    termination ocorre após schedule, retry semântico não repete efeito, write
    failure fecha admission sem apagar o schedule e shutdown idle retorna o
    core retido. O owner também retém writes pendentes entre cancelamentos de
    `advance()`, retoma o tracking antes do próximo ACK e mantém o watchdog
    ativo sob backpressure. A suíte de composição cobre também Launch fresh,
    replay físico, retry semântico, falha de provisionamento/write, cancelamento
    de write e regressão de clock pós-spawn.
    Em 2026-07-27, `ShutdownSupervisor` passou a compartilhar o mesmo owner:
    `Drain` preserva deadlines das attempts sob ceiling global,
    `TerminateAfterGrace` agenda todos os owners por mínimo, escalation é
    monotônica e o ACK só é emitido depois da mutação. Ledger bounded, replay
    físico, retry semântico, conflito, cancelamento/write failure e expiry
    pré-dispatch estão cobertos no serviço async.
    O bootstrap físico já roda no worker de launch owned e cancel-safe, portanto
    watchdog e shutdown não dependem de seu retorno. Atualização 2026-08-01
    (spec 1.10.0): `RunnerPulse` possui codec/HMAC bounded, counter exato,
    progress monotônico, hard deadline não renovável e prova física inicial
    runner→supervisor ligada ao PID/endpoint da attempt antes de
    `LaunchAccepted`. O receiver foi transferido para o runtime permanente do
    supervisor e o runner passou a emitir pulses periódicos e por transição de
    fase. O lifecycle acorda pelo mínimo entre deadline de cleanup, liveness e
    hard deadline; silêncio/falha agenda cleanup imediato somente da attempt
    correspondente. Atualização 2026-08-04 (spec 1.11.0): todos os pulses
    amostram RSS atual/pico, CPU acumulada e handles reais do runner no Windows;
    a falha da amostra encerra o pump e cai no mesmo expiry fail-closed.
    Atualização 2026-08-04 (spec 1.12.0): `Heartbeat` semântico passou a ser
    emitido pelo runner e recebido/validado/commitado pelo owner Host
    pós-`Active`. Liveness (`lastAliveAt`) e progress (`lastProgressAt`) são
    campos e ratchets independentes; o monitor Host renova somente seu timeout
    de silêncio e nunca altera `deadlineAt/maxWallMs`. O snapshot bounded fica
    disponível junto da inspeção da authority Active, e timeout revoga a mesma
    authority. Testes cobrem idle wake cancel-safe, sequência outbound sem
    `reply_to`, payload/métricas, commit Host e expiry; o E2E process-real prova
    o frame entre processos. Ainda faltam rollup do Job/spool,
    `UpdateAttemptAuthority`, `QuerySupervisorState`, provider operation IDs e
    deadlines próprios de operações (`RUN-007/008`); por isso o item permanece
    aberto.
    Atualização 2026-08-04 (spec 1.13.0): a leitura permanente de heartbeat e
    um outbound Cancel/Fence agora coexistem no mesmo Control sem segunda pipe.
    A lane inbound espera o commit outbound antes de validar resposta precoce;
    o ACK tem timeout independente e não renova hard deadline ou heartbeat.
    O E2E físico comprova Cancel/ACK e saída do runner.
    Atualização 2026-08-04 (spec 1.14.0): Fence percorre a mesma lane, valida
    epoch substituto maior e também comprova ACK/revogação/saída no processo
    real. Operations produtivas e os itens anteriores permanecem abertos.
- [ ] `G2-LIFE-03` — Fence perdido fecha admissão, cancela operações host-owned
  e mata a árvore após grace.
  - Spec: `RUN-009..012`, `IPC-011..012`
  - Evidência parcial (2026-07-26): `FenceAttempt` valida identity exata, epoch
    substituto estritamente maior, timestamp, reason e idempotência. Uma fence
    válida revoga o gate antes do ACK, instala `Cancelling` somente após receipt
    físico e produz cleanup tipado `Fenced`. No supervisor,
    `FenceAttemptProcess` seleciona somente a ownership exata, entra no ledger
    antes do schedule, usa grace
    `min(hard deadline, observed + sealed cancel_grace_ms)` e não pode alongar
    Cancel anterior; Reap posterior torna termination imediatamente due.
    O timer já participa do serviço async usado pelo binário process-real sem
    depender de novo frame; ainda faltam o routing de cancelamento pelo launcher
    Host, cancelamento das operações host-owned, comando management equivalente
    e recovery da outbox; o E2E Host TS já prova kill, Exited/Reaped duráveis e
    reap. Item aberto.
- [ ] `G2-LIFE-04` — Cancel ACK p95 ≤ 250 ms e árvore não cooperativa some em
  até 2 s depois da grace.
  - Spec: `GATE-LIFE-02/03`
  - Reexecução Windows x64 (2026-10-05): 50 amostras após cinco aquecimentos,
    p95 1,401 ms; supervisor e runner ausentes depois de cada ciclo. O teste
    mede attempts ociosas com o pacote `runtime-v1-928a81af8153b47c534f5c54790503c52b52ac33a3b5b9fef35e02e7ef0a514f`.
    `scratch/harness-20261003/final-native-cancel-performance.json`. Não cobre
    sozinho a árvore de ferramentas não cooperativas do gate completo.
  - Evidência parcial (2026-07-26): o ACK de `CancelAttempt` usa
    `min(grace deadline, hard deadline, write timeout)`, verifica o clock antes
    e depois do write e falha fechado no limite, em regressão ou abandono.
    `grace_deadline` também é limitado pelo budget selado. O supervisor valida
    o mesmo teto físico antes de ACKar o schedule; seu watchdog inicial e
    deadlines monotônicos impedem Cancel/Fence/disconnect de ampliar a vida da
    attempt. O loop async já mantém o timer ativo enquanto o ACK está em write.
    O routing Control pelo launcher Host e a prova E2E de ACK/saída cooperativa
    do runner já existem. Ainda faltam medição p95, drain cooperativo, comando
    físico ao supervisor e prova de desaparecimento da árvore não cooperativa
    em até 2 s; item
    aberto.
- [ ] `G2-LIFE-05` — 1.000 ciclos/24 h deixam zero PID, Job, pipe, handle e
  scratch dir órfão.
  - Spec: `GATE-LIFE-01`
  - Evidência:
- [ ] `G2-MEM-01` — Memory bomb mata apenas o attempt alvo; attempt paralelo
  conclui normalmente.
  - Spec: `RUN-010`, `RUN-023..028`, `GATE-ISO-01`, `RUST-R008`
  - Evidência:
- [ ] `G2-MEM-02` — Supervisor ocioso fica ≤ 40 MiB depois do warm-up.
  - Spec: `GATE-MEM-01`
  - Evidência:
- [ ] `G2-MEM-03` — Depois de 500 attempts, supervisor retorna a
  `baseline + max(10 MiB, 10%)`.
  - Spec: `GATE-MEM-04`
  - Evidência:
- [ ] `G2-PRE-01` — Cada runner prewarmed consome reserva global antes do spawn
  e só recebe attempt que caiba integralmente no envelope.
  - Spec: `RUN-036..038`, `RUST-R041`
  - Evidência:
- [ ] `G2-SPEC-01` — Contract/chaos suites cobrem todos os requisitos
  `RUN-001..038`, sem waiver não registrada.
  - Spec: `RUN-001..038`
  - Evidência:
- [ ] `G2-GATE` — Gate G2 aprovado.
  - Spec: `MIG-013`
  - Evidência:

## 6. G3 — engine Rust e Provider Gateway TS

Estado corrente (2026-08-04): além da máquina de lifecycle, `agent-engine`
possui o primeiro loop provider determinístico e transport-agnostic. O wire
Provider/event V1 é Protobuf gerado em TS/Rust e valida canal, direção,
identidade, digest e sequência. O composer produz o `ProviderTurnContext` antes
de `Prepared`; depois de `Active`, o processo runner usa o Data autenticado para
iniciar o Provider Gateway TS e consumir Accepted/deltas/usage/terminal. Seu
`EventSinkPort` propõe records ao Host, que os valida e os entrega ao writer
filesystem Rust; o E2E confirma cinco receipts até o terminal autoritativo. O
provider process-real e a barreira journal estão, portanto, implementados.
A fatia 1.33 acrescenta continuação in-attempt após `native.read_file`, com
pairing, cursor stateful, context bytes compartilhados e budgets de
turn/tool-call. A sequência completa possui prova duplex, mas ainda não
process-real. Transcript/compactação durável, resume por checkpoint, adapters
completos, projeção, memória e performance continuam abertos.

- [ ] `G3-ENG-01` — Engine depende apenas dos ports tipados de provider,
  capability, artifact, journal, clock e child run.
  - Spec: `ENG-001..009`
  - Evidência parcial (2026-08-04, spec 1.19.0): `agent-engine` não ganhou
    dependência produtiva; o loop recebe `ProviderGatewayPort`, `AuthorityPort`,
    `EventSinkPort` e `ClockPort` tipados, todos async e operation-scoped. Os
    ports de capability/artifact/checkpoint/child ainda serão ligados nas
    próximas transições, portanto o item permanece aberto.
  - Evidência adicional (2026-08-04, spec 1.24.0): o Runner implementa
    `ProviderGatewayPort` sem introduzir transporte no engine. O contrato
    canônico `ProviderTurnContext` omite deliberadamente identity, binding,
    deadline e idempotency; o adapter reconstrói `ProviderStart` somente com a
    authority selada da attempt. Capability/artifact/checkpoint/child continuam
    abertos.
  - Evidência adicional (2026-08-04, spec 1.27.0): a spec V1 validada agora é
    movida para `RunnerExecutionSeed`, owner não clonável com Debug redigido.
    O seed cruza Prepare/hidratação sem segunda cópia, só pode ser retirado após
    activation authority instalada, é single-use e passa ao
    `ActiveRunnerResources`. O teste assíncrono prova indisponibilidade em
    `Prepared`, conteúdo selado em `Active` e impossibilidade de segunda
    retirada; os 111 testes do runner passaram. Falta decodificar os snapshots
    executáveis e ligar authority/event sink ao loop físico.
  - Evidência adicional (2026-08-04, spec 1.28.0): `EffectGate` passou a reter
    clock/deadline e validar liveness também na build produtiva. O novo
    `EngineAuthority` implementa `AuthorityPort`; a ativação move uma instância
    para `ActiveRunnerResources`, compartilhando a revogação do driver. O teste
    prova ausência antes de `Active`, sucesso em `ProviderStart` e erro
    `Revoked` após close. Format, Clippy estrito, os 111 testes do runner e a
    suíte completa do workspace passaram; o gate de LOC confirmou 704 módulos
    produtivos sob 250 linhas. O pacote
    `runtime-v1-251bd0d0197b8beda736e3611e2f8629a20111147cb4792db16e302df00a4da8`
    (manifest
    `66ec1a59a6bb214f8df1c30b1908947a661f475053f4af34a8300a127bab773a`)
    passou verify, smoke CLI, smoke Electron e o E2E físico de lifecycle 4/4.
    Event sink durável e composer continuam bloqueadores deliberados antes de
    qualquer provider start físico.
  - Evidência adicional (2026-08-04, spec 1.30.0):
    `DurableEngineEventSink` implementa `EventSinkPort` no bridge Rust do Host e
    persiste no `agent-session-store` sem adicionar storage/transporte ao
    engine. O teste vertical percorre `TurnEngine → sink → SessionJournal →
    receipt` e só observa `Completed` depois do quinto commit. O runner→Host
    proposal/receipt e os ports de capability/artifact/checkpoint/child ainda
    permanecem abertos.
  - Evidência adicional (2026-08-04, spec 1.31.0): a composição física substitui
    o sink direto da fatia 1.30 por uma fronteira mais estreita. O runner agora
    implementa `EventSinkPort`, envia `EngineEventProposal` no Data e só avança
    após `EngineEventCommitted`; o Host valida e encaminha ao writer Rust pelo
    `agent-session-bridge`. Assim, `agent-session-bridge` voltou a depender
    somente de protocolo/store e `agent-host-bridge` continua storage-free.
    Capability/artifact/checkpoint/child ainda mantêm o item formal aberto.
  - Evidência adicional (2026-08-04, spec 1.33.0): capability passou a ter port
    de executor e checkpoints de authority `prepare/dispatch/effect` no engine;
    `started/terminal` continuam records do `EventSinkPort`, sem transporte ou
    storage no domínio. Artifact/checkpoint/child e as demais execution classes
    mantêm o item formal aberto.
- [ ] `G3-ENG-02` — Loop lógico completo é determinístico sob fixtures e não
  depende de classes/closures TypeScript.
  - Spec: `ENG-001`, `ENG-004..011`, `ENG-044..045`
  - Evidência parcial (2026-08-04, spec 1.19.0): o primeiro turno textual usa
    operation ID bounded, revalida authority antes do provider e do terminal,
    aplica deadline, quantidade/tamanho de eventos, resposta, tokens e custo;
    usage só avança monotonicamente. EOF vira `Failed`, estouro vira
    `Interrupted`, tool call vira `CapabilityRequired`, e `Completed` só nasce
    após `commit_terminal`. Cinco testes determinísticos novos + quatro da state
    machine passaram; Clippy `-D warnings`; todos os módulos produtivos do crate
    têm no máximo 206 LOC. Faltam compactação/checkpoint e composição
    process-real completa, logo o item fica aberto.
  - Evidência adicional (2026-08-04, spec 1.31.0): o mesmo `TurnEngine` roda no
    processo `agent-runner`, atravessa o provider Host TS e fecha somente depois
    do quinto receipt do journal nativo. O turno process-real está concluído;
    compactação/checkpoint ainda mantém este requisito aberto.
  - Evidência adicional (2026-08-04, spec 1.33.0): testes determinísticos cobrem
    `CapabilityDispatch -> started -> effect -> terminal -> Composing`, revogação
    imediatamente antes do efeito sem dispatch e um segundo provider turn. A
    prova duplex cruza sete receipts e leitura real. Resume por checkpoint,
    fallback e todas as outras execution classes mantêm o requisito aberto.
- [ ] `G3-CTX-01` — Hot transcript tem limite por bytes/tokens; capítulos
  antigos e payloads grandes são refs.
  - Spec: `ENG-012`, `ENG-015..020`, `DUR-007..009`
  - Evidência parcial (2026-08-04, spec 1.29.0): o composer inicial aceita
    somente trigger `INITIAL`, rejeita checkpoint/transcript e limita o
    `ProviderTurnContext` serializado ao menor valor entre
    `max_hot_transcript_bytes` e `max_ipc_bytes`. Task artifact precisa estar
    hidratada, sem compressão e em UTF-8 text/plain ou text/markdown;
    attachments permanecem refs. Cinco testes novos cobrem composição,
    contratos/canonical bytes, tool hashes/duplicidade, inference incoerente,
    resume rejeitado, artifact task e teto de bytes. Transcript quente
    multi-turn, tokens e capítulos frios permanecem abertos.
  - Evidência adicional (2026-08-04, spec 1.33.0): a continuação após tool
    deriva bytes Protobuf canônicos, anexa pairing assistant/tool e preserva o
    cursor `response_id/message_count`; o owner mantém `Arc<[u8]>` e clona só o
    ponteiro entre engine/adapter. O resultado continua inline e bounded;
    capítulos frios, contagem de tokens e promoção de output grande a artifact
    mantêm o item aberto.
- [ ] `G3-CTX-02` — Compactação preserva tool/result pairing, identity,
  interactions, budgets e side-effect ledger.
  - Spec: `ENG-009`, `ENG-020..025`
  - Evidência:
- [ ] `G3-PROV-01` — OAuth, secrets, adapters e retry físico permanecem no
  Provider Gateway TS.
  - Spec: `IPC-017..019`, `CAP-028..032`
  - Evidência parcial (2026-08-04, spec 1.21.0): a primitiva Host depende apenas
    do contrato compilável `provider-sdk/adapter|wire`, recebe resolver
    injetado e nunca representa credential/secret no wire. OAuth, retry físico
    e os adapters concretos continuam no control plane e ainda serão ligados.
- [ ] `G3-PROV-02` — `ProviderStart`, stream, cancel, usage, fallback lógico e
  terminal tipado passam na matriz de adapters.
  - Spec: `IPC-017..019`, `CAP-028..032`
  - Evidência parcial (2026-08-04, spec 1.20.0): `runtime.proto` define e gera
    em TS/Rust `ProviderStart/Accepted/Cancel`, deltas de texto/thinking, tool
    call completo, usage e terminal classificado. Os validators Host e Rust
    restringem todos ao canal Data, aplicam direção exata e exigem a mesma
    `AttemptIdentity`; `agent-protocol` passou 221 testes. Gateway, matriz de
    adapters e fallback lógico ainda permanecem abertos.
  - Evidência adicional (2026-08-04, spec 1.21.0): sete testes do Gateway
    cobrem accepted→texto→usage→terminal, EOF fail-closed, cancel, deadline que
    interrompe iterator travado, duplicidade, tool aggregation/caps e falha do
    sink. A suíte Host passou 333 testes; a matriz de adapters reais permanece
    aberta.
  - Evidência adicional (2026-08-04, spec 1.22.0): o mesmo canal Data faz
    handoff single-use após `HydrationCommitted`; dois testes duplex cobrem
    `ProviderStart → Accepted → texto → terminal` e Cancel inbound enquanto o
    iterator está pendente. Accepted autentica operation/digest/clock e seu
    replay físico é preservado; eventos compartilham uma lane outbound. A suíte
    Host passou 336 testes. Falta o peer Rust e a prova process-real.
  - Evidência adicional (2026-08-04, spec 1.23.0): o peer Rust single-owner
    envia Start e Cancel no canal Data, retém um recibo opaco somente depois do
    write físico e exige `ProviderAccepted` ligado ao message-id, digest SHA-256,
    operation, runtime instance e janela temporal exatos. Eventos exigem
    sequência monotônica; tool args têm hash validado; usage e terminal
    incompletos falham fechados; somente terminal libera a operação. O protocolo
    passou 222 testes e o runner 107, ambos com Clippy estrito. Ainda faltam a
    composição com o engine e o E2E process-real.
  - Evidência adicional (2026-08-04, spec 1.24.0): o adapter Rust converte o
    stream autenticado para os eventos do engine, preserva thinking separado,
    recusa tool call de outra operation, classifica Cancelled como Interrupted
    e entrega final usage antes do terminal. O IDL gerado passou 50 testes;
    `agent-engine` passou 10 e `agent-runner` 110 com Clippy estrito. Falta o
    E2E process-real e a matriz de providers reais.
  - Evidência adicional (2026-08-04, spec 1.25.0): um teste duplex cross-crate
    usa dois owners `AsyncEstablishedAttemptChannel` opostos e percorre
    `engine → ProviderDataGateway → ProviderStart → ProviderAccepted → texto →
    final usage → terminal → commit Completed`. O peer Host do teste comprova o
    binding/model/deadline selados e Accepted ligado ao digest real. Isso cobre
    a composição lógica e framing estabelecido, mas não bootstrap, Named Pipe
    nem isolamento de processo; o check permanece aberto até o E2E físico.
  - Evidência adicional (2026-08-04, spec 1.26.0): o workspace Rust passou
    `cargo fmt --all -- --check`, Clippy de todos os targets/features com
    `-D warnings` e todos os testes locked. Os contratos gerados passaram 50
    testes; o Host passou typecheck e 336 testes, com 4 ignorados. O gate de LOC
    confirmou 702 módulos produtivos sob o teto de 250 linhas após separar seis
    responsabilidades Host. O pacote Windows candidato
    `runtime-v1-8f1ec5589cc1763b1fdfd2f2b77d9d721b059ac4c7beb1edb7b471eb121f47ad`
    (manifest
    `daa589b5e1303c47b1ed7e0ab0edce1eb05086d0796fd2de0bc0ef176b288e31`)
    passou verify com 3 binários, smoke CLI e smoke Electron/Node-API. O E2E
    físico de lifecycle registrou uma falha transitória no ACK de Fence e, em
    seguida, duas execuções consecutivas 4/4; a flutuação continua aberta para
    estabilização e esta evidência não substitui o provider process-real.
  - Evidência adicional (2026-08-04, spec 1.29.0): `runtime.proto` agora gera
    `AgentDefinitionSnapshotV1`, `CapabilitySetSnapshotV1` e
    `ProviderPresetSnapshotV1` em TS/Rust. O runner exige schema ID/version,
    encoding Protobuf canônico, definição/preset coerentes e SHA-256 de cada
    tool schema antes de `AttemptPrepared`; o contexto composto fica retido no
    owner ativo sem disparar provider. Contratos 50/50, Host 336 com 4 skips,
    runner 116, Clippy estrito e LOC 709/250 passaram. O pacote
    `runtime-v1-c2735438d5f8d433f57fcadf5321fcfcb8d17df666b2a52fae191dae5a9ced8d`
    (manifest
    `3785aeab9a3b3b58304a2cd75850c42eb57cf82131f6f0d3f3200aed438ac4ff`)
    passou verify, smoke CLI, smoke Electron e E2E físico de lifecycle 4/4 com
    os novos snapshots. O check fica aberto: o teste ainda não envia
    `ProviderStart` pelo Named Pipe.
  - Evidência adicional (2026-08-04, spec 1.31.0): o teste físico agora envia
    `ProviderStart` pelo Named Pipe, recebe Accepted/texto/usage/terminal do
    Gateway TS e confirma a resolução do binding. A publicação do start aguarda
    o write físico; Accepted tolera somente 50 ms de skew entre peers locais e
    usa a mesma `AuthorityClock` do Data. Cinco execuções consecutivas da suíte
    física completa passaram, cada uma com 5/5 cenários. A matriz de adapters,
    fallback e capability ainda mantém o requisito formal aberto.
- [ ] `G3-PROV-03` — Perda de fence cancela todas as provider operations do
  attempt; registry do host é bounded e evicted.
  - Spec: `IPC-019`, `CAP-028..031`, `RUST-R009`
  - Evidência parcial (2026-08-04, spec 1.21.0): registry possui teto imutável,
    rejeita operation ID duplicado, vincula cada entrada à identidade exata,
    aborta todas as operações da attempt em `fenceAttempt` e libera ownership
    após terminal ou sink failure. Falta ligar a perda real de fence do owner
    Control/Data a essa chamada.
  - Evidência adicional (2026-08-04, spec 1.22.0): o owner Data permanente
    chama `fenceAttempt` no encerramento e o adapter registra failure observer
    no coordinator, eliminando o canal órfão pós-hidratação. A ligação com o
    fence Control real será comprovada no E2E provider.
  - Evidência adicional (2026-08-04, spec 1.31.0): Control e Data têm lifecycle
    de stream independente; destruir um wrapper não fecha o irmão, Data é retido
    até o cleanup coordenado e a perda efetiva chega ao registry Host. O E2E
    produtivo termina e reapeia sem owner órfão. O check permanece aberto até a
    matriz de fence durante providers reais e streams travados.
- [ ] `G3-PROV-04` — Fallback lógico checkpointa, encerra apenas a attempt e
  cria attempt `provider_fallback` com epoch maior; retry físico não faz isso.
  - Spec: `RUN-003`, `ENG-014`, `IPC-042`, `IPC-045`
  - Evidência:
- [ ] `G3-PROV-05` — Provider Gateway, OAuth, plugin providers, aliases,
  pricing, reasoning, vision e usage funcionam sem importar provider do
  `code-agent`.
  - Spec: `CUT-023`, `CUT-034`, `RUST-R049`
  - Evidência parcial (2026-08-04, spec 1.21.0): a nova pasta
    `agent-runtime-host/src/provider-gateway` não importa `code-agent`, exige
    provider/model efetivos exatos e preserva thinking, reasoning, usage e
    response ID. OAuth, aliases, pricing comprovado, vision e plugins ainda
    dependem da composição com os registries atuais, então o check fica aberto.
- [ ] `G3-ROUTE-01` — Geração `legacy_ts | rust_v1`, razão, cohort, engine e
  catalog hash são persistidos antes do launch; attempt ativa não muda.
  - Spec: `CUT-005..006`, `CUT-012`, `CUT-020`, `CUT-059..060`
  - Evidência:
- [ ] `G3-ROUTE-02` — Attempt persiste runtime/protocol version, binary digest
  e catalog digest; o canário é sticky por sessão/superfície.
  - Spec: `CUT-059..060`
  - Evidência:
- [ ] `G3-PROJ-01` — LegacyAdapter e RustHostAdapter alimentam o mesmo Rust
  session store e projector sem consulta ao runner para completar estado.
  - Spec: `CUT-008`, `CUT-018`, `CUT-032`, `CUT-062`, `CUT-064`
  - Evidência:
- [ ] `G3-IPC-01` — Control permanece responsivo com data bloqueado e toda fila
  respeita frame/byte credits.
  - Spec: `IPC-006..010`, `IPC-027..029`, `GATE-IPC-01`
  - Estado corrente (2026-08-01): **aberto**. O receiver Control v1 é
    stop-and-wait: `PrepareAttempt` permanece pending até a resposta
    `AttemptPrepared`, então não pode receber simultaneamente replay,
    Cancel/Fence ou Activate no mesmo stream. Deadline, fechamento de endpoint
    e reap continuam fail-closed, mas cumprir este item requer separar o ACK de
    aceitação da resposta Prepared ou introduzir uma segunda lane bounded.
  - Evidência adicional (2026-08-04, spec 1.31.0): a operação provider e os
    commits de engine podem bloquear Data sem transferir ownership ou cleanup ao
    Control; o runner entra em idle permanente bounded e o Host coordena o drain
    terminal. Isso elimina o acoplamento de streams observado na fatia física,
    mas não prova ainda todos os frame/byte credits nem remove o stop-and-wait de
    Prepare, portanto o item continua aberto.
- [ ] `G3-EVT-01` — Classes A–C e tipos D declarados duráveis têm paridade
  semântica 100%; terminal nunca ultrapassa delta ou artifact requerido.
  - Spec: `DUR-012..023`, `GATE-EVT-01`
  - Evidência parcial (2026-08-04, spec 1.30.0): `session_store.proto` gera em
    TS/Rust o payload canônico `EngineEventRecordV1` para started, delta,
    usage, provider completed, capability boundary e terminal. O sink liga
    cada record a `AttemptIdentity + runtimeInstanceId + localSequence`, usa
    durability `coalesced/durable/authoritative`, recebe `globalSequence` e
    hash-chain somente do writer Rust e deriva operation UUID estável para
    replay. Delta persiste apenas tamanho e SHA-256, nunca texto cru. Quatro
    testes novos provam ordenação até terminal, turno real do engine, replay
    idêntico, replay divergente fail-closed e ausência de terminal após falha de
    commit; a suíte do bridge passa 10 testes. O check permanece aberto porque
    transporte process-real, transcript/artifact barrier, todas as classes A–D
    e paridade com o projector ainda não foram concluídos.
  - Evidência adicional (2026-08-04, spec 1.31.0):
    `EngineEventProposal/EngineEventCommitted` entraram no IDL e no Data
    process-real. O journal físico recebe exatamente cinco records com sequências
    1..5 e terminal autoritativo; replay/digest/receipt são validados nos dois
    peers. O transporte do primeiro turno deixou de ser bloqueador. Permanecem
    abertos transcript/artifact, capability, todas as classes A–D e paridade do
    projector.
  - Evidência adicional (2026-08-05, spec 1.34.0): o cenário físico produtivo
    agora recebe tool call, persiste boundary/started/terminal, retoma o provider
    e termina com nove records `1..9`; quatro são autoritativos. Paridade ampla
    do projector e as demais classes A–D continuam abertas.
- [ ] `G3-MEM-01` — Runner representativo tem incremento privado ≤ 64 MiB.
  - Spec: `GATE-MEM-02`
  - Evidência:
- [ ] `G3-PERF-01` — TTFT p95 regride no máximo 5% contra baseline comparável.
  - Spec: `GATE-PERF-02`
  - Evidência:
- [ ] `G3-SPEC-01` — State-machine/property suites cobrem todos os requisitos
  `ENG-001..048`, sem waiver não registrada.
  - Spec: `ENG-001..048`
  - Evidência:
- [ ] `G3-GATE` — Gate G3 aprovado.
  - Spec: `MIG-014`
  - Evidência:

## 7. G4 — capabilities, tools e execução aninhada

Estado corrente (2026-08-05): `agent-tools` contém invocation/decision/grant e
outcome tipados; `capability.proto` gera TS/Rust; runner e Host implementam o
prepare bounded, correlacionado e fail-closed. Para um grant aceito de
`native.read_file`, o engine grava `started`, revalida authority imediatamente
antes do efeito, executa leitura Windows com prova do path pelo handle final e
grava terminal; ambos são records autoritativos. O resultado bounded mantém
pairing/cursor e retoma o provider. A policy Host fail-closed confere o digest
do catálogo hidratado, canonicaliza a raiz de workspace confiável e sela
environment, lease/fence, quotas, nonce e expiry. O E2E process-real prova a
leitura e o segundo provider turn. Falha live pós-started do executor vira
`outcome_unknown` sem retry. O scanner bounded já detecta started órfão por
receipt/payload/cadeia exatos. Permanecem abertos persistência da decisão de
recovery/probe, glob/grep/Git/HTTP, mutation/process, ToolHost e `code_exec`.

- [ ] `G4-CAT-01` — Catálogo é serializável, versionado e tem canonical
  bytes/hash idênticos em TS e Rust.
  - Spec: `CAP-001..004`, `CAP-045..047`, `RUST-R016`
  - Evidência parcial (2026-08-04, spec 1.33.0): descriptors Provider carregam
    ID, versão, execution class e mutation; `capability.proto` gera os mesmos
    tipos TS/Rust e 51 testes de contrato passaram. O item permanece aberto até
    canonical bytes/hash cross-language do catálogo completo.
  - Evidência adicional (2026-08-05, spec 1.34.0): a policy do E2E compara o
    SHA-256 exato do `CapabilitySetSnapshotV1` hidratado antes de conceder a
    leitura. O requisito segue aberto para o catálogo completo e suas demais
    execution classes.
- [ ] `G4-CAP-01` — Todas as invocations seguem prepare, approval, accepted,
  started e terminal por `operation_id`.
  - Spec: `CAP-005..010`, `IPC-020..021`
  - Evidência parcial (2026-08-04, spec 1.33.0): prepare e decisões
    `rejected|approval_required|accepted` usam IDs exatos e o mesmo canal Data;
    `native.read_file` acrescenta `started/terminal` por operation/tool/grant ID
    e sete receipts na prova duplex. O item permanece aberto até todas as
    execution classes e recovery/probe seguirem o lifecycle completo.
  - Evidência adicional (2026-08-05, spec 1.34.0): o mesmo lifecycle atravessa
    agora Named Pipes/processos reais e nove commits no writer Rust, incluindo
    segundo provider turn. Persistência recovery/probe e demais classes mantêm
    o item aberto.
- [ ] `G4-CAP-02` — Grant vincula input, capability, environment, workspace,
  fence, constraints e expiry; Rust revalida antes do efeito.
  - Spec: `CAP-008..010`, `RUST-R018`
  - Evidência parcial (2026-08-04, spec 1.33.0): grant repete e sela input,
    capability, execution class, mutation, environment, lease/fence,
    constraints, policy, nonce e expiry; Host e runner rejeitam contradições e
    o engine revalida authority/expiry/input imediatamente antes do read. O item
    permanece aberto até ambiente/lease/fence terem validação live completa em
    todas as execution classes.
  - Evidência adicional (2026-08-05, spec 1.34.0): o resolver de produto recebe
    raiz somente do Host, usa `realpath`/diretório real, confere o catálogo e
    sela environment, lease/fence, resource binding, constraints, policy,
    nonce, quotas e TTL. Testes cobrem grant exato, catálogo divergente e raiz
    indisponível. Validação live em todas as classes continua aberta.
- [ ] `G4-CAP-03` — Timeout/EOF pós-started produz probe ou
  `outcome_unknown`, nunca retry automático.
  - Spec: `CAP-005..007`, `IPC-021`, `RUST-R017`
  - Evidência parcial (2026-08-05, spec 1.35.0): depois do receipt `started`,
    erro do executor vira `OutcomeUnknown(executor_result_ambiguous)`, o engine
    chama o executor exatamente uma vez, persiste classification/reason no
    terminal wire e envia `tool_result` de erro ao provider. O item permanece
    aberto para timeout/EOF que também impeça o commit terminal, recovery de
    started órfão e probe dos handlers externos capazes de consultar outcome.
  - Evidência adicional (2026-08-05, spec 1.36.0): store/bridge paginam receipts
    autenticados, o Host confere payload Protobuf canônico e detecta started sem
    terminal; terminal com tool/grant divergente e scan truncado falham fechado.
    O item segue aberto até essa descoberta gerar uma decisão durável numa nova
    attempt/interaction e probes externos serem comprovados.
- [ ] `G4-READ-01` — Filesystem read, glob, grep, Git read e HTTP read passam
  functional, traversal, quota e cancellation suites.
  - Spec: `CAP-011..013`, `CAP-024..027`
  - Evidência parcial (2026-08-04, spec 1.33.0): `native.read_file` valida JSON
    estrito, path relativo, root final case-insensitive pelo handle Windows,
    offset, quotas, truncation e UTF-8; testes unitário e duplex leem arquivo
    real e rejeitam traversal. Glob/grep/Git/HTTP e cancellation durante I/O
    mantêm o item aberto.
  - Evidência adicional (2026-08-05, spec 1.34.0): E2E process-real passa o
    descriptor ao provider, recebe a call, concede apenas a raiz Host, lê o
    arquivo por handle final e valida o conteúdo no follow-up. O requisito
    agregado segue aberto para os demais reads e cancellation.
- [ ] `G4-MUT-01` — Write/edit/patch e Git mutation passam workspace
  binding/fence, idempotência e adversarial suites.
  - Spec: `CAP-014..017`
  - Evidência:
- [ ] `G4-PROC-01` — Shell/PTY/processos têm timeout, output bounded e
  process-tree cleanup em todos os terminais.
  - Spec: `CAP-018..023`, `RUST-R026`
  - Evidência:
- [ ] `G4-HOST-01` — MCP/plugins/LSP/browser/docs/memory usam ToolHost TS com
  o mesmo lifecycle, policy e output contract.
  - Spec: `CAP-033..036`
  - Evidência:
- [ ] `G4-HOST-02` — Company, DocsAgent, plugins e integrações usam
  descriptors/handlers neutros; nenhum contrato público depende de
  `CoderTool`, `ToolContext` ou `ToolRegistry`.
  - Spec: `CUT-017`, `CUT-024`, `CUT-026`, `CUT-036`
  - Evidência:
- [ ] `G4-HOST-03` — MCP externo mutante não é reconectado/repetido depois de
  `accepted/started`; ACK inconclusivo converge para probe ou
  `outcome_unknown`.
  - Spec: `CUT-007`, `CUT-036`, `RUST-R017`
  - Evidência:
- [ ] `G4-CODE-01` — `code_exec` roda em processo descartável no resource group,
  com env limpo e somente proxy de capabilities.
  - Spec: `CAP-037..041`, `RUST-R027..028`
  - Evidência:
- [ ] `G4-REMOTE-01` — Environment remoto nunca cai para execução local e passa
  pelo mesmo policy, lifecycle, quotas, artifact pipeline e reconciliação.
  - Spec: `CAP-048..052`, `RUST-R043`
  - Evidência:
- [ ] `G4-OUT-01` — Output grande aparece como artifact+preview e não é
  triplicado em heap, IPC e transcript.
  - Spec: `CAP-042..044`, `DUR-003..006`
  - Evidência:
- [ ] `G4-SEC-01` — Scanner encontra zero credencial reutilizável em argv, env,
  logs, frames, artifacts e dumps; nonce/token efêmero existe somente nos
  frames de bootstrap autorizados e é scrubbed em todos os terminais.
  - Spec: `SEC-001..006`, `GATE-SEC-01`
  - Evidência:
- [ ] `G4-SEC-02` — Código hostil roda com token restrito/AppContainer ou
  integridade menor; teste prova que não abre o supervisor com
  `PROCESS_DUP_HANDLE` nem duplica o último handle do Job.
  - Spec: `RUST-R060`
  - Evidência:
- [ ] `G4-POL-01` — Chaos registra zero efeito não autorizado e zero duplicação
  de mutation.
  - Spec: `GATE-POL-01`
  - Evidência:
- [ ] `G4-PERF-01` — Overhead p95 do dispatch nativo é ≤ 5 ms.
  - Spec: `GATE-PERF-03`
  - Evidência parcial Windows x64 (2026-10-05): benchmark release da feature
    `performance-harness`, 1.000 amostras após 100 aquecimentos, p95 0,301 ms.
    Mede o executor real com leitura de 4 KB, validação, pool bloqueante e
    encoding; o total é um teto para seu overhead, sem subtrair baseline.
    Exclui admission de policy, IPC Host e journal. Comando
    `node scripts/benchmark-rust-agent-dispatch.mjs`; relatório com hash do
    binário em `scratch/harness-20261003/final-native-dispatch-performance.json`.
    O gate global permanece aberto para a cadeia de dispatch completa.
- [ ] `G4-SPEC-01` — Suites por execution class cobrem todos os requisitos
  `CAP-001..052`, sem waiver não registrada.
  - Spec: `CAP-001..052`
  - Evidência:
- [ ] `G4-GATE` — Gate G4 aprovado.
  - Spec: `MIG-015`
  - Evidência:

## 8. G5 — durability, waiting e run-tree

Estado corrente (2026-08-01): `agent-session-store`, journal/recovery,
transferência autenticada e a fundação de spool já existem e pertencem a G1.
Isso ainda não implementa os requisitos G5 de checkpoint completo,
waiting/resume, GC, child runs e subagentes process-real.

- [ ] `G5-ART-01` — Scratch, spool e artifact store são camadas separadas com
  quotas por artifact/attempt/session/global.
  - Spec: `DUR-003..006`, `DUR-025..026`
  - Evidência:
- [ ] `G5-ART-02` — Promotion valida containment, tamanho, hash e manifest antes
  do ACK durable.
  - Spec: `DUR-003..005`, `SEC-005..006`
  - Evidência:
- [ ] `G5-ART-03` — GC mark/sweep preserva toda ref durable e remove órfãos
  somente depois da grace.
  - Spec: `DUR-006`, `DUR-026`, `RUST-R023`
  - Evidência:
- [ ] `G5-CHK-01` — Checkpoint versionado contém apenas estado bounded e refs;
  escrita/promotion é crash-safe.
  - Spec: `DUR-007..011`
  - Evidência:
- [ ] `G5-CHK-02` — Crash em cada fronteira mantém o último checkpoint
  confirmado legível em 100% dos casos.
  - Spec: `GATE-REC-01`
  - Evidência:
- [ ] `G5-WAIT-01` — Waiting/interaction checkpointa e encerra o process; a
  resposta cria attempt `resume` com epoch maior.
  - Spec: `ENG-029..032`, `ENG-048`, `RUN-013..015`, `IPC-041..045`
  - Evidência:
- [ ] `G5-CHILD-01` — Todo subagente visível/durável é child `AgentRun` com
  attempt e processo próprios.
  - Spec: `ENG-033..038`, `RUN-016..020`
  - Evidência:
- [ ] `G5-CHILD-02` — Host aplica maxAgents/maxDepth, admission e budget
  delegado atomicamente antes do child spawn.
  - Spec: `ENG-034..038`, `RUN-017..018`, `RUST-R031`
  - Evidência:
- [ ] `G5-CHILD-03` — Pai recebe digest/result/transcript refs bounded, nunca o
  transcript integral do filho no heap.
  - Spec: `ENG-035`, `RUN-019`, `RUST-R029`
  - Evidência:
- [ ] `G5-CHILD-04` — Terminal de child atualiza somente o child; root command
  depende da completion policy do root e dos children/verifier obrigatórios.
  - Spec: `IPC-030`, `IPC-046`, `DUR-012`
  - Evidência:
- [ ] `G5-BG-01` — Foreground/background alteram wait mode, não deadline,
  authority ou obrigação de reaping.
  - Spec: `ENG-039..041`, `RUN-014`, `RUST-R030`
  - Evidência:
- [ ] `G5-SURF-01` — DocsAgent usa role/catalog Rust e não instancia
  `CoderRunner` ou `ToolRegistry`.
  - Spec: `CUT-039`, A10 de `08`
  - Evidência:
- [ ] `G5-SURF-02` — `execute_tasks`, workflows, ChatPipeline e verifier
  agendam child AgentRuns; nenhum estágio chama `runSubagent`.
  - Spec: `CUT-038..039`, A09/A11 de `08`
  - Evidência:
- [ ] `G5-SURF-03` — Plugin assistant usa AgentRun Rust restrito e não mantém
  mini-loop de agente paralelo.
  - Spec: `CUT-061`, A20 de `08`
  - Evidência:
- [ ] `G5-MEM-01` — Root+8 filhos usa menos de 3× o incremento privado do
  cenário root-only.
  - Spec: `GATE-MEM-03`
  - Evidência:
- [ ] `G5-SPEC-01` — Suites de storage/journal/telemetria/security cobrem
  `DUR-001..031`, `OBS-001..008` e `SEC-001..006`.
  - Spec: `DUR-001..031`, `OBS-001..008`, `SEC-001..006`
  - Evidência:
- [ ] `G5-GATE` — Gate G5 aprovado.
  - Spec: `MIG-016`
  - Evidência:

## 9. G6 — shadow, chaos, soak e canário

Estado corrente (2026-08-01): adapters `test|shadow` existem apenas para validar
as fronteiras Host atuais. Replay comparativo, métricas de divergência, chaos,
soak e cohorts de produto ainda não foram iniciados.

- [ ] `G6-SHADOW-01` — Contract replay compara decisões/eventos com fixtures
  redigidas e executors sem efeito.
  - Spec: `MIG-007`, seção 10.1 de `06`
  - Evidência:
- [ ] `G6-SHADOW-02` — Shadow read-only/decision não publica resposta nem
  executa provider faturável ou mutation em duplicidade.
  - Spec: `MIG-007`, `RUST-R034`
  - Evidência:
- [ ] `G6-CHAOS-01` — Matriz injeta falha em accepted/started/terminal,
  checkpoint, channels, provider, child, OOM, disk e fence.
  - Spec: seção 10.2 de `06`, tabela de failure modes de `07`
  - Evidência:
- [ ] `G6-SOAK-01` — Soak de 6 h tem inclinação robusta < 1 MiB/h no
  supervisor e host após warm-up.
  - Spec: `GATE-MEM-05`
  - Evidência:
- [ ] `G6-SOAK-02` — Attempt representativa permanece ativa por 6 h com
  inclinação privada < 1 MiB/h depois de estabilizar a hot window, sem
  collection/queue ilimitada.
  - Spec: `GATE-MEM-06`
  - Evidência:
- [ ] `G6-SOAK-03` — Soak 24 h/1.000 ciclos mantém zero órfão e terminal único.
  - Spec: `GATE-LIFE-01/04`
  - Evidência:
- [ ] `G6-QUAL-01` — Conformance determinística passa 100% e benchmark agentic
  satisfaz o IC de não inferioridade de −2 pontos percentuais.
  - Spec: `GATE-QUAL-01/02`, `RUST-R044`
  - Evidência:
- [ ] `G6-REL-01` — Erro interno atribuível ao Rust fica ≤ 0,1% e dentro de
  +0,05 ponto percentual do legado.
  - Spec: `GATE-REL-01`
  - Evidência:
- [ ] `G6-ROLL-01` — Kill switch impede novas admissões Rust sem depender do
  daemon.
  - Spec: `MIG-018..023`, `RUST-R036`
  - Evidência:
- [ ] `G6-ROLL-02` — Rollback ensaiado não transfere attempt ativo nem duplica
  efeito pós-started.
  - Spec: `MIG-020..022`, `RUST-R035`
  - Evidência:
- [ ] `G6-SPEC-01` — Contract, compatibility, fuzz e E2E suites cobrem todos os
  requisitos `IPC-001..048`, sem waiver não registrada.
  - Spec: `IPC-001..048`
  - Evidência:
- [ ] `G6-SURF-01` — A01–A11 e A20 passaram canário, restart, cancelamento,
  replay e contrato público com evidência individual.
  - Spec: `CUT-013`, `CUT-031..039`, `CUT-046`
  - Evidência:
- [ ] `G6-SURF-02` — A12–A15 passaram canário por árvore inteira, incluindo
  Company master/subordinates, scheduler, App Studio, pause/resume e recovery.
  - Spec: `CUT-011`, `CUT-040`, `CUT-047`, `RUST-R048`
  - Evidência:
- [ ] `G6-SURF-03` — A16–A19 passaram canário de MCP, CLI, remote, admin,
  shutdown e build instalada.
  - Spec: `CUT-041..044`, `CUT-046`
  - Evidência:
- [ ] `G6-C0` — Canário interno C0 concluído por ≥ 48 h, sem stop condition.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C1` — Canário 1% concluído por ≥ 48 h e ≥ 200 attempts.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C2` — Canário 5% concluído por ≥ 72 h e ≥ 1.000 attempts.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C3` — Canário 25% concluído por ≥ 7 dias na matriz representativa.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-C4` — Canário 50% concluído por ≥ 7 dias com suporte e rollback
  exercitados.
  - Spec: seção 10.3 de `06`
  - Evidência:
- [ ] `G6-GATES-01` — Todos os gates `MEM`, `ISO`, `LIFE`, `PERF`, `IPC`,
  `EVT`, `QUAL`, `REL`, `POL`, `REC`, `SEC` e `PKG` passam no mesmo build
  candidato.
  - Spec: seção 3 de `06`
  - Evidência:
- [ ] `G6-GATE` — Gate G6 aprovado.
  - Spec: `MIG-017`
  - Evidência:

## 10. G7 — default e retirada do legado

- [ ] `G7-C5` — Rust atende 100% do tráfego elegível por ≥ 14 dias sem fallback
  acionado por regressão.
  - Spec: seção 10.3 de `06`, `CUT-049`
  - Evidência:
- [ ] `G7-COV-01` — A01–A20 possuem owner, contract/E2E, canário e estado
  `rust_default` no manifest.
  - Spec: `CUT-001`, `CUT-013`, seção 8 de `08`
  - Evidência:
- [ ] `G7-FACADE-01` — HTTP, SSE, Company, DocsAgent, plugin assistant, MCP e
  CLI passam por `AgentRuntimeFacade`; nenhum entry point chama runner/pool.
  - Spec: `CUT-003..004`, `CUT-015..016`, `CUT-031..043`, `CUT-061`
  - Evidência:
- [ ] `G7-DEF-01` — Rust é default durable para todo novo `AgentRun`.
  - Spec: `MIG-018`, `CUT-005`, seção 12 de `06`
  - Evidência:
- [ ] `G7-DEF-02` — Criação de novos attempts legados está desabilitada; attempts
  novos permanecem sticky e duravelmente atribuídos ao Rust.
  - Spec: `CUT-005..006`, `CUT-060`, seção 12 de `06`
  - Evidência:
- [ ] `G7-DRAIN-01` — Zero attempt, lease, interaction, checkpoint, PID, worker
  ou operation host-owned legado permanece ativo/órfão.
  - Spec: `CUT-012`, `CUT-048`, `CUT-055`
  - Evidência:
- [ ] `G7-TREE-01` — Company/App Studio não possui árvore mista; master,
  subordinates, verifier e especialistas são Rust.
  - Spec: `CUT-011`, `CUT-040`, `CUT-047`
  - Evidência:
- [ ] `G7-PROV-01` — Cada attempt tem runtime/protocol version, binary digest e
  catalog digest consultáveis no journal/admin.
  - Spec: `CUT-005`, `CUT-059`
  - Evidência:
- [ ] `G7-PROJ-01` — Journal/projector host é autoridade; não há dual-write,
  tabelas `rust_*` paralelas nem transação duplicada no indexer.
  - Spec: `CUT-007..009`, `CUT-062`
  - Evidência:
- [ ] `G7-HIST-01` — Sessões antigas, IDs legados, transcripts, tasks, goals,
  specs, Company e App Studio continuam legíveis na build sem executor legado.
  - Spec: `CUT-010`, `CUT-019`, `CUT-033`, `CUT-045`
  - Evidência:
- [ ] `G7-EXT-01` — Providers, stores, tool SDK, prompts, skills, LSP,
  pipelines, preview/browser e helpers sobreviventes possuem owner fora do
  package legado.
  - Spec: `CUT-022..028`
  - Evidência:
- [ ] `G7-IMPORT-01` — Busca estática por package/path/tipos/símbolos legados
  retorna zero consumidor fora de documentação e fixtures neutras aprovadas.
  - Spec: `CUT-002`, `CUT-029`, `RUST-R045`, `RUST-R049`
  - Evidência:
- [ ] `G7-DEPS-01` — Dependency graph e manifests de Company, DocsAgent,
  plugin-host, provider-engine e provider-runtime não dependem de
  `@mcp/code-agent`.
  - Spec: `CUT-028..029`
  - Evidência:
- [ ] `G7-ORACLE-01` — Fixtures congeladas substituem o runtime legado como
  oracle e não importam, não transpilam nem executam seu código.
  - Spec: `MIG-024`, `CUT-053`, `RUST-R055`
  - Evidência:
- [ ] `G7-ROLL-01` — Drill antes da retirada prova rollback somente de novas
  attempts, sem transferência ativa ou repetição de mutação.
  - Spec: `MIG-018..023`, `CUT-012`, `CUT-050`
  - Evidência:
- [ ] `G7-DEL-01` — `CoderWorkerPool`, singleton, `coder-worker`, watchdog,
  runner wiring, RPC shims e launch path exclusivos foram removidos em PRs
  auditáveis.
  - Spec: `MIG-024`, `CUT-051..052`
  - Evidência:
- [ ] `G7-COMPANY-01` — O hosting Company não contém agente embutido; o worker
  foi removido ou permanece explicitamente apenas como control plane TS.
  - Spec: A12–A15 de `08`, `CUT-040`, `CUT-052`
  - Evidência:
- [ ] `G7-DEL-02` — `CoderRunner`, `runCoder`, `runSubagent`, registries, tools
  substituídas e `packages/code-agent` foram removidos depois de grafo zero.
  - Spec: `MIG-024`, `CUT-028..029`, `CUT-051..053`
  - Evidência:
- [ ] `G7-BUILD-01` — Scripts, aliases TS/Vite/Vitest, prompts, checks,
  lockfile e Electron packaging não apontam ao legado; cobertura equivalente
  permanece.
  - Spec: `CUT-027`, `CUT-044`, `CUT-051`
  - Evidência:
- [ ] `G7-PKG-01` — Scan do ASAR/extraResources/build instalada prova ausência
  de package, worker, bundle, prompt path e launcher legado.
  - Spec: `GATE-PKG-01`, `CUT-054`, `RUST-R054`
  - Evidência:
- [ ] `G7-PROC-01` — Start/cancel/crash/update/quit/restart da build final deixa
  zero worker V8, PID, Job, pipe, handle, child ou scratch legado.
  - Spec: `CUT-055`
  - Evidência:
- [ ] `G7-OPS-01` — Dashboards, alertas, runbook, suporte e docs apontam para o
  runtime Rust.
  - Spec: `OBS-001..008`, `MIG-024`, `CUT-043`
  - Evidência:
- [ ] `G7-KILL-01` — Kill switch final para novas admissões Rust funciona sem
  depender de fallback legado.
  - Spec: seção 12 de `06`, `CUT-014`
  - Evidência:
- [ ] `G7-DATA-01` — `DataDispositionManifest` classifica toda tabela, coluna,
  índice e artifact como produto, audit, projection, bridge, runtime-only ou
  unknown; nenhum unknown permanece.
  - Spec: `CUT-010`, `CUT-056`, `RUST-R050`
  - Evidência:
- [ ] `G7-DATA-02` — Dados de produto e migrations históricas foram
  preservados; nenhum `DROP` destrutivo ocorreu no PR/release de retirada.
  - Spec: `CUT-010`, `CUT-045`, `CUT-051`, `CUT-056`
  - Evidência:
- [ ] `G7-DATA-03` — Qualquer contração executada respeitou 30 dias e uma
  release estável, com leitor N-1, bancos implantados, backup/restore,
  integrity, contagens e histórico validados.
  - Spec: `CUT-057..058`, `RUST-R056`
  - Evidência:
- [ ] `G7-DATA-04` — Todo bridge/runtime-only remanescente foi removido sob
  `G7-DATA-03` ou retido explicitamente com owner, motivo, retention e prazo.
  - Spec: `CUT-056..058`, `CUT-063`
  - Evidência:
- [ ] `G7-ROLL-02` — Drill pós-deleção volta à última build Rust estável ou
  `halt` sem reintroduzir o code-agent e sem incompatibilidade de schema.
  - Spec: `CUT-014`, `CUT-050`, `CUT-057..058`
  - Evidência:
- [ ] `G7-GATE` — Gate G7 e definição global de concluído aprovados.
  - Spec: `MIG-024`, `CUT-063`, seção 13 de `06`
  - Evidência:

## 11. GI — trilho paralelo do indexador (doc 09)

Fases I0–I4 correm em paralelo ao programa principal com duas amarras: I0 DEVE
preceder o canário G6 (é o piloto de packaging da cadeia nativa) e I2..I4 NÃO
DEVEM iniciar antes de o canário do agentd estar em soak, salvo ADR.

- [ ] `GI-00` — Spec 09 aceita; decisões `D-IDX-001..010` registradas em
  `DECISIONS.md`; ownership de index.db, modelos, generations e `doc_*` com
  exatamente um owner.
  - Spec: `SCOPE-IDX-001..005`, `D-IDX-001..010`
  - Evidência:
- [ ] `GI-01` — Workspace `native/index-runtime` criado; toolchain, lockfile,
  fmt/clippy/audit e build release no CI, espelhando G1.
  - Spec: `D-IDX-001`, `SCOPE-006..009`
  - Evidência:
- [ ] `GI-02` — Baseline congelada em build empacotada: nDCG do harness de
  código (3×, dispersão registrada), eval-metrics de docs e golden extracts por
  linguagem suportada.
  - Spec: `SCOPE-IDX-003`, `D-IDX-010`
  - Evidência:
- [ ] `GI-03` — I0: walker/hasher empacotado e assinado atrás de cohort;
  paridade de conjunto de arquivos em três repositórios reais (incluindo o caso
  Assets/68k); CPU de walk fora do main. `IDX-GATE-0` aprovado.
  - Spec: `D-IDX-009`, `IDX-GATE-0`, `SCOPE-010..012`
  - Evidência:
- [ ] `GI-04` — I1: watch nativo com reconcile por content-hash, sem re-scan
  storm; watch budget rebaixado a telemetria. `IDX-GATE-1` aprovado.
  - Spec: `D-IDX-006`, `IDX-GATE-1`
  - Evidência:
- [ ] `GI-05` — I2: extração tree-sitter com golden extracts idênticos;
  `indexd` como escritor único do `index.db` com lock de transição testado sob
  contenção; consumidores (outline/rename/skeleton) inalterados. `IDX-GATE-2`
  aprovado.
  - Spec: `D-IDX-003`, `D-IDX-010`, `IDX-GATE-2`
  - Evidência:
- [ ] `GI-06` — I3: embeddings bge-m3 e cross-encoder via `ort`; ANN servida
  por RPC; nDCG ≥ baseline; drift coseno dentro do limiar; RSS do Electron sem
  termo de ONNX; re-embed completo por generation. `IDX-GATE-3` aprovado.
  - Spec: `D-IDX-004..005`, `D-IDX-008`, `IDX-GATE-3`
  - Evidência:
- [ ] `GI-07` — I4: compute de RAG docs (extração, chunking, PDF, embed) no
  `indexd`; extraction-pool Node removido; captação/política/persistência
  intactas no host; eval-metrics iguais ou melhores. `IDX-GATE-4` aprovado.
  - Spec: `D-IDX-007`, `IDX-GATE-4`
  - Evidência:

## 12. Auditoria final de invariantes

- [ ] `FINAL-01` — Exatamente um executor ativo por `AgentRunAttempt`.
  - Evidência:
- [ ] `FINAL-02` — Todo child `AgentRun` possui attempt/process/fence próprios.
  - Evidência:
- [ ] `FINAL-03` — SQLite não contém runtime de sessão e não é aberto por Rust;
  `agent-session-store` é o writer físico único dos bundles `rust_fs_v1`, e o
  Host TypeScript não abre seus arquivos mutáveis.
  - Evidência:
- [ ] `FINAL-04` — Nenhum secret ou credential é persistido ou entregue em
  claro ao runner.
  - Evidência:
- [ ] `FINAL-05` — Nenhuma fila, transcript quente, output, spool, mapa de
  operação ou pool de tarefas é ilimitado.
  - Evidência:
- [ ] `FINAL-06` — Terminal durable é único, idempotente e posterior ao
  transcript/artifacts necessários.
  - Evidência:
- [ ] `FINAL-07` — Mutação incerta nunca é repetida automaticamente.
  - Evidência:
- [ ] `FINAL-08` — Waiting, cancel, deadline, crash, OOM e shutdown sempre
  convergem para fence e reap.
  - Evidência:
- [ ] `FINAL-09` — Rust, e não o `code-agent` legado, executa todos os caminhos
  de produto suportados.
  - Evidência:
- [ ] `FINAL-10` — Baseline residual do Electron está medida e tratada como
  frente separada.
  - Evidência:
- [ ] `FINAL-11` — A01–A20 usam o runtime Rust por uma fachada neutra; nenhum
  fluxo de produto mantém mini-runner ou árvore de geração mista.
  - Evidência:
- [ ] `FINAL-12` — `packages/code-agent`, seus workers, bundles, launchers,
  imports e package dependencies estão ausentes da build instalada.
  - Evidência:
- [ ] `FINAL-13` — Sessões e dados históricos continuam legíveis; toda
  contração possui disposition, backup/restore e prova sobre DB implantado.
  - Evidência:
- [ ] `FINAL-14` — Rollback operacional usa a última build Rust estável ou
  `halt`, nunca reativa o executor legado.
  - Evidência:

## 13. Registro de evidências

Adicione uma linha por evidência imutável usada acima.

| ID | Tipo | Commit/build | Plataforma | Data | Link/path | Owner |
|---|---|---|---|---|---|---|
|  | teste/benchmark/trace/chaos/ADR |  |  |  |  |  |
