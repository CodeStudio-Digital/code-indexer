# Melhoria de todas as ferramentas — 2026-10-06

O escopo inclui todas as famílias existentes, os aliases de compatibilidade e
os catálogos dinâmicos de MCP/plugins. O [inventário gerado](./tool-inventory.md)
lista **247 nomes próprios** com sua definição: **162 habilitados no catálogo
Rust de desenvolvimento (161 de entrada e 1 exclusivo dos filhos) e 85 ainda pendentes de integração nativa**. Ferramenta
pendente de integração Rust já pode funcionar no legado. Habilitação de catálogo,
melhoria do executor e certificação do aplicativo são estados distintos.

O pedido “melhore TODAS” continua aberto até concluir a integração e os testes de
cada família. As alterações abaixo melhoram os pontos de execução compartilhados;
não significam que 247 implementações foram individualmente reescritas ou que
todas passaram por uso real no aplicativo.

## Alterações implementadas no checkout

### Coder Windows, compactação e sete ferramentas — 2026-10-23

O estado atual e as evidências desta entrega estão no
[relatório do candidato Windows](./11-coder-windows-release-2026-10-23.md).
Os marcos r8 e anteriores abaixo são históricos: a compactação durável e as
sete ferramentas já estão implementadas e validadas no pacote R12. Passaram
10.000 turnos com compactação e retomadas, a matriz do pacote e a comparação
integral dos 4.934 arquivos do instalador. Essa entrega permanece separada da
certificação global da migração e da instalação existente no PC.

### Matriz r8 e retomada de leituras parciais — 2026-10-08

O pacote r8 passou a matriz de 155 capacidades: 100 checkpoints recuperados,
zero replay do provider e 621 processos encerrados naturalmente. Subagentes,
inventário e espera, execução de tarefas, preview Electron, navegador, banco,
comandos, MCP/plugins e recuperação passaram. Compatibilidade e CLI também
passaram, com 84 e 56 processos naturais. A CLI retornou 0 para execução,
retomada e aprovação, 130 para cancelamento e 1 para falha; o SIGINT foi
acionado via IPC da fixture Windows. Pacote `dist/electron-native-task-r8-20261008/win-unpacked`; ASAR
`bd575c525481f5e3eabc4382f8a1a452717b1d5c9f9891d12784c94fbf1240c2`.
Fonte congelada em `scratch/harness-candidates/2026-10-08T23-58-21-827Z/manifest.json`,
SHA `076899ab2320913a02470d3d5b20ce2521bdbc80de5d00ca26a4fee3e072f55b`.
Evidência: `native-task-r8-packaged-matrix/report.json`.

O teste novo de turnos físicos encontrou uma falha não coberta pela matriz:
o histórico perdia `truncated`/`originalSize` dos resultados. O conteúdo
continuava correto, mas a retomada recusava o digest diferente. A projeção
agora preserva esses metadados do recibo terminal confirmado, sem enfraquecer
a verificação ou aceitar metadados arbitrários do payload da ferramenta.

Essa correção posterior ao r8 passou uma sessão de 100 turnos e outra de 1.000:
na segunda foram 1.001 chamadas ao provider determinístico, 11 attempts,
zero leituras repetidas e 49 processos naturais. Evidência:
`native-long-1000-report.json`; o journal ocupou 20.531.480 bytes. São turnos
executados pelo Rust com IPC, leituras, commits e retomada, não registros
semeados nem chamadas a um provider real. A medição teve outros testes locais
concorrentes; recuperação inclui reconstrução e verificação do round-trip.
Não constitui benchmark estatístico nem certificação da UI. A rodada de
10.000 turnos falhou depois de 1.024 chamadas ao provider: o gateway mantém
o teto de 2.048 mensagens. `native-long-10000-report.json` conserva a falha;
49 processos encerraram naturalmente. O contador de turnos no relatório só
avança após cada lote validado, portanto registra 1.000, e não todo o lote
interrompido. O gate de 10.000 permanece aberto; o teto não foi aumentado.

O planejador em `agent-engine/src/context.rs` seleciona um trecho fechado,
preserva mensagens protegidas e a janela recente, reserva espaço do resumo e
considera bytes, tokens e quantidade de mensagens. Recusa pares inválidos,
overflow e compactação impossível. Passaram dez testes do planejador mais os
24 existentes do engine; Clippy passou com warnings negados. Evidências:
`native-context-plan-engine-r2-processes` e `native-context-plan-clippy-r3-processes`.
O build de teste precisou encerrar um auxiliar rastreado; `verifiedEmpty=true`.
O planejador ainda não está ligado à geração de resumo, capítulo durável ou
retomada; não executa compactação nem resolve sozinho o limite observado.

A correção dos metadados de truncamento passou 45 testes em seis arquivos
(incluindo nove cenários físicos), typecheck e 70 processos naturais:
`native-history-truncation-r3-processes`. Dois testes antigos foram adaptados
ao contrato atual: efeito incerto rejeita a promise e a lease retida pode
bloquear a retomada antes da leitura do journal. Continuam exigindo nenhuma
repetição da escrita nem nova chamada ao provider. O pacote r8 ainda não
contém a correção; instalação e padrão legado permanecem inalterados.

### Integração do chat e cancelamento da pesquisa — fonte para r8, 2026-10-08

A matriz r7 encontrou `list_agents` ausente no chat comum: o executor possuía
a ferramenta, mas sua preparação só a registrava para Company. A fonte agora
registra `list_agents` e `wait_agents` também nas attempts nativas sem Company.
O r7 está reprovado; a correção passou depois na matriz r8 acima. Evidência:
`native-task-r7-packaged-matrix/report.json`; os 358 processos encerraram
naturalmente. Build e matriz r8 passaram posteriormente.

O DocsAgent agora propaga cancelamento à síntese, revisão final, reescrita,
reranking e embeddings. Cancelar durante a revisão final grava `aborted`, e
respostas tardias não entram no ledger de evidências. O fanout deixa de iniciar
novas coleções após cancelamento. Uma leitura vetorial já em execução ainda
aguarda o backend, mas seu resultado é descartado. Passaram 99 testes em 16
arquivos (`native-docs-cancel-final-processes`, 20 processos naturais). As seis
ferramentas DocsAgent ainda não foram migradas para a árvore Rust.

### Inventário e espera nativa, limites de tarefas — fonte para r7, 2026-10-08

`list_agents` consulta a árvore admitida pelo coordenador Rust, preserva a
ancestralidade e distingue execução, interação pendente e término. O formato
JSON explícito agora é respeitado. `wait_agents` aguarda eventos, é cancelável,
limita o tempo e recusa alvo externo, ancestral, espera em ciclo ou filho ainda
na fila. Nenhuma dessas projeções autoriza executar novamente um filho.

O plano é limitado a 64 KiB antes de admitir filhos, reservando espaço para
128 resultados compactos, inclusive strings com escapes JSON. Os resultados
completos ficam no histórico. A conclusão inline também preserva o conteúdo
integral no registro da execução. Falhas de armazenamento foram injetadas antes
e depois do commit da admissão; a execução fica invalidada e não admite outro
filho. Isso é injeção de falha, não teste de volume físico cheio.

Passaram 334 testes em 19 arquivos, typecheck/build, 23 cenários físicos da
árvore e dois cenários posteriores de inventário/espera entre irmãos. Evidências:
`native-task-tree-final-unit-processes`, `native-task-all-tree-processes`
(209 processos naturais) e `native-task-wait-physical-processes` (25 naturais).
O orçamento compartilhado também passou fisicamente no novo binário
`runtime-v1-da76430c7bf10c70e50198db5851c8850a1c99fd7cff814393ce6e4a866473ee`.
O build anterior encerrou um auxiliar remanescente pelo Job rastreado;
`verifiedEmpty=true`. O pacote r7 foi reprovado na preparação do chat; r6 ainda é a referência
empacotada aprovada. A instalação em uso e o padrão legado permanecem.

Restam sete ferramentas Coder, 77 Company, seis DocsAgent e duas MCP internas,
além dos gates de recovery, qualidade e rollout documentados no checklist.

### Execução de tarefas validada em Electron — fonte posterior ao r6, 2026-10-08

`execute_tasks` entrou no catálogo de desenvolvimento. O checkpoint privado,
sem expiração por idade, registra a referência de cada filho antes de preparar
o processo. A retomada confere journal completo, autoridade, reap e drenagem;
trocar o plano não contorna referências incertas. A criação do checkpoint é
condicional e tokens de lease expirados não podem publicar novas referências.

O teste físico detectou e corrigiu a passagem de aprovação de plano ao contexto
e aos filhos. Também foram corrigidos o registro pendente após conclusão inline,
a publicação do quadro após falha conhecida e o excesso de resumo no quadro.
O texto completo permanece no journal do filho e no histórico da execução.

Passaram **319 testes**, typecheck/build e `native-execute-tasks-http-r4/report.json`:
quatro tarefas, três filhos Rust, arquivo de saída de cada escrita verificado,
resposta longa, encerramento inline, sete checkpoints recuperados, zero replay
e nenhum filho relançado. Os 51 processos físicos encerraram naturalmente.
As escritas dos filhos continuam sob a barreira exclusiva do scheduler.

Depois desse teste, a fonte separou orçamento compartilhado esgotado de autoridade
revogada. O engine classifica o primeiro como `max_turns`, preservando a falha
para o segundo; 22 testes do gateway e a suíte `agent-engine` passaram. Essa
última classificação foi posteriormente validada no binário descrito acima.

Essa fonte não integra o pacote r6. O runtime padrão e a instalação do PC não
foram alterados. As ferramentas Coder restantes, Company, DocsAgent,
MCP aninhado e os gates de produção continuam pendentes.

### Pacote r6 confirmado; execução de tarefas em integração — 2026-10-08

O r6 incorpora workflow e o avaliador descartável. A matriz passou com 96
checkpoints recuperados, zero replay e 601 processos encerrados naturalmente.
Compatibilidade (smoke, legado e RAG) e CLI passaram com 84 e 56 processos.
Pacote: `dist/electron-native-isolated-r6-20261008/win-unpacked`; ASAR
`34441384833aa0a8b28617fcc2b513f62e04b97b74edad6801853a50c2d1ce2d`.
Fonte congelada em `scratch/harness-candidates/2026-10-08T22-22-19-645Z/manifest.json`,
SHA `470837426567af4c145e8cec25ec06aa281bec70dc5dc247ecc74748b1eb44e3`.
Evidências: `native-isolated-r6-packaged-matrix/report.json`,
`native-isolated-r6-package-compat/` e `native-isolated-r6-packaged-cli/report.json`.

A regressão das ferramentas aprovou 1.286 asserções; um teardown Git falhou
por objetos somente leitura no Windows. A limpeza foi corrigida apenas dentro
das fixtures, e o arquivo passou novamente (sete testes, 33 processos naturais).

O pacote r6 é anterior à integração de `execute_tasks` descrita acima.
Nenhum novo instalador foi aplicado; os gates globais continuam abertos.

### Avaliador descartável de code_exec — fonte posterior ao r5, 2026-10-08

O Rust agora exige um processo separado para avaliar JavaScript. O Job nativo
contém o processo, limita memória e tempo e confirma seu encerramento; ausência
de recibo de reap conserva a incerteza. Permissões, concorrência e recibos das
ferramentas continuam nos proxies do Host. O protocolo limita frames, chamadas,
logs e tráfego agregado; serialização da resposta acontece no processo auxiliar.
O `stash` continua sendo cache de sessão, com deltas ordenados pelo transporte.

Passaram 102 testes focados, typecheck/build e oito cenários físicos: leituras
sobrepostas, barreira de escrita, stash, erros/permissões, chamada lenta sem
consumir orçamento JS, loop infinito após await, cancelamento, saída excessiva,
efeito incerto e consultas `change`. O loop não bloqueou o timer do Host.
Pelo chat Electron/HTTP/SSE, aprovação, cancelamento e restart passaram com sete
checkpoints e zero replay. Evidências: `native-code-isolation-physical-report.json`
e `native-code-isolation-http/report.json`; 18 e 56 processos encerrados
naturalmente, respectivamente. Ainda não incorporado ao pacote r5.

### Workflow nativo e pacote r5 — 2026-10-08

O workflow grava a referência da attempt filha antes de iniciar seu provider.
Na retomada, verifica autoridade, journal imutável, terminal e encerramento
físico antes de aceitar o resultado; efeito incerto bloqueia repetição e etapas
dependentes. A geração do runtime fica gravada no workflow, impedindo retomada
mista. Preserva DAG, contexto das dependências e eventos públicos.

Passaram 306 testes focados, typecheck e a regressão da árvore com 357 testes
em 26 arquivos, incluindo 22 cenários físicos. Pelo chat HTTP/SSE e Electron,
duas etapas escreveram e verificaram o arquivo; após restart, a retomada lançou
zero filhos. Evidências: `native-workflow-all-tree-report.json` e
`native-workflow-http/report.json`. Os respectivos ledgers confirmam 222 e 47
processos encerrados naturalmente. **Workflow ainda não está no pacote r5.**

O r5, anterior ao workflow, passou a matriz de 151 capacidades: 93 checkpoints,
zero replay do provider, árvore, revisão, conclusão e cancelamento; 577 processos
encerrados naturalmente. Smoke/legado/RAG e CLI passaram (84 e 56 processos).
Evidências: `native-tools-r5-packaged-matrix/report.json`,
`native-tools-r5-package-compat/` e `native-tools-r5-packaged-cli/report.json`.
Pacote: `dist/electron-native-tools-r5-20261008/win-unpacked`; ASAR
`c41e975469dc6fb80d0adb3fe89c185ef2f666850391c12831d2fa8ebeb74b90`.
Não foi gerado/aplicado instalador r5; padrão legado e certificação global permanecem.

### Cancelamento e perda do transporte — fonte posterior ao r4, 2026-10-08

O pacote r4 foi rejeitado pela matriz: cancelar `ask_user` pendente era
classificado como efeito incerto. A correção usa o registro do Host para provar
que `ask_user`/`decision_gate` foram fechados sem resposta; não confia no texto
da ferramenta nem estende a exceção a outras mutações. O fluxo Electron passou
perguntas, decisão, aprovação, revisão, cancelamento, `self_review`, conclusão
de tarefa e restart: 12 checkpoints recuperados, zero replay do provider.
Evidência: `native-cancel-proof-http/report.json`, 82 processos naturais.

O projetor também conserva o bloqueio de efeitos iniciados quando o stream
termina ou falha antes do terminal. Resultados ainda sem recibo não liberam
autoridade de escrita. O filesystem legado preserva `outcome_unknown` e trata
filhos interrompidos por restart como incertos durante a reconciliação.
Passaram 212 testes em 18 arquivos, typecheck e os dois cenários físicos de
escrita com ACK incerto. Ledgers `native-stream-seal-unit-r2-processes`,
`native-stream-seal-typecheck-processes`, `native-stream-seal-physical-processes`:
24, 2 e 21 processos naturais, todos os Jobs vazios. Uma primeira execução
dos cinco testes novos falhou por faltar `providerStarted` no fixture; corrigido.
O r4 não contém essas correções e não é candidato aprovado para instalação.

Recuperação medida com o runtime atual sobre o mesmo journal sintético imutável:
100 checkpoints em 18–25 ms, 1.000 em 110–115 ms e 10.000 em 1.050–1.053 ms
(duas amostras de cada). Para 10.000, foram lidos 18 payloads/1,32 MB; os bytes
recuperados coincidem com o hash confirmado no journal. A amostra antiga do
mesmo fixture registrou 319.100 ms. Cache do SO não foi controlado; isto não
mede 10.000 turnos reais de provider nem latência total do aplicativo.
Evidência: `native-tools-current-frontier/report.json`, 3 processos naturais.

### Revisão, conclusão de tarefas e efeitos incertos — fonte 2026-10-08

`self_review` passou pelo chat HTTP/SSE, worker e Electron: revisão não
configurada, revisão com achado persistido e cancelamento durante o provider.
Após restart, os três registros e o comentário permaneceram sem duplicação ou
replay. Evidência: `native-self-review-http/report.json` (46 processos naturais).

`task_complete` agora usa estado atribuído à chamada nativa, confirma a tarefa
ativa e publica um único `task_finished` após commit. O escopo aprovado entra na
política de escrita; inclui destinos de renomeação do patch e é vinculado à
autorização. O teste físico recusou duas escritas fora do escopo, recusou concluir
outra tarefa, confirmou a escrita permitida e reabriu a sessão concluída.
`native-task-complete-http/report.json`: sete checkpoints, zero replay, 56
processos naturais; também repetiu a revisão. Passaram 173 testes e typecheck.
O escopo de arquivos não transforma comandos arbitrários em sandbox de SO.

Uma correção posterior impede retries de efeitos incertos: o resultado tipado
atravessa o runtime, os filhos, `spawn_agent`, tarefas e workflows. Repetir
`retry_failed` ou selecionar explicitamente um filho não concede permissão para
reexecutar uma mutação sem confirmação. A retomada preserva esse estado em disco;
falhas transitórias conhecidas continuam usando backoff cancelável. A política
reconhece checkpoints antigos que codificavam `outcome_unknown` no erro.
Passaram 182 testes em 15 arquivos e typecheck. Dois testes com Rust real
aplicaram uma escrita com ACK incerto, impediram o próximo turno e mantiveram
o lease do workspace: `native-uncertainty-physical-report.json`, 21 processos
naturais, Job vazio. Regressão ampla: 3.065 testes em 362 arquivos passaram
(`native-uncertainty-wide-processes`, 547 processos naturais). Novo build passou
(`native-uncertainty-build-processes`, 69 processos naturais).
Essas mudanças ainda não estão no pacote r3 abaixo.

### Pacote com árvore confirmado — 2026-10-08

O pacote `electron-native-tree-r3-20261008` passou a matriz física completa,
incluindo preview Electron, browser, databases, MCP, scripts e árvore de filhos:
89 checkpoints recuperados, zero chamadas repetidas ao provider e duas
transcrições de filhos recuperadas após restart. A matriz encerrou naturalmente
552 processos registrados. Smoke + compatibilidade legado/worktree + RAG
encerraram 84 processos; a CLI encerrou 56. Os Jobs ficaram vazios.
ASAR: `e8bf01433f65463341d7aea37b397d4768ec4b3b0dad6660163adc20b3450c80`.
Evidência: `scratch/harness-20261003/native-tree-r3-packaged-matrix-r2/report.json`.
A primeira tentativa de matriz falhou porque o teste de descoberta ainda
tratava `spawn_agent` como ausente; passou a verificar um nome deliberadamente
não registrado. A capacidade ausente continua sendo rejeitada pelo snapshot.

A fonte posterior integra `self_review` com sessão e workspace conferidos,
persistência aguardada, consultas internas autorizadas pelo gateway e
cancelamento propagado ao provider. Perda de propriedade descarta resultados
tardios. Passaram 173 testes focados, typecheck, build e o fluxo físico de
revisão, cancelamento e restart descrito acima. Esse código ainda não está
no pacote r3. `record_memo`, já verificado dentro dos filhos, passou a ser
contado explicitamente como capacidade contextual, sem exposição ao pai.
O padrão continua legado; nenhum instalador novo foi aplicado ao PC.

### Árvore pela interface e orçamento agregado — fonte 2026-10-08

O catálogo de desenvolvimento inclui `spawn_agent`, `resume_agent`,
`request_review` e `read_agent_transcript`. O worker deriva concorrência e
profundidade da política da sessão, com tetos de 8 filhos simultâneos,
32 níveis e 64 admissões na árvore. Providers, permissões e limites de turnos
continuam herdados; o runtime padrão do aplicativo continua legado.

`NativeTreeResources` reserva a soma dos limites físicos dos Jobs antes do
lançamento: por padrão 8 GiB de memória comprometida e 256 processos na árvore.
O bridge anuncia os mesmos limites usados pelo Windows; supervisor/runner,
comandos, terminais, LSP e SQLite do worker entram na conta. Um grupo só devolve
capacidade com reap confirmado. Serviços compartilhados no main, incluindo
Electron preview e conexões MCP, mantêm seus próprios limites e não estão
incluídos nessa soma; ela não é um limite de RSS do aplicativo inteiro.

O teste empacotado anterior encontrou uma falha real: a sanitização tratava os
UUIDs de `nativeTranscriptRef` como segredos. Apenas o formato exato de quatro
UUIDs passou a ser preservado; outros valores continuam redigidos. O pacote
`electron-native-tree-r2-20261008` passou criação, memo, retomada, revisão e
leitura em processo novo: cinco ativações, duas referências recuperadas,
escrita preservada e 24 processos encerrados naturalmente. ASAR:
`19a876015f877b5410d0a6e26b9698af082f6d713d842a130ca5c364c9d738e3`.
Esse pacote antecede o catálogo 148 e o orçamento agregado.

A leitura de auditoria agora sobrevive ao TTL de retomada e à evicção do
cache. Não renova a validade do checkpoint nem concede lease para executar.
O inventário retorna os oito grupos mais recentes; IDs antigos continuam
endereçáveis até excluir a sessão. A gravação deixou de reler e excluir todos
os grupos além do limite da RAM, preservando os endereços dos journals.

Validação da fonte atual: **339 testes / 26 arquivos**, incluindo 17 cenários
físicos (`native-tree-resources-final-processes`, 178 PIDs), build integrado
(`native-tree-resources-build-processes`, 72 PIDs) e **3.031 testes amplos /
362 arquivos** (`native-tree-resources-wide-processes`, 547 PIDs). Todos esses
processos encerraram naturalmente. Rust bridge: 18 testes passaram; a contenção
do executor encerrou um processo remanescente da compilação e confirmou o Job
vazio (`native-tree-resources-rust-processes`, 51 PIDs; `forcedCleanupCount=1`).

`native-tree-http/report.json` valida o HTTP/SSE, worker e Electron reais,
com provider local determinístico: cinco attempts Rust na mesma árvore,
retomada sem repetir a escrita, oito eventos de progresso e leitura de duas
transcrições antes/depois do restart. O restart recuperou oito checkpoints sem
chamar o provider novamente. Os 51 processos encerraram naturalmente.
O teste foi executado sobre o build sem empacotar; a matriz empacotada posterior
r3 está descrita acima. Nenhuma instalação ou configuração do usuário foi alterada.

### Árvore nativa: revisão, memórias, progresso e leitura fria — fonte 2026-10-08

`request_review` usa a porta da árvore Rust e o provider configurado para revisão.
Resposta interrompida ou não interpretável não confirma revisão. A resolução dos
providers dos filhos ocorre sob demanda; a configuração “herdar do pai” não é
mais substituída pelo provider legado padrão. Resultados estruturados chegam à
projeção da interface com limite de 64 KiB, profundidade e quantidade de nós;
metadados opcionais excessivos são omitidos sem transformar uma mutação já
concluída em erro repetível.

Cada filho recebe `record_memo` como resultado puro. O coletor incorpora a nota
somente após publicar o resultado confirmado no journal, sem conceder escrita
no workspace a um explorador. Eventos de grupo e progresso atravessam as
fronteiras de netos, preservando o identificador usado para cancelar e ler o
histórico. Conteúdo privado das ferramentas dos filhos não é encaminhado como
eventos do pai.

A consulta HTTP de transcrição recria o worker após sua evicção, sem iniciar
modelo ou retomada. O main resolve a referência pela árvore durável da sessão;
validação e renderização do journal permanecem no worker. A leitura funciona
sem configuração de execução ativa e recusa workers substituídos e outra sessão.
`apply_patch` agora verifica todos os caminhos, inclusive origem/destino de
renomeações, antes do primeiro efeito. `exec_command` registra violações de cwd e
comando; isso continua sendo aviso e não um sandbox de comandos arbitrários.

Validação: 178 testes em 20 arquivos, incluindo 16 cenários físicos Windows
(`native-tree-scoped-patch-r2-processes`, 170 PIDs); typecheck anterior da leitura
fria passou (`native-tree-cold-history-typecheck-processes`, 2 PIDs). Build
integrado e 3.013 testes amplos em 360 arquivos passaram
(`native-tree-cold-build-processes`, 72 PIDs; `native-tree-cold-wide-processes`,
545 PIDs). Todos encerraram naturalmente. A primeira rodada do patch falhou
somente na expectativa de newline do fixture; o bloqueio integral já funcionava.
Providers são determinísticos. Prova desta árvore dentro do pacote está em
andamento; nenhum destes números comprova ativação de todas as superfícies,
qualidade de provider real ou atualização da instalação.

### Preparação da retomada e Git assíncrono — pacote e instalador 144 verificados

Uma nova mensagem não reconstrói mais checkpoints antigos para procurar efeitos
incertos. Na retomada, a reconstrução começa no último checkpoint completo da
attempt anterior; a checagem de efeitos continua lendo todos os eventos de
lifecycle. Cancelamento, resultado incerto antigo e histórico divergente não
são ignorados pela otimização.

`native-continuation-comparison/report.json` compara o JavaScript anterior com
a fonte corrigida sobre os mesmos recibos sintéticos em memória. Em 100 / 1.000 /
10.000 checkpoints, a preparação de novo comando passou de 20,4 / 1.376,8 /
160.762,5 ms para 2,4 / 19,7 / 177,3 ms. A retomada passou de 16,5 / 1.330,9 /
150.701,8 ms para 4,8 / 66,7 / 774,5 ms, com provas de contexto iguais. Em 10.000,
o candidato leu 32 payloads de checkpoint na retomada, contra 10.000 antes;
novo comando não leu nenhum. A fotografia nativa, disco, provider e execução
completa de turnos não fazem parte desse benchmark. Os limites existentes de
65.536 registros por scan e 100.000 no reader não foram elevados.

`enter_worktree`, `exit_worktree` e a criação inicial no legado agora usam Git
assíncrono pela porta de processos, com sinal, timeout e saída limitada.
Status ilegível impede remoção; nomes reservados, caminhos externos e valores
não booleanos de descarte são rejeitados. ACK de mutação perdido preserva o
diretório e retorna resultado incerto. Falha de criação/persistência termina a
preparação pelo encerramento normal da sessão; não inicia o modelo na pasta
principal. A troca de workspace durante uma attempt Rust continua pendente.

Build, 31 testes focados de retomada, 31 testes de Git/worktree, nove cenários
físicos Windows de retomada/worktree e 2.859 testes amplos em 341 arquivos
passaram. Ledgers: `continuation-worktree-build-r2-processes` (69),
`continuation-worktree-physical-processes` (181), `continuation-worktree-wide-processes`
(526), `worktree-async-tests-r3-processes` (126); todos encerrados sem força.
O pacote `dist/electron-continuation-worktree-20261008/win-unpacked` passou a
matriz completa (84 checkpoints recuperados, zero chamadas ao provider repetidas),
smoke, legado, RAG e os cinco cenários CLI. A compatibilidade inclui criação de
worktree, retomada no diretório persistido e recusa de projeto inválido antes
de chamar o provider. Os 532 + 84 + 56 processos encerraram sem limpeza forçada.
O cancelamento CLI exercita o handler SIGINT disparado por IPC no Windows.

Fonte congelada: `scratch/harness-candidates/2026-10-08T15-27-53-303Z/manifest.json`.
ASAR SHA-256: `208c84c36a77e1f314ce813e62664f3ddf0711c27df5d1bfbaedd1d043faf596`.
Instalador: `dist/electron-harness-continuation-installer-20261008/CodeStudio-Harness-Continuation-2026-10-08.exe`;
321.838.098 bytes, SHA-256 `4e1deccdb8056f88fa263ea09754a34e52fcf395b983152d134979077a1a610a`.
Seus 4.935 arquivos foram extraídos e comparados com o pacote testado.
Evidências: `continuation-worktree-packaged/report.json`,
`continuation-worktree-package-compat/`, `continuation-worktree-packaged-cli/report.json`
e `continuation-worktree-installer-verification.json`, sob `scratch/harness-20261003/`.
Nada foi instalado; padrão legado, 103 ferramentas pendentes e gates globais abertos.

### Índice do journal, bootstrap SQLite e worktrees — pacote e instalador verificados

O journal Rust mantém uma sequência de recibos e um índice ID → posição; a
read view reutiliza ambos sem recriar o índice e ordenar todos os recibos.
Recibos, hashes, autoridade, cancelamento de snapshots e regras de replay não
mudaram. O teste físico de 100.000 registros passou, incluindo UUIDs em ordem
inversa, paginação, leituras exatas e replay após reabertura. Em build debug:
133.525,7 ms de append, 14.115,8 ms para abrir o reader, 461,2 ms para percorrer
as páginas e 12.079,2 ms para reabrir o writer. São registros sintéticos em
disco, não turnos de modelo; houve outros trabalhos locais durante a medição.
Limites existentes não foram elevados. Ledger `native-record-index-scale-processes`:
quatro processos, todos encerrados naturalmente. A amostra de memória coletada
durante a execução não mede o pico completo nem constitui comparação antes/depois.

O trace do pacote anterior atribuiu uma tarefa de 920,6 ms no main à criação de
um banco de projeto pela fixture. Não demonstra a causa do frame antigo de
8.759 ms. O bootstrap SQLite agora agrupa a criação inicial em uma transação,
sem alterar transações/PRAGMAs das migrações. A comparação pareada em arquivos
novos, WAL/FULL e ordem alternada mostrou mediana de 39,6 → 5,7 ms em nove
amostras de cada variante, com esquema idêntico e integrity_check aprovado.
Não mede startup completo. Relatório `schema-bootstrap-comparison.json`.
Os 18 testes de bootstrap/migração/trim/handle passaram, incluindo rollback e
preservação de dados; 33 testes de Git/worktree passaram. Legado e nativo agora
validam cada ancestral antes de criar subpastas: uma junction externa em
`.mcp-indexer` não cria `worktrees` fora do projeto.

Essas três alterações são posteriores ao instalador acima. Clippy do workspace
passou com warnings negados; 704 testes Rust, build, 2.864 testes amplos e nove
cenários físicos Windows passaram. Os 17 testes Rust ignorados não são contados
como aprovados; o benchmark de 100 mil registros foi executado separadamente.
O build gerou `runtime-v1-3c8c3f1108c618c49f814d785707822404298cfb467bef116d09b8ea7b613a09`,
manifesto `25b6391c740893f4aa73df30fd3235c95a8ed93bc4ff389472afe78d6c002843`.

Pacote `dist/electron-compact-journal-schema-20261008/win-unpacked`: matriz de
84 checkpoints/zero replay, smoke, legado com worktree, RAG e cinco cenários CLI
passaram; 532 + 84 + 56 processos encerrados naturalmente. Fonte congelada em
`scratch/harness-candidates/2026-10-08T16-12-01-617Z/manifest.json`; ASAR SHA-256
`5327837ebede75d0876d22b739d3a8cb31b8eebdd5737c381addb9146453d842`.
Instalador `dist/electron-harness-journal-installer-20261008/CodeStudio-Harness-Journal-2026-10-08.exe`:
321.834.718 bytes; SHA-256 `d37b170f3e0eb380f4baa78ecabb970384ba78373840bbaf222ea41f9db8136b`.
Os 4.935 arquivos extraídos correspondem ao pacote; instalador não executado.
Relatório `compact-journal-schema-installer-verification.json`.
As medições atualizadas passaram: startup do runner aquecido p95 20,162 ms
(100 amostras), executor de leitura p95 0,234 ms (1.000 amostras) e ACK de
cancelamento p95 1,023 ms (50 amostras após cinco warmups). Startup mede spawn
até AttemptPrepared; dispatch exclui IPC/política/journal; cancelamento usa
attempts ociosas. Não são métricas de startup Electron ou latência de provider.
Relatórios `compact-journal-{startup,dispatch,cancel}-perf.json`.
Ledgers de performance: 129 + 11 + 225 processos, todos encerrados naturalmente.
O trace ainda registra uma tarefa de 775,4 ms no main durante uma abertura de
CodeIndexDB pela fixture; o benchmark isolado de bootstrap não prova que esse
bloqueio completo ou o frame histórico de 8.759 ms foram eliminados.
Nada foi promovido ao runtime padrão.

### Transcrições e fronteira de subagentes — fonte posterior ao pacote do journal

A ferramenta e a aba de transcrição usam leitura de arquivo assíncrona, com
cancelamento e limite de 64 MiB antes de alocar/parsear. A renderização mantém
um buffer de saída limitado e cede ao event loop por tempo/quantidade; valores
NaN/Infinity, metadados grandes e fallback do relatório final também respeitam
o teto. Excertos de argumentos/resultados não serializam ou normalizam toda a
parte que seria descartada. JSON.parse continua síncrono dentro do limite;
isso não promete latência constante na recuperação de um arquivo grande.

O contexto preparado marca a geração Rust e o ponto central `runSubagent`
exige uma porta `AgentTreePort` vinculada ao owner. Sua ausência rejeita a
chamada antes de criar um runner legado; um pai legado também não pode usar
essa porta nativa. Esta é a fronteira de integração, não o executor da árvore:
admissão durável dos filhos, orçamento compartilhado, leases, cancelamento e
recovery da árvore ainda precisam ser conectados. Nenhuma ferramenta foi
habilitada por esse contrato. 37 testes focados, typecheck e build passaram
(73 processos encerrados naturalmente). A regressão passou 2.878 testes,
mas o comando terminou em erro porque referências de linhas no inventário
precisavam ser regeneradas; isso foi corrigido e será revalidado junto da
admissão da árvore. A validação empacotada desta fonte posterior ainda está pendente.

### Autoridade e consumo da árvore — fonte posterior em implementação

`FileControlPlaneStore.admitNativeChild` reserva identidade e vaga em uma única
gravação antes de criar as projeções run/attempt. Repetição ou ACK perdido retorna
`existing`, que não autoriza relançamento. Quantidade/profundidade/prazo vêm da
preparação selada da raiz; cancelamento, ancestral encerrado, geração ou build
divergente recusam trabalho. Encerrar um filho não encerra o comando da raiz;
cancelamento e recibos de cleanup continuam possíveis após cancelar o pai.

O grupo de leases bloqueia novas mutações do pai antes de aguardar efeitos em
andamento. As reservas filhas mantêm as autoridades do perfil e compartilhada;
leitores compatíveis coexistem, escritores conflitantes não. Expiração não
libera uma reserva delegada: o pai precisa da prova de reap dos descendentes
antes de escrever ou liberar o workspace. Isso inclui o caso de restart.

`NativeRunTreeBudget` compartilha contadores monotônicos de chamadas ao provider
e ferramentas, incluindo chamadas internas a scripts. A admissão do provider
acontece após persistir a fronteira e antes de abrir a conexão. Checkpoint sem
provider não consome turno. O executor de Coder já usa esse contador com uma
única raiz; o coordenador inteiro não foi habilitado. Após perder o coordenador,
o recibo da admissão exige reconciliação, não recriação dos mesmos filhos com
contadores zerados. Orçamento agregado de recursos, execução das árvores,
portas de aplicação por filho e recovery completo permanecem pendentes.

104 testes em 11 arquivos e typecheck passaram: burst concorrente, ACK perdido,
disco cheio, projeção parcial, cancelamento, tarefa/modelo selados, delegação de
workspace, consumo global, roteamento por filho e espera por efeitos sem aguardar
a própria chamada de spawn. Ledger `native-tree-quiescence-tests-processes`:
17 processos encerrados naturalmente. O build anterior passou com 72 processos;
2.888 testes amplos passaram, e a verificação do inventário passou após regenerar
a linha de uma definição MCP alterada em outro trabalho. Nenhuma ferramenta nova
foi habilitada. A fonte seguinte ainda requer novo build/regressão.

### Executor completo de pai e filho — fonte posterior, 2026-10-08

`NativeCoderTreeOwner` compõe `executeNativeCoder` e a fachada para os filhos,
com consumo compartilhado, limite de processos simultâneos, journal separado,
resultado limitado e reserva delegada do workspace. O pai bloqueia suas mutações
enquanto houver descendentes e aguarda o encerramento deles antes de liberar
suas próprias autoridades. Repetição de admissão não relança um filho. Falha
anterior ao lançamento encerra a reserva lógica sem criar processo.

Os três cenários físicos passaram: conclusão com escrita real, cancelamento de
pai e filho e falha de preparação. O teste encontrou e corrigiu uma segunda
checagem que impedia cancelar um filho após persistir o cancelamento da raiz.
Cleanup agora verifica a identidade exata sem exigir autorização para novas
ações; lançamento e ferramentas continuam exigindo autoridade ativa.
Relatório `native-coder-tree-report.json`; ledger
`native-coder-tree-physical-r2-processes`: 25 processos, todos encerrados
naturalmente, com workspace devolvido nos três casos. Provider determinístico;
não mede provider real nem certifica o fluxo de `spawn_agent`.

As portas de preview, browser, memória, exportação, indexação e leituras resolvem
o filho pelo recibo durável da raiz, mantendo o projeto do host. Recibos de
mutação usam a tentativa além do ID de ferramenta, permitindo IDs iguais em
filhos distintos sem trocar resultados. Cancelamento/drain também alcançam
requisições ainda aguardando a consulta de autoridade; encerrar um irmão não
reabre outro. 58 testes em dez arquivos passaram, além do typecheck; ledger
`native-child-apps-tests-r2-processes`: 14 processos encerrados naturalmente.

O build da composição passou (`native-coder-tree-build-processes`, 72 PIDs),
assim como 2.939 testes amplos (`native-coder-tree-wide-processes`, 537 PIDs).
Todos encerraram naturalmente. A fonte posterior resolveu o diretório do journal
filho no recovery, com rejeição de junctions antes de criar arquivos: 12 testes,
incluindo três físicos, passaram (`native-coder-tree-recovery-r2-processes`, 27 PIDs).

### Adapter de subagentes e aprovações roteadas — fonte posterior, 2026-10-08

`AgentTreePort` agora prepara filhos com o catálogo selado do pai, filtro de
perfil, limites herdados, provider configurado e contexto com portas próprias.
Não admite uma implementação de ferramenta fornecida pelo chamador fora do
catálogo. Documentos são materializados antes da admissão para manter o hash da
tarefa estável. O resultado contém resumo limitado e referência ao journal;
não devolve a transcrição inteira. O cancelamento do chamador alcança o filho e
aguarda seus processos e efeitos, preservando o pai.

As perguntas e aprovações recebem identidades por tentativa e são roteadas até
a fachada do filho. A resposta fica no ledger durável desse filho; repetição de
ACK não repete a escrita. IDs iguais entre irmãos não compartilham respostas.
16 testes de interação e execução passaram (`native-tree-interactions-r2-processes`,
43 PIDs). A rodada seguinte passou 21 testes, incluindo sete cenários físicos
e o adapter real (`native-tree-adapter-processes`, 61 PIDs), além do typecheck.
Todos os processos encerraram naturalmente. Providers são determinísticos.

`spawn_agent` e `read_agent_transcript` passaram pelo Host com o pai e filho
em Rust. Eventos de grupo alcançam o barramento da interface. A consulta devolve
um digest de até 60.000 caracteres, validando uma fotografia do journal e cedendo
tempo ao event loop durante o replay. Retenção armazena uma referência opaca
incluindo a tentativa raiz. O Host resolve a reserva original sem scan global,
verifica sessão/ator/terminal e restringe filhos à própria descendência. Uma
nova execução da mesma sessão pode consultar o histórico; isso não autoriza
reaproveitar o executor ou repetir uma mutação do filho anterior.

37 testes passaram, incluindo oito cenários físicos e a reabertura/troca de
raiz no control plane (`native-tree-durable-refs-processes`, 71 PIDs). Build e
2.952 testes amplos passaram (`native-tree-adapter-build-processes`, 72 PIDs;
`native-tree-adapter-wide-processes`, 540 PIDs); inventário verificado. A fonte
seguinte conectou a ponte do endpoint da interface à leitura nativa no worker,
inclusive durante o linger após o pai terminar. O processo principal só valida
a autoridade; leitores simultâneos limitados a dois. 37 testes e typecheck
passaram (`native-tree-ui-history-processes`, 71 PIDs;
`native-tree-ui-history-typecheck-processes`, 2 PIDs). O teste físico também
recusa a consulta quando o worker perde o vínculo. Nenhum processo foi morto
à força; todos os ledgers confirmaram árvore vazia.

### Retomada dos filhos — fonte posterior, 2026-10-08

`resume_agent` usa a referência nativa retida para abrir uma fotografia validada
do journal. Recupera o último checkpoint completo, seus deltas e texto confirmado;
recusa efeitos incertos, efeitos ausentes do checkpoint, troca de provider/modelo
e filhos já concluídos. A nova execução tem identidade e journal próprios,
preserva o resultado das ferramentas e recebe a orientação explícita da retomada.
Somente os anexos referidos pelo contexto são carregados, conferidos e copiados
para o novo journal, com limites de bytes e zeroização ao encerrar.

A origem recebe uma reserva durável de consumidor único antes da admissão do
sucessor. Perda de ACK ou falha posterior não torna o checkpoint anterior
reutilizável por outra tentativa. O fluxo em paralelo passou a propagar as
referências nativas, e os eventos da retomada usam a porta da árvore.

76 testes em 11 arquivos passaram, incluindo dez cenários físicos e a retomada
com imagem e escrita real sem repetição (`native-child-resume-r3-processes`,
99 PIDs). Typecheck passou (`native-child-resume-typecheck-r3-processes`, 2 PIDs).
Todos encerraram naturalmente. A primeira reprodução revelou que o fixture não
respondia à aprovação administrativa de `resume_agent`; o teste passou a
responder pelo contrato da fachada, mantendo a permissão da ferramenta.
Providers continuam determinísticos, sem comprovação de qualidade/custo real.

O adapter passou a ordenar filhos escritores e permitir a sobreposição de
leitores adjacentes, com fila FIFO cancelável e limitada. Uma escrita na fila
impede ultrapassagem por novas leituras. Cada posição de um lote recebe uma
chave de admissão própria, corrigindo a colisão entre filhos com o mesmo grupo.
Os resultados paralelos preservam as referências distintas dos journals.
81 testes em 12 arquivos passaram, incluindo 12 cenários físicos: dois leitores
simultâneos, dois escritores sequenciais e devolução do workspace
(`native-tree-scheduling-processes`, 124 PIDs, todos encerrados naturalmente).

Ainda faltam orçamento agregado de recursos e prova empacotada da árvore.
A UI após evicção total recria um worker para leitura, conforme validação acima.
O catálogo de produto continua 144 habilitados / 103
pendentes; spawn, retomada, revisão e consulta estão habilitados apenas na composição interna de
teste. O último instalador não contém estas alterações e não foi instalado.

### Preparação MCP e indexação vinculada ao projeto — fonte 144, 2026-10-08

O catálogo fixo das 33 ferramentas internas é gerado e conferido no build.
Preparar uma sessão não abre mais um processo apenas para descobrir esquemas;
a primeira chamada remota abre uma conexão compartilhada, valida o catálogo
real e o encerramento da sessão fecha o processo. MCP externo mantém descoberta
dinâmica. O teste físico `lazy-mcp-physical/report.json` mediu 4,4 ms para
catálogo sem processo, 2.144,6 ms para abertura fria com duas chamadas concorrentes
e 0,8 ms na leitura aquecida. São amostras locais; o custo frio foi adiado apenas
nas sessões que precisam do servidor. Consultas locais não pagam esse custo.
Também foram substituídas três listagens integrais por `countFiles()` no
coordenador semântico. 98 testes focados, 2.805 amplos e build passaram.
`lazy-mcp-gui/report.json` passou com modelos, agentes, cancelamento e restart;
48 processos encerraram, sem limpeza forçada.

`mcp__index_project` agora usa uma porta da aplicação da sessão, com projeto e
workspace validados, permissão administrativa, operação vinculada e recibos
retidos até o encerramento. O cancelamento interrompe a espera e impede a
próxima etapa semântica. No MCP público, as três requisições propagam o sinal;
ACK perdido é transportado como resultado incerto, sem sugerir repetição.
Não cria projeto externo pela porta nativa nem procura outro owner TCP.

182 testes focados e 2.824 testes amplos em 337 arquivos passaram, junto do build,
inventário e gate de tamanho dos módulos. O fluxo físico
`native-index-mutation-physical/report.json` passou: aprovação dentro de script,
indexação real, cancelamento antes do efeito (ACK em 18,7 ms nesta amostra),
ACK perdido após um efeito e retomada sem repetir a operação incerta. Os 47
processos físicos, 70 do build e 426 da regressão ampla encerraram.

O pacote `dist/electron-native-index-mutation-20261008/win-unpacked` passou a
matriz completa: 84 checkpoints recuperados e nenhuma chamada ao provider
repetida. Cancelamento antes da indexação produziu zero efeitos; ACK perdido
após um efeito bloqueou repetição, inclusive após restart. Smoke, legado,
RAG e cinco cenários CLI passaram. Os 531 + 51 + 56 processos dessas três
execuções encerraram naturalmente. A descoberta MCP no ASAR levou 4,5 ms
sem abrir processo; primeira chamada remota: 1.790,5 ms; aquecida: 0,7 ms.
Essas medidas são amostras locais, não gates p95.

Fonte congelada: `scratch/harness-candidates/2026-10-08T14-37-46-573Z/manifest.json`.
ASAR SHA-256: `8fdcd5457654a11bfe8ddb069c5cdf6bc03d8d7ce0e019c7759d12a81ab008db`.
Evidências: `native-index-mutation-packaged/report.json`,
`native-index-mutation-package-compat/`, `native-index-mutation-packaged-cli/report.json`
e `native-index-mutation-packaged-mcp/report.json`, sob `scratch/harness-20261003/`.
O último instalador conferido permanece 143, não instalado. A otimização
posterior da preparação de retomada ainda não está nesse pacote 144.

### Pacote e instalador 143 verificados — 2026-10-08

`dist/electron-semantic-project-pages-20261008/win-unpacked` passou a matriz
física completa: 81 checkpoints recuperados, zero chamadas ao provider repetidas,
consultas de agentes antes/depois de restart e recusa de acesso a outro projeto.
As quatro consultas sobre 10.000 jobs levaram 49,1 ms nesta amostra, sem
`listJobs()` no main; maior intervalo do timer: 21,4 ms. Smoke, legado, RAG e
os cinco cenários CLI também passaram. Os ledgers registram 597 + 60 + 64
processos encerrados, sem cleanup forçado. Essas amostras não comprovam p95.

O instalador `dist/electron-harness-jobs-installer-20261008/CodeStudio-Harness-Jobs-2026-10-08.exe`
foi extraído e seus 4.935 arquivos comparados por SHA-256 com o pacote testado.
Tamanho: 321.864.800 bytes; SHA-256:
`59355b0e8a7275bcc148a60cec09e3033a7e33cf087fc29b9b590fab686dfa63`.
Não foi executado nem instalado. Fonte congelada:
`scratch/harness-candidates/2026-10-08T13-45-58-847Z/manifest.json`.
Evidências em `scratch/harness-20261003/semantic-project-pages-packaged/report.json`,
`semantic-project-pages-package-compat/`, `semantic-project-pages-packaged-cli/report.json`
e `semantic-project-pages-installer-verification.json`. O padrão permanece legado;
104 ferramentas e os gates globais continuam pendentes. A preparação MCP sob
demanda é fonte posterior, ainda em validação, e não está neste instalador.

### Consultas de indexação fora do main — fonte 143 posterior, 2026-10-08

As rotas de resumo, status, histórico e retomada de jobs ainda usavam
`listJobs()` síncrono no Electron main. Agora consultam o worker SQLite:
histórico com paginação por ID (100 padrão, máximo 200) e seleção independente
do job atual em SQL. Um job antigo em andamento não desaparece quando a página
recente contém apenas jobs concluídos. O resumo por projeto retorna uma linha,
sem hidratar os cursores de todo o histórico. O worker não tem fallback para
essa consulta no main.

58 testes focados e build passaram. A fixture física
`semantic-project-pages-physical/report.json` usou 10.000 jobs sintéticos:
duas páginas sem duplicação, status e resumo em 28,1 ms no total; zero chamadas
a `listJobs` no main e maior intervalo do timer de 13,6 ms. São amostras locais,
não p95 nem reprodução do congelamento histórico de 8,76 s. Sete consultas de
agentes também passaram antes/depois de restart, incluindo recusa de outro
projeto: cinco checkpoints, zero replay. Os 52 processos físicos, 68 do build
e 421 da regressão ampla encerraram. Os 2.801 testes em 332 arquivos e o
inventário passaram. Pacote desta fonte em preparação.

O pacote anterior de leituras de agentes passou os cinco cenários CLI, smoke,
chat legado e RAG (64 + 60 processos encerrados). A matriz parou por conflito
da fixture de leitura com uma raiz deliberadamente bloqueada por ACK perdido;
a segunda execução revelou falta de provider na sessão de controle da fixture.
O isolamento e a sessão foram corrigidos e comprovados no fluxo físico acima.
Nenhuma barreira de workspace foi removida. O pacote anterior não foi promovido
nem gerou instalador. Último instalador integralmente verificado: 138.

### Consultas de agentes e ciclo de vida — fonte 143, 2026-10-08

`mcp__list_agents`, `mcp__list_agent_runs`, `mcp__get_agent_run` e
`mcp__get_agent_result` usam uma porta vinculada ao worker, à execução e ao
projeto. A primeira reprodução física revelou que o antigo transporte interno
podia consultar outro CodeStudio na porta TCP configurada. A porta nova usa a
mesma aplicação, sem descoberta TCP ou fallback stdio. Filtra projeto e perfil
antes de carregar histórico; consultas têm cancelamento, prazo de 10 s, limite
de 8 MiB, IDs validados e leitura atualizada em consultas repetidas. Listagens
usam metadados e até quatro hidratações simultâneas.

178 testes focados, build final e fluxo físico passaram. Em
`native-agent-reads-physical-r2/report.json`, seis consultas foram verificadas
antes e depois do restart, com cinco checkpoints e zero replay. Os 52 processos
encerraram. A regressão executou 2.743 testes em 328 arquivos, todos aprovados;
o comando terminou com erro apenas pelo inventário desatualizado, regenerado e
validado separadamente. Os 417 processos da regressão, 68 do build e os processos
dos checks encerraram; 902 módulos seguem dentro do limite de LOC.

O pacote intermediário 139 r2 passou a matriz (79 checkpoints/zero replay), mas
falhou no RAG por prazo de admissão e na CLI por fechamento prematuro do banco.
Ele não está certificado. A fonte atual carrega o binding antes de iniciar o
relógio de autoridade e reserva a janela de admissão no prazo do supervisor.
47 testes focados passaram, incluindo atraso físico de 12 s e saltos do relógio.
O coordenador semântico agora aguarda suas tarefas e callbacks antes de liberar
o banco e rejeita trabalho novo após disposal; 69 testes passaram. A comprovação
dessas correções no pacote 143 está pendente. O último instalador integralmente
verificado continua sendo o 138; instalação, runtime padrão e gates globais
permanecem inalterados.

### Relógio e memória MCP — fonte 139, 2026-10-08

O primeiro pacote 139 falhou antes do provider em duas inicializações nativas
(`native-memory-save-packaged` e `native-memory-save-package-compat/direct-rag`):
EOF no canal de gestão; o outbox registra encerramento por desconexão do Host.
A mesma fonte sem empacotamento passou novamente em 101,8 s, com 64 processos
encerrados. A admissão física compartilhava o prazo de resposta de 2 s dos
comandos. O candidato seguinte separa essa espera (máximo 30 s, limitado pela
lease) dos comandos e do transporte (2 s). 47 testes focados e 522 testes Host
passaram. A comprovação no pacote corrigido está pendente; isso não é um ganho
de desempenho nem certifica startup p95. Nenhum desses testes alterou a instalação.

Os canais de gestão, controle, dados e persistência da attempt compartilham
o mesmo relógio monotônico. A abertura de endpoints e o cancelamento da lease
usam essa referência. Saltos posteriores no relógio de parede não estendem os
prazos nem tornam os frames futuros. Mudanças durante a criação de processos
continuam sujeitas à validação do peer; não foram ampliadas tolerâncias.
514 testes do Host e 12 testes focados passaram, incluindo dois cenários com
processos Rust e saltos simulados de +120 s e -120 s, quatro leituras, heartbeat
e encerramento automático. O relógio do Windows não foi modificado. LOC: 902
módulos dentro do limite. Os processos desses testes foram encerrados.

`mcp__save_memory` usa a porta de memória do Host, com projeto fixado pelo owner,
binding de banco, validação de metadados e confirmação individual. Não usa o
stdio como fallback nativo. O caminho público MCP compartilha a validação e
encaminha cancelamento à busca e à escrita. A deduplicação e persistência têm
uma fila limitada; oito escritas concorrentes da mesma memória produzem uma
única entrada. Atualizações preservam os arquivos referenciados. 193 testes
focados e build passaram. O fluxo físico `native-memory-save-physical/report.json`
passou em 79,44 s: gravação rica, merge, escopo, aprovação dentro de scripts,
cancelamento sem escrita, uma escrita com ACK perdido e nenhuma repetição após
restart. Sete checkpoints, zero replay; 64 processos encerrados. ACK de 19 ms
é uma amostra. Regressão ampla: 2.616 testes em 322 arquivos, inventário válido;
411 processos encerrados. Pacote 139 ainda em preparação.

### Exportação — pacote 138 aprovado, 2026-10-08

Fonte: `scratch/harness-candidates/2026-10-08T06-27-07-844Z`, manifest SHA-256
`49e3bcbf381c3f2cc8e40f4289170c10db7709d55a933d9300b5499062e1c41e`.
`native-export-packaged-r3/report.json` passou em 486,69 s com 76 checkpoints
e zero replay. Exportação com 601 símbolos, aprovação aninhada, cancelamento,
ACK perdido e retomada passou; ACK de cancelamento 46,9 ms é uma amostra.
562 processos encerrados sem cleanup forçado. CLI (cinco cenários), smoke,
legado e RAG também passaram: mais 64 e 60 processos encerrados.

Pacote: `dist/electron-native-export-r3-20261008/win-unpacked`; ASAR SHA-256
`591ded75bb33466e65785f2a8fc6419c7bce31f170348494d92a50934ab36b26`.
Instalador `dist/electron-harness-export-installer-20261008/CodeStudio-Harness-Export-2026-10-08.exe`,
321.905.560 bytes, SHA-256
`40818e304623dd9cddb17bdfd3f6f8174f8991dadd16096b3325fc008d6d2b3b`.
Todos os 4.935 arquivos extraídos coincidem com o pacote testado. O instalador
não foi executado e a instalação do usuário permanece intacta. Default legado;
nenhum gate de produção foi promovido.

### Exportação de documentação — fonte 138, 2026-10-08

`mcp__export_docs` usa uma porta de publicação do Host vinculada à attempt,
à identidade da chamada e ao projeto admitido. Nomes de projetos, IDs e caminhos
forjados nos argumentos não escolhem o destino. A autorização é revalidada antes
dos efeitos de filesystem. Respostas perdidas bloqueiam novas mutações; o Host
retém recibos limitados por quantidade e bytes e aguarda efeitos reais no drain.

O serviço compartilhado por MCP, HTTP e CLI agora lê páginas de 256 itens,
cede o event loop, respeita cancelamento e evita reler arquivos/símbolos para
cada seção. Mudança do índice durante a coleta exige nova leitura. Markdown
preserva todos os símbolos e assinaturas, escapa células e informa tags inválidas;
JSON respeita as seções selecionadas. Documentos acima de 32 MiB falham de forma
explícita antes de substituir o arquivo, com orientação para reduzir seções.
A gravação é assíncrona, em temporário exclusivo, com flush e rename no mesmo
diretório. O nome padrão não pode escapar da pasta de exportação.

148 testes focados em seis arquivos e build passaram. O fixture Electron
`native-export-physical/report.json` passou em 62,92 s: 601 símbolos, aprovação
nativa dentro de `code_exec`, cancelamento antes da publicação, escrita aplicada
uma única vez com ACK perdido, bloqueio da escrita seguinte e retomada após
reinício. Sete checkpoints recuperados sem replay; 59 processos encerrados sem
cleanup forçado. ACK de cancelamento de 59,2 ms é uma amostra, não p95.
A validação adicional do recurso selado e o cleanup após falha de close passaram
em 2.597 testes amplos (320 arquivos) e no build. A primeira matriz do pacote 138
detectou que a entrada pelo registro era rejeitada pelo novo fence de exportação;
não houve publicação nesse cenário. A correção admite somente a entrada dessa
ferramenta e sua operação de publicação. A regressão com autoridade real passou:
165 testes em sete arquivos. Reempacotamento e nova matriz passaram conforme acima.
Smoke/legado/RAG e cinco cenários CLI passaram no primeiro pacote, que não será
entregue com a falha. Os 272, 60 e 64 processos dessas verificações foram encerrados.

### Scripts e CLI — pacote 137 aprovado, 2026-10-08

Fonte congelada em `scratch/harness-candidates/2026-10-08T05-37-58-801Z`;
manifest SHA-256 `9057537e5ba99f714deec6d17774e4462ac25298b0e0498aebcbda24f77c4b17`.
O pacote `dist/electron-native-scripts-20261008/win-unpacked` passou a matriz
completa em 455,35 s: 72 checkpoints, zero replay e 534 processos encerrados
(`native-nested-packaged-r3/report.json`). CLI empacotada passou os cinco cenários
em 71,00 s, com 64 processos encerrados; smoke, legado e RAG direto passaram,
com outros 60 encerrados. Os testes usaram perfis/projetos e provider de fixture.

As duas primeiras matrizes falharam em uma leitura remota de estado durante
teardown do worker. A reprodução isolada passou. O teste agora pode repetir
apenas essa leitura quando o contexto do inspector é destruído; nenhuma ação é
repetida. A terceira matriz passou sem precisar desse retry. Isso não demonstra
que a instabilidade do inspector desapareceu; as falhas anteriores estão preservadas.

Instalador `dist/electron-harness-scripts-installer-20261008/CodeStudio-Harness-Scripts-2026-10-08.exe`:
321.903.692 bytes; SHA-256 `e1a0442521b9d0f59329a2bbd09ebd8aea200d7853d9ec40ea5092ba22c09efc`.
Todos os 4.935 arquivos extraídos foram comparados com o pacote testado
(`native-nested-installer-verification.json`). Geração/extracões/verificação:
9 + 2 + 2 + 2 processos encerrados. Instalador não executado; instalação do usuário
não substituída. Padrão legado, certificação de produção e gates globais continuam abertos.
ASAR: `08d4ea238a5cd70393f4e3215255db335beb19ecf30b86a2b62437ce4303d25c`.


### Especificações e retomada — pacote 136, 2026-10-08

`submit_spec` passa pela porta de interação da attempt, sem criar um runner legado.
O artefato usa criação exclusiva e nome único, preservando rascunhos submetidos no
mesmo segundo. A especificação continua bloqueando mutações até a aprovação
identificada e a gravação da mudança de modo. HTTP não produz resultado legado
quando perde o ACK ou o owner nativo. A interface envia a identidade exibida,
bloqueia cliques simultâneos e mantém o cartão aberto quando há erro.

A prova física detectou e corrigiu duas falhas de integração: a preparação
nativa não herdava `specMode` do agente efetivo, e a proteção de arquivos ainda
aceitava apenas o nome antigo do rascunho. A política agora usa o agente resolvido
mesmo com identidade de seleção customizada; o rascunho exige criação exclusiva,
nome com UUID e caminho estritamente dentro de `.mcp/specs`.

165 testes focados/8 arquivos e 2.540 testes amplos/312 arquivos passaram;
14 e 401 processos encerrados sem cleanup forçado. O fluxo físico em Electron
(`native-spec-output-physical-r4/report.json`) passou em 82,27 s: escrita bloqueada
antes da aprovação, rejeição, recusa do mesmo rascunho, nova versão preservando a
anterior, aprovação identificada, escrita permitida e leitura/escrita após
restart. Também confirmou recuperação de sete attempts sem replay. Seus 69
processos encerraram naturalmente. A prova separada da interface
(native-spec-ui-physical-r2/report.json) passou em 40,61 s: envio pelo composer,
rejeição, aprovação, erro de transporte exibido sem fechar o cartão, retry com
a mesma identidade e clique duplicado suprimido. Lembretes internos de aprovação
ficam fora do chat, inclusive após reload, e permanecem no contexto do provider;
imagens e saídas externas continuam visíveis. 27 testes de projeção passaram.
Seus 46 processos encerraram.
A retomada requer o opt-in Rust reativado explicitamente depois da leitura de
histórico com o flag desligado. Build completo e recomposição TypeScript passaram;
23 testes de recovery também passaram. O pacote final passou conforme abaixo.

A revisão encontrou ainda a ausência de `specMode` no contexto das chamadas
internas de `code_exec`. Um teste reproduziu a mutação sem aprovação; após a
correção, 66 testes de execução, concorrência e política passaram, sete processos
encerrados. Essa correção cobre o legado e não habilita `code_exec` em Rust.
Essas provas não certificam o catálogo inteiro nem promovem o runtime padrão.

O journal físico foi gravado até 10.000 checkpoints/20.000 mensagens. Após o
limite de 20 minutos, o Job encerrou os dois processos do primeiro ensaio; a
continuação validou 7.495 commits e gravou somente os restantes. Reconstrução
antiga: **319.099,68 ms**; abertura/validação: **1.207,96 ms**; paginação: **79,15 ms**.
Fonte otimizada sobre os mesmos dados imutáveis: **789,72 e 794,86 ms**, com
**18 leituras de payload**, abertura/validação **1.047,83 ms** e hash integral
recuperado igual ao checkpoint confirmado. Em 1.000 registros: 78–81 ms.
Relatórios: `provider-chunks-history-physical/report.json` e
`frontier-index-comparison/report.json`. Três processos da continuação e dois
da comparação encerraram naturalmente. As execuções foram separadas, com cache
do sistema operacional e carga do computador não controlados; não representam
p95 de produção nem 10.000 turnos reais do agente. O commit físico aquecido ainda
mediu mediana 183 ms e p95 exploratório 719 ms nos últimos 20 registros, incluindo
persistência em disco; esse custo continua a exigir investigação.

`code_exec` agora compartilha entre scripts do mesmo runner uma fila de até
quatro leituras explicitamente seguras. Escritas, comandos e classificações
desconhecidas aguardam leituras anteriores e bloqueiam as posteriores. Timeout
não libera o lugar antes de a chamada física terminar. Cancelamento remove a
espera, e uma barreira invalida o cache imediatamente para não reutilizar uma
leitura anterior à escrita. 63 testes focados passaram, seis processos encerrados.
Essa melhoria do legado não habilita `code_exec` no catálogo Rust.


Matriz `native-spec-packaged/report.json`: **429,68 s, 68 checkpoints, zero replay**,
509 processos encerrados sem cleanup forçado. Inclui o fluxo de especificações
pela API e pela interface, com retry, duplo clique e retomada. Smoke do ASAR,
legado e RAG direto passaram, com mais 60 processos encerrados. A CLI empacotada
não fazia parte desse candidato. Fonte congelada
`scratch/harness-candidates/2026-10-08T04-36-20-030Z`, manifesto SHA-256
`dbe33d7c6131feaedb06cd832b321a1adb1c0981c6a0fbee9da7f0b6bccc83f3`.
Pacote `dist/electron-native-spec-recovery-20261008/win-unpacked`, ASAR SHA-256
`e72e8cccfb3025c7139d68aaeb6f1eb3ccc5afa10c0e367c42f7ed9e3af8e44d`.
Instalador `dist/electron-harness-native-spec-installer-20261008/CodeStudio-Harness-Spec-Recovery-2026-10-08.exe`:
321.752.479 bytes, SHA-256 `d903d0ab412f6354cf6a545091e696c1edef970edf646f605ec64cf376576446`.
Todos os arquivos extraídos foram comparados por hash com o pacote testado
(`native-spec-installer-verification.json`). Não foi executado nem instalado.
A primeira tentativa de empacotar encontrou pnpm 11 no PATH; a segunda usou o
pnpm 10.22.0 já instalado, conforme `packageManager`, sem alterar o ambiente global.

### Scripts sob autoridade nativa — fonte 137, 2026-10-08

`code_exec` passa a usar o catálogo imutável da attempt, a política e a aprovação
nativa para cada chamada interna. Argumentos são copiados antes de qualquer
espera; quatro leituras podem se sobrepor, e escritas continuam como barreiras.
O limite da attempt inclui chamadas diretas e internas. Imagens/blocos retornados
pelas ferramentas são preservados na ordem de invocação. As mutações privadas de
goals e tasks continuam exigindo chamadas diretas, para manter sua identidade
de commit. Grants internos só são liberados após o ACK durável do resultado pai.
Um resultado incerto bloqueia as chamadas seguintes mesmo que o script capture
a exceção, e o drain acompanha cada operação física ainda viva.

213 testes focados/7 arquivos, build e 2.566 testes amplos/316 arquivos passaram;
13, 68 e 405 processos encerrados, sem cleanup forçado. Fluxo físico em Electron
passou em 57,02 s: cinco leituras, escrita/leitura, aprovação única e retomada,
com cinco checkpoints e zero replay. 49 processos encerrados. Prova de falhas `native-nested-fault-physical-r2/report.json` passou em 57,92 s: ACK de cancelamento em 27,6 ms (uma amostra), zero sockets vivos, POST aplicado uma vez com ACK perdido, escrita posterior bloqueada e retomada incerta recusada antes/depois de restart. Sete checkpoints sem replay; 59 processos encerrados. O primeiro ensaio confirmou a retenção do lease no workspace incerto; a repetição separou as raízes por falha. Pacote em preparação.
Essa admissão eleva o catálogo de desenvolvimento a 137 / 110, sem trocar o padrão.

### Fonte posterior: resultado incerto e CLI distribuída

Quatro regressões reproduzidas em `code_exec` corrigidas: timeout de mutação,
erro capturado pelo script, resultado explicitamente incerto sem ledger fornecido
e cancelamento após despacho. A incerteza permanece na attempt, bloqueia chamadas
posteriores e nunca sugere retry automático. Uma chamada que expira enquanto
aguarda a fila, sem ser despachada, não recebe incerteza de efeito. 77 testes
focados/5 arquivos passaram; nove processos encerrados. `code_exec` continua
sem admissão nativa.

A CLI passa a ser incluída no ASAR e recebe o launcher Windows `codestudio.cmd`.
O caminho dos binários Rust deriva da localização física do ASAR, inclusive em
Electron Node sem `resourcesPath`, e não depende do diretório de trabalho. O
verificador de pacote passa a percorrer também os imports da CLI. 29 testes
focados/4 arquivos e build passaram; oito e 68 processos encerrados. A prova
física empacotada passou nos cinco cenários: conclusão, retomada, aprovação, cancelamento e falha (71,63 s, 65 processos encerrados). O launcher respondeu 3.15.1. A matriz completa passou em 455,69 s, com 68 checkpoints, zero replay e 509 processos encerrados; smoke, legado e RAG direto passaram, outros 60 encerrados. ASAR: `7d0c35ad8494f60015134b21a2dd1445b29607957fbaca234b3b177d5cb90a3e`. O pacote é `dist/electron-native-cli-20261008/win-unpacked`; não foi instalado. Não é certificação global da superfície.
A primeira matriz CLI falhou antes do provider: o protocolo viu um timestamp
1.909 ms adiantado. O evento Kernel-General 1 do Windows, no mesmo instante,
registrou avanço de 1.910 ms no relógio por svchost. O runtime falhou fechado;
a tolerância de autoridade não foi ampliada. A repetição passou, mas suporte a
mudanças do relógio durante a execução permanece um cenário de robustez aberto.
Evidência: `packaged-cli-matrix-system-clock-events.json`.

Trace limpo de inicialização (`packaged-cli-startup-clean/report.json`): maior
RunTask no renderer 193,50 ms e no main 159,16 ms; 29 processos encerrados.
O trecho de 809 ms na primeira captura veio de `seedExistingProjectFixture`
injetado pelo teste, não da inicialização normal. Nenhuma captura reproduziu
os 8.759 ms antigos. São amostras locais instrumentadas, não comprovação de p95.
### Contexto grande entre Rust e Host — pacote 135, 2026-10-08

Pedidos ao provider/checkpoints que ultrapassam um frame Data agora transferem
um `ProviderStart` canônico em partes contíguas de até 128 KiB, com teto de 16 MiB.
Cada confirmação autentica a mensagem recebida; o commit final valida tamanho,
SHA-256, identidade, runtime, operação e deadline antes de abrir o provider ou
persistir o checkpoint. Reenvio exato usa o replay do canal; não duplica partes.
Cancelamento/desconexão libera o buffer e não autoriza repetição de efeitos.
O limite físico de 1 MiB do canal Data permanece. Pedidos pequenos seguem inline.

`provider-chunks-output-physical/report.json`: **70,54 s**, nove leituras grandes,
pedido maior que 1 MiB, continuação e recuperação após restart com fonte alterada.
Tarefas e upgrade existente também passaram; **59 processos** encerrados sem
cleanup forçado. `provider-chunks-wide-processes`: **2.475 testes/302 arquivos**,
391 processos encerrados. `provider-chunks-final-focused-r3-processes`: **106
testes/10 arquivos**, incluindo contrato, correlação, replay, corrupção,
checkpoint e cancelamento antes do provider; 14 processos encerrados.
`provider-chunks-native-gates-processes`: **389 testes Rust**, Clippy sem warnings
e limite de 250 linhas aprovado nos 901 módulos; 71 processos encerrados.

Build final `provider-chunks-build-r2-processes` passou; 90 processos encerrados,
um helper encerrado pelo Job. CLI real em Electron Node: cinco cenários (início,
retomada, aprovação, cancelamento e falha), 102,25 s e 64 processos encerrados.
Matriz `provider-chunks-packaged/report.json`: **419,73 s, 66 checkpoints, zero
replay**, contextos acima de 1 MiB recuperados após restart; 491 processos
encerrados sem cleanup forçado. Smoke, legado e RAG direto passaram; 60 processos
encerrados. Perfil isolado e provider determinístico local. Não promove rollout.

Fonte congelada `scratch/harness-candidates/2026-10-08T03-17-22-867Z`, manifesto
SHA-256 `d9fea8f2fa35a82f3d2a84c95a74a085e4167a98bf55f31ef0f5debf13b48945`.
Pacote `dist/electron-native-provider-chunks-20261008/win-unpacked`.
Instalador `dist/electron-harness-provider-chunks-installer-20261008/CodeStudio-Harness-Provider-Chunks-2026-10-08.exe`:
321.739.014 bytes, SHA-256 `b1d1c165540844f4de18f003aa9563d8b7f2f6e8437ac34e6ab408375872e735`.
Os 4.933 arquivos extraídos conferem com o pacote por SHA-256
(`provider-chunks-installer-verification.json`). Geração, extração e verificação
encerraram seus 15 processos sem cleanup forçado. Não executado nem instalado;
instalação do usuário intocada.

Posteriormente, o ensaio com journal Rust físico confirmou o custo da reconstrução
repetida. A otimização e seus resultados constam acima e **não estão neste pacote**.

### Tarefas e checklists nativos — pacote 135, 2026-10-08

Integradas `todo_write`, `update_todo`, `task_list`, `submit_tasks`, `list_tasks`,
`update_task`, `cancel_tasks`, `delete_tasks` e `archive_task_list`. A porta por
invocação substitui a dependência de `CoderRunner`; cada chamada prepara uma
transação atribuída ao resultado da ferramenta. Falha ou cancelamento descarta
alterações parciais. A projeção aceita apenas pares resultado/terminal confirmados
pelo journal e preserva o estado apagado (`null`) sem ressuscitar o board legado.
Eventos de atualização saem depois da confirmação durável. Leituras independentes
continuam paralelizáveis; mudanças no board formam barreiras sequenciais.

A aprovação registra a espera antes de publicar o cartão; HTTP e interface
carregam o identificador da interação. Perda do ACK/owner não escreve um resultado
legado nem repete a execução. Limites: 128 tarefas, 64 KiB por fotografia, 8.192
caracteres por texto, dependências existentes e acíclicas. Respostas de aprovação
com dados inválidos não confirmam a alteração. Checklists mantêm o limite de 50.

Provas locais finais: 182 testes/10 arquivos (`native-tasks-focused-r5-processes`),
2.446 testes/300 arquivos e inventário (`native-tasks-wide-r2-processes`), build
completo com dashboard (`native-tasks-build-r3-processes`). Respectivamente 14,
389 e 77 processos encerrados; o build precisou encerrar um helper contido no Job.
Fixture Electron `native-tasks-output-physical/report.json`: 61,913 s, nove
ferramentas, saída grande, retomada e limpeza durável; 59 processos encerrados.

A primeira matriz do pacote 135 encontrou outro defeito real: o writer nativo
aceitava apenas 256 KiB por frame, mas um checkpoint de saída truncada chegou a
269.839 bytes. O reader já usava 17 MiB/16 MiB. Writer e reader agora compartilham
os limites de 17 MiB para envelope e 16 MiB para payload; o codec limita também o
registro final, e falhas de transporte preservam a causa original sem repetir
pedidos numa conexão envenenada. Nove testes de storage/frontier e um teste Rust
de resultado grande passaram. A fonte corrigida foi recompilada e empacotada.

Matriz corrigida `native-tasks-checkpoint-packaged/report.json`: **403,83 s,
66 checkpoints recuperados, zero replay de provider**, incluindo tarefas,
saída truncada recuperada após restart e upgrade 268 preservado. Todos os **491
processos** encerraram sem cleanup forçado. Compatibilidade smoke, chat legado
e RAG direto passou (`native-tasks-checkpoint-package-compat`); 60 processos
encerrados. Perfil isolado e provider determinístico local; não certifica
providers reais nem produção. As falhas anteriores permanecem como evidência.

Fonte congelada: `scratch/harness-candidates/2026-10-08T02-46-18-556Z`, manifesto
SHA-256 `65afca185a91c470bea46894577a74820c8cdae4b1487cd4bb3b2e6be4609e16`.
Pacote `dist/electron-native-tasks-checkpoint-20261007/win-unpacked`, ASAR
`da2eeee20447dc2f9d96866ddaf4c38dd9841ab85167a21726b0a40a65dcdd7b`.
Instalador `dist/electron-harness-tasks-checkpoint-installer-20261007/CodeStudio-Harness-Tasks-Checkpoint-2026-10-07.exe`:
321.727.764 bytes, SHA-256
`c65707cd347e0622f88cc8b698a89e41211a5361c42da9435b9fed212862ee14`.
Os 4.933 arquivos extraídos coincidem com o pacote testado
(`native-tasks-checkpoint-installer-verification.json`). Instalador não executado;
instalação, configurações e permissões do usuário preservadas. Padrão legado.

`execute_tasks`, `task_complete`, workflows e árvores de agentes ainda requerem
integração própria. A transferência de pedidos ao provider em partes está sendo
validada no checkout e **não faz parte deste instalador congelado**.

### Cancelamento de revisão e pipelines auxiliares — fonte posterior ao pacote 126

`self_review` e `review_subordinate_work` repassam o cancelamento até a revisão,
o compilador de intenção e o provider configurado. Retry e failover tratam
cancelamento como terminal: não iniciam outro provider nem uma reparação de JSON,
e interrompem a espera de `Retry-After`. Os adapters REST e OAuth removem seus
listeners ao terminar. O fluxo continua aguardando a operação física em andamento;
cancelar o transporte não comprova que o efeito terminou.

A consulta auxiliar de referências agora cancela ao atingir cinco segundos e
aguarda o handler encerrar, em vez de abandoná-lo por `Promise.race`. Parsing
limitado a 1 MB/200 referências; `focus` limitado a 4.000 caracteres. A preparação
para entre arquivos e etapas após cancelamento, descarta findings tardios e
encerra como erro o registro de revisão já criado. Isso não equivale a uma
transação de todos os comentários nem a fencing nativo da persistência de revisão;
essas ferramentas continuam pendentes no catálogo Rust.

`review-cancel-tests-r2-processes`: **86 testes/10 arquivos**, incluindo uma
conexão HTTP real em localhost que fecha sem fallback, callbacks tardios,
backoff, descarte de respostas e liberação de listeners/timers. Os 14 processos
encerraram. `review-cancel-build-processes`: build aprovado, 68 processos
encerrados. Essas mudanças estão incluídas no pacote 135 acima; não estão no antigo 126.
Regressão ampla final `review-cancel-wide-r2-processes`: **2.422 testes/297
arquivos** e inventário aprovados; todos os **386 processos** encerraram.
A primeira execução passou nos testes e falhou apenas no inventário estático,
regenerado após extração do helper. Nenhuma dessas provas promove `self_review`
para o runtime Rust ou comprova todos os providers reais.

### Regressão de upgrade identificada em uso — 2026-10-07

O usuário encontrou `Migration 268 (semantic_job_lookup) failed: no such table:
main.semantic_jobs` ao iniciar o chat. O processo observado usava o pacote 125
em `dist/electron-native-skill-authoring-20261007/win-unpacked`; os arquivos da
instalação de `Program Files` continuavam sem alteração.
A migração 268 desta revisão criava um índice sem conferir a existência da
tabela central, removida intencionalmente dos bancos de projeto. Perfis novos
passavam porque aplicavam a migração antes de remover as tabelas centrais.

`migration268-reproduction-processes` reproduziu exatamente a falha em dois
testes. A migração agora ignora a tabela ausente; o banco central mantém o índice.
`migration268-fixed-processes`: **13 testes aprovados**, seis processos encerrados.
Uma falha no construtor de `ProjectDb` agora também fecha sua conexão SQLite.
O harness ganhou `--existing-project` para exigir upgrade durante o chat.
O pacote 125 passou na matriz de perfis novos, mas **não está aprovado para
upgrade de projetos existentes**. A primeira reprodução física usou um projeto
ainda pendente de separação de banco e não reproduziu a falha. O fixture passou
a exigir `db_split_status=done`, roteamento ativo e um marcador de dados.
`migration268-packaged-reproduction-r2` reproduziu o erro 500 e a mensagem exata
da migração no ASAR 125; seus nove processos encerraram.

O fonte corrigido passou em `native-path-physical-r2/report.json`: **35,62 s**,
upgrade aplicado pelo chat, marcador preservado, `quick_check=ok`, operações de
arquivos e reinício. Todos os 39 processos encerraram. Build e **2.336 testes em
287 arquivos** aprovados; os 68 processos do build e 376 da regressão encerraram.

O pacote corrigido está em `dist/electron-native-path-upgrade-20261007/win-unpacked`.
Matriz `native-path-packaged/report.json`: **420,72 s, 64 checkpoints e zero
replay de provider**; upgrade iniciado pelo chat, marcador preservado e
`quick_check=ok`. Todos os **476 processos** encerraram naturalmente. Smoke,
chat legado (**21,78 s**) e RAG direto (**27,39 s**) passaram em
`native-path-package-compat`, ambos com o mesmo fixture de projeto existente;
seus **60 processos** também encerraram. São testes com provider local
determinístico, sem certificação de produção ou de contas reais.

ASAR: `d7b4e56c78464a8d14bec4a938583ead35bab8b3af32c308607adff5d2993b45`.
Fonte congelado: `scratch/harness-candidates/2026-10-07T17-51-37-785Z`,
manifesto `eb351681af39250c7454679bc421364e9ea0f2b32d12afbaa52592f039bfc912`.
Runtime: `runtime-v1-d15e1f407f39d8e83988ab2d457fd047e9313eb2cb2d5bbad12c5023d1320c0f`,
manifesto `4c1d0322cd9fa5e84dd35ed8f7e8a7271e332d878f15a6cee28d1f98f9d44661`.

Instalador gerado, **sem executá-lo ou substituir a instalação/instância do usuário**:
`dist/electron-harness-fix-installer-20261007/CodeStudio-Harness-Fix-2026-10-07.exe`,
SHA-256 `21674109ac76c261915c49dd96274181da6dc76416f3d960056457cdfd28dd87`.
O Job do empacotamento registrou nove processos, todos encerrados. O ASAR permaneceu
idêntico ao exercitado pela matriz. A extração com 7-Zip 25.01 e a comparação dos
**4.933 arquivos** passaram em `native-path-installer-verification.json`; os seis
processos de extração/verificação encerraram. A tentativa anterior com 7-Zip 21.07
falhou por não reconhecer o filtro ARM64 e não conta como validação.
O runtime padrão continua legado; integração
de todas as ferramentas e certificação do rollout permanecem abertas.

### Gerenciamento de caminhos no Windows

`manage_path` entra no catálogo nativo como barreira de escrita. O addon usa
`SetFileInformationByHandle` com substituição desativada e mantém handles dos
pais até terminar. Não usa fallback de cópia/remoção ou check+rename. Rejeita
travessia, streams, aliases Win32 e reparse points. O adapter conserva o recorder
da sessão e revalida o lease depois de capturar snapshots. O legado conserva seu
adapter anterior; a exclusividade atômica descrita aqui pertence ao adapter nativo.

Quatro testes físicos Rust cobrem arquivo/diretório, destino ocupado, disputa
entre 16 threads e junções externas; Clippy passou com warnings como erros.
Testes TypeScript focados: 152 em cinco arquivos. Entradas booleanas/enums são
estritas, erros de acesso não são confundidos com ausência, trash usa UUID, e
inspeção de pasta não vazia para no primeiro item, fechando o iterator.
Falhas após despacho sem confirmação retornam resultado incerto, sem retry
automático. O teste físico preservou destinos ocupados, conteúdo na lixeira,
remoção permanente confirmada, proteção de `.git` e estado após restart.

### Memória persistente e processos de teste — 2026-10-07

O pacote de 122 ferramentas passou na repetição pós-interrupção
`native-session-data-packaged-r2/report.json`: **348,18 s, 59 checkpoints,
zero replay de provider e nenhum processo restante**. O Job do Windows
registrou **441 processos**, todos encerrados naturalmente. Smoke, legado
(19,30 s) e RAG direto (27,29 s) passaram em
`native-session-data-package-compat-r2`; seus 60 processos também encerraram.
ASAR: `32b8ed4343b47554a593c0338bc9d46a286bf120d73da3bd54cf666808f1895a`.
Os testes anteriores interrompidos ficaram sem relatório final e não contam
como aprovação. Fonte desse pacote: `2026-10-07T09-24-12-178Z`, manifesto
`8ebb85bf3f86d42fd5d09779afd7567c071b74854a29b5dbf862cf12041a4362`.

A fonte posterior conecta `remember` e `forget_memory` ao host da attempt
nativa com recurso `memory:project` ou `memory:user`, projeto derivado do
owner e revalidação da autoridade dentro da fila de escrita. Receipts limitados
reutilizam a resposta de um pacote repetido; um mesmo ID com entrada diferente
é rejeitado. Perda de confirmação produz efeito incerto e nunca retry automático.
Embeddings saem da espera de gravação somente quando há fila durável de mutações.
Cancelamento/drain aguardam a operação real. Preferências `user`/`feedback`
agora deduplicam entre as duas representações. Leitura rejeita limites inválidos;
o caminho legado de notas não anuncia sucesso quando a persistência retorna null.

Regressão ampla final: **2.291 testes em 281 arquivos**, inventário aprovado;
**370 processos** encerrados naturalmente. O primeiro build encontrou um campo
`importance` ausente no fixture; corrigido. O primeiro fluxo físico revelou um
defeito real: a diversificação por palavras do título ocultava fatos explícitos
distintos. Ela agora se aplica apenas quando existe uma memória automática no par.
`native-memory-writes-physical-r2/report.json` passou em **46,03 s**, com quatro
checkpoints, zero replay, escopos preservados, deduplicação, arquivamento e
reinício. Seus **44 processos** e os **68 do build** encerraram naturalmente.
Leitura de memória usa FTS nesse fixture; cancelamento, revogação durante a fila,
pacote duplicado e ACK perdido têm testes focados. Novo pacote em validação.
Catálogo habilitado não é certificação.

Pacote de 124 ferramentas: `dist/electron-native-memory-writes-20261007/win-unpacked`,
ASAR `7f805cea9259a7219450a5a38a371edfa59e689f05f2f52048fbda5da2fdd6c1`.
Matriz `native-memory-writes-packaged/report.json`: **338,03 s, 60 checkpoints,
zero replay**, todos os **450 processos** encerrados naturalmente. Smoke,
legado (19,31 s) e RAG direto (24,96 s) aprovados; seus **60 processos** encerraram.
Fonte congelada: `scratch/harness-candidates/2026-10-07T16-48-02-335Z`, manifesto
`047f1c88166838451e8ab59e3c6c5c4a72a9ca3515f03c466c24831a2a656b18`.

A fonte posterior habilita `create_skill` com contrato sequencial de escrita.
A avaliação de gatilhos usa até 500 registros de metadados dos escopos admitidos,
sem carregar prompts; relatórios parciais declaram as omissões. Entradas são
limitadas e validadas, o worker cede ao loop de eventos antes do commit, e a
autoridade é conferida dentro da transação. Um ID de outro projeto não pode ser
sobrescrito; atualizações sem scope preservam o escopo. Filtros SQL de skills
agora usam parâmetros, inclusive tags com aspas ou curingas literais.
Testes focados aprovados: 134 em cinco arquivos. Typecheck/build detectaram um
fixture incompleto de autoridade, corrigido com `bindInvocation`. Regressão
ampla: **2.309 testes em 283 arquivos**, inventário e build aprovados.
`native-skill-authoring-physical/report.json` passou em **48,92 s**, seis
checkpoints, dry run sem escrita, proteção de projeto, atualização preservando
scope e catálogo imutável por attempt. Após reiniciar, a próxima attempt carregou
o prompt atualizado. Os **54 processos físicos**, **68 do build** e **372 da
regressão** encerraram naturalmente.

O pacote **125** passou em `native-skill-authoring-packaged/report.json`:
**356,56 s, 63 checkpoints recuperados, zero replay de provider**, skills
preservadas e catálogo atualizado após reinício. Os **468 processos** da matriz
encerraram naturalmente. Smoke, legado (19,63 s) e RAG direto (25,59 s) passaram
em `native-skill-authoring-package-compat`; os 60 processos encerraram.
Pacote: `dist/electron-native-skill-authoring-20261007/win-unpacked`.
ASAR: `f918faaab5f51e537ea4d3a8a0ff48be37a49147a5d5b43ffa46a5e54888e59d`.
Fonte: `scratch/harness-candidates/2026-10-07T17-07-23-598Z`, manifesto
`5db88bcef0b2d635857f5b3363ba2cfe75bd79b23c854a3e950dff0780e90a61`.

Todos os novos testes/builds deste trabalho usam registro de PIDs, contenção
e confirmação de árvore vazia, descritos em
[propriedade dos processos](./test-process-ownership.md). Não encerrar por nome
processos do usuário, do Codex ou de outras tarefas.

### Crash do LSP reproduzido e corrigido no pacote de 92 ferramentas

A matriz `native-mcpdocs-packaged/report.json` interrompeu aos 147,13 s:
`FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal` durante cancelamento da carga
inicial do TypeScript, em `cjsPreparseModuleExports`. O processo Electron foi
encerrado. O pacote **não está aprovado**, apesar de o smoke, fallback legado
(22,63 s) e RAG direto (25,22 s) terem passado individualmente. Todos os processos
Electron rastreados terminaram. ASAR do pacote rejeitado:
`a23abe3ffdf6968c5a7b05922c79b74c761a45037cee4960cccf67294811b29d`.
A evidência anterior de LSP permanece histórica e não exclui essa falha intermitente.

A correção substitui o worker thread de LSP por processo privado dentro de um
Job nativo, com heap limitado, protocolo limitado e espera pelo receipt físico
de término. Uma falha de cleanup permanece bloqueante nas chamadas seguintes.
O smoke cancela em oito intervalos de bootstrap. Cinco rodadas passaram,
confirmando **45 términos físicos** (`native-lsp-process-stress-r2.txt`).
Regressão: **1.924 testes em 234 arquivos**; a primeira checagem do inventário
apontou os números de linha desatualizados, depois regenerados e verificados.
Build e fluxo físico aprovados: `native-lsp-process-physical/report.json`,
38,19 s, navegação LSP, edição das dependências, cancelamento, MCP de documentos,
busca e memória proativa; nenhum processo Electron de teste restante.

Pacote corrigido: `dist/electron-native-lsp-process-20261007/win-unpacked`,
ASAR `ff25cdc62ae6acf0307e1a8f9f0ac707c197a56d7779b5967699aeaf762217fa`.
Matriz `native-lsp-process-packaged/report.json` aprovada em **239,69 s**:
**47 checkpoints**, zero replay de provider, nenhum processo Electron de teste
restante; ACK de cancelamento do LSP em 15,8 ms nesta execução (não é p95).
Fallback legado aprovado em 18,09 s e RAG direto em 21,32 s. Smoke aprovado.
O executável empacotado confirmou mais **45 términos físicos** em cinco rodadas
(`native-lsp-process-packaged-stress.txt`). Fonte congelada:
`scratch/harness-candidates/2026-10-07T04-15-08-595Z`, manifesto
`64da6b5a762f9cc934edba8f96837c8b321ab7eebe314b58d29fd3742c1e93a0`.
O pacote reprovado permanece registrado; não foi instalado no PC.

### Custos e catálogo de modelos — fonte posterior ao pacote

`mcp__get_costs` normaliza datas ISO com fuso para o formato UTC do ledger;
a comparação anterior excluía custos do mesmo dia ao receber um timestamp com
`T`. Agregações usam uma transação consistente e cache limitado a 32 projeções
de até 64 KiB, invalidado por commits de outras conexões e alterações locais.
Consultas dentro de transações externas não alimentam o cache, pois um rollback
não reduz `total_changes`. A mesma correção protege o cache da estrutura do projeto.

`mcp__list_models` reutiliza o banco do perfil recebido e pagina o catálogo em
SQL: 100 itens por padrão, máximo 500, total e recuperação explícitos. Consultas
normais não acessam rede. `live=true` mantém os endpoints públicos existentes,
com prazo global de 10 s, até quatro leituras concorrentes, corpo JSON limitado
a 4 MiB e cancelamento aguardado. A ferramenta não grava no cache compartilhado;
falhas retornam catálogo local com aviso. OAuth e providers personalizados
continuam usando o catálogo local, atualizado nas configurações do provider.
O limite e a validação também protegem o cache legado contra JSON inválido/grande.

Regressão ampla: **1.939 testes em 236 arquivos**, build e inventário aprovados.
O primeiro teste físico tinha uma expectativa errada de consulta de custos de
outro projeto; o bridge corretamente fixa o projeto admitido. A expectativa foi
corrigida e `native-catalog-physical-r2/report.json` passou em 53,25 s, incluindo
catálogo de 553 modelos e recuperação da última página. Nenhum Electron restante.

Pacote: `dist/electron-native-catalog-20261007/win-unpacked`, ASAR
`08e9b8758cd80cca696cf590049226b4391c60dde552525b58773bc0afefce51`.
Matriz `native-catalog-packaged/report.json`: **260,33 s, 49 checkpoints,
zero replay e nenhum Electron de teste restante**. Smoke aprovado, legado em
18,72 s e RAG direto em 20,95 s. O primeiro empacotamento falhou ao abrir o cache
SQLite do pnpm no sandbox; a repetição com acesso autorizado concluiu. Fonte
congelada em `scratch/harness-candidates/2026-10-07T04-39-34-029Z`, manifesto
`ae9571931991d64e3a902a7bed3381b1b348c906a3cb83e0eefa46f5a02a696a`;
a correção da expectativa do fixture ocorreu depois desse registro.

### Leitura, diretórios e símbolos MCP — fonte posterior ao pacote

`mcp__list_directory` substitui listagem completa do índice por SQL com limite,
prefixo com separador e profundidade. O fallback usa diretórios assíncronos e
fecha seus handles antes de retornar; páginas de disco seguem a ordem do
filesystem e devem reiniciar se houver mudanças. Travessia e junction para fora
da raiz são rejeitadas. **17 testes focados**, **1.945 testes em 237 arquivos**
na regressão ampla e fluxo físico `native-directory-physical/report.json`
aprovados: 553 arquivos do índice e 553 do disco, ambas as páginas finais
recuperadas, 46,74 s, nenhum Electron restante.

`mcp__read_file` passa a ler de forma assíncrona, verificar o arquivo antes/depois
e usar a contagem atual de linhas. Leitura completa até 16 MiB; páginas em bytes
permitem recuperar arquivos maiores, com fronteiras UTF-8 preservadas ou base64
para bytes arbitrários. Regex recebe prazo de 50 ms e os seletores de símbolo
recebem prazo próprio. A versão nativa preserva seu contrato enxuto de cinco
argumentos, conforme a decisão anterior do repositório.

`mcp__get_file_skeleton` pagina apenas metadados de declarações em SQL, com
recuperação explícita. Filtros por nome informam contagens de candidatos e de
correspondências da página, sem fingir total global filtrado. Arquivos não
indexados até 1 MiB usam extração apenas de declarações, sem dependências/call
graph, prazo de parse de 100 ms e orçamento de travessia. Inicializações
concorrentes compartilham a criação do parser. **64 testes focados em 11 arquivos**
e **1.996 testes em 245 arquivos** passaram, assim como build e typecheck.
`native-file-tools-physical/report.json` aprovado em **52,57 s**, com páginas
UTF-8, arquivo completo e cauda, 553 símbolos indexados, 25 do fallback,
deadline de regex e travessia rejeitada; nenhum Electron de teste restante.
Pacote `dist/electron-native-file-tools-20261007/win-unpacked`, ASAR
`e1655275b5c8dcf148f8ac1488897070b882d570645335429fbf134a69942eda`:
matriz completa aprovada em **267,51 s**, nenhum Electron de teste restante.
Smoke, legado (**20,61 s**) e RAG direto (**22,67 s**) aprovados. Fonte congelada
`scratch/harness-candidates/2026-10-07T05-10-59-603Z`, manifesto
`d2922293d39a7d890b6790a2f7d74f735a4c84c1fccd8eeb6062abfe3387f0a8`.
Pacote comprovado: **97**; não instalado no PC.

Benchmark sintético no mesmo banco com 2.000 arquivos/16.000 símbolos:
`native-skeleton-page-benchmark.json`, saída equivalente. Mediana aquecida
de quatro consultas caiu de **2.703,73 ms para 5,32 ms**; linhas materializadas
de 16.000 para 100 e JSON de 21.964.039 para 17.801 bytes. Mede apenas esta
consulta, sob carga local; não representa p95 nem aceleração total do agente.

### Hierarquia, implementações e corpo atual — fonte posterior ao pacote

`mcp__find_implementations` e `mcp__get_hierarchy` consultam metadados paginados
em SQL, incluindo totais exatos, relações duplicadas removidas e recuperação.
A cadeia de ancestrais para em ciclos, ambiguidade e cinco saltos, explicando
o motivo; relações por nome não são apresentadas como resolução exata do compilador.

`mcp__get_symbol_body` relê bytes atuais e revalida a declaração por parser até
1 MiB, com fallback heurístico identificado até 16 MiB. Um caminho explícito
nunca é substituído por outro arquivo. Corpos grandes, candidatos ambíguos e
busca de declarações recentes em arquivos indexados têm páginas recuperáveis;
somente a página corrente atravessa a consulta SQL. **99 testes em quatro
arquivos**, typecheck e **2.009 testes em 247 arquivos** aprovados.

O primeiro teste físico detectou perda de `implements` na reindexação real:
o extrator tratava os nós aninhados de herança TypeScript incorretamente, inclusive
registrando `implements Port` como superclasse. Corrigido também JavaScript e
listas Java; nomes genéricos usam sua base, interfaces com múltiplos pais mantêm
todas as arestas. A versão do cache de extração foi elevada para 2. Índices já
persistidos precisam ser reindexados para reconstruir relações anteriormente
perdidas; invalidar o cache não reescreve sozinho todos os índices existentes.
`native-symbol-tools-physical-r2/report.json` passou em **51,31 s**, com 553
implementações, recuperação da cauda, corpo atual, ambiguidades e cadeia limitada.
Nenhum Electron de teste restante.

`mcp__find_references` pagina referências e candidatos diretamente no SQLite.
Trechos de contexto têm limite e recuperação por arquivo/linha; referências do
índice são explicitamente baseadas em nomes. O fallback em disco usa handles
assíncronos, orçamento de arquivos/bytes/tempo, sinal de cancelamento e cursor de
arquivo/linha. Não declara ausência comprovada em uma varredura incompleta.
**101 testes focados**, **2.031 testes em 251 arquivos**, build e typecheck
aprovados. `native-symbol-references-physical-r2/report.json`: **51,86 s**, nenhum
Electron restante. O fixture inicial esperava 553 chamadas em um só arquivo,
acima do limite existente de 400 chamadas por arquivo do indexador. Foi dividido
em dois arquivos; esse limite não foi relaxado. O fixture foi atualizado após
o registro da fonte, incluindo a declaração no segundo arquivo para satisfazer
a regra do indexador de contar apenas nomes conhecidos/importados no arquivo.

Pacote `dist/electron-native-symbol-tools-20261007/win-unpacked`, ASAR
`1b6df778ecf9dcf7d3aa8fbd2c0e8bec61e30d5bf64467f916915f77b5cb3899`:
matriz aprovada em **292,71 s**, **52 checkpoints**, zero replay e nenhum Electron
restante. Smoke, legado (**18,07 s**) e RAG direto (**23,26 s**) aprovados.
Fonte `scratch/harness-candidates/2026-10-07T05-42-15-954Z`, manifesto
`adfda1f457515c4840c27151d847836a4a01f05f2b1827323a6ea1e709c0627e`.
Pacote comprovado **101**, não instalado no PC.

`mcp__semantic_neighbors` usa metadados limitados e uma única consulta dos
vizinhos no projeto correto. Rejeita projeto desconhecido, IDs inválidos e limite
fora de 1..50; não aceita o payload de resultados removidos/estrangeiros como
substituto do banco. O corpo atual é um excerto limitado; arquivos acima de 1 MiB
usam contexto estrutural. Também aceita nome e arquivo para não depender de IDs
que a navegação não expunha. Cancelamento não dispara fallback lexical.
**91 testes em três arquivos**, **2.037 testes em 252 arquivos** e build aprovados;
`native-semantic-neighbors-physical/report.json` aprovado em **51,31 s**, sem
Electron de teste restante. Esse ensaio usa fallback lexical, com embeddings e
reranker desabilitados no perfil isolado: não certifica qualidade vetorial.

`mcp__trace_usage` limita o grafo antes de materializar resultados: cinco chamadas
por ramo, cem nós, profundidade até cinco e orçamento de travessia de 100 ms
verificado entre consultas. Inclui chamadas no próprio arquivo e usa a declaração
que contém a chamada, sem expandir todos os símbolos daquele arquivo. Ciclos,
limites e ambiguidades ficam explícitos, com consulta para recuperar referências.
A mesma implementação atende à CLI. O orçamento não interrompe uma consulta
SQLite já em execução. **103 testes em quatro arquivos** aprovados.

O primeiro ensaio físico de edição encontrou outra perda do indexador: a categoria
de referência (import/chamada) era descartada na gravação. A migração **269**
preserva os registros antigos como não classificados; a extração versão **3**
persiste a categoria nas novas indexações. O grafo filtra chamadas e sua recuperação
pagina o mesmo conjunto. Registros antigos recebem aviso e consulta própria;
não são reclassificados por heurística. Reindexar continua necessário para
preencher essa informação em índices antigos. O resultado inicial foi rejeitado.

`mcp__prepare_edit` lê o corpo atual e pagina chamadas, imports e testes no SQL,
sem reconstruir todas as relações nem hidratar arquivos completos. Os vizinhos
são limitados à região da declaração original, preservada na continuação do corpo.
Arquivo explícito não muda de escopo; símbolos ambíguos exigem seleção. O fallback
em disco preserva avisos de varredura incompleta e cancelamento.
`native-edit-context-physical-r2/report.json`: aprovado em **33,47 s**, sem Electron
restante, incluindo vizinhos semânticos. **2.051 testes em 254 arquivos**, mais
**20 testes** de extração/migração/banco por projeto, aprovados. Fonte congelada
`scratch/harness-candidates/2026-10-07T06-25-40-836Z`, manifesto
`98834aa7e36c6ed458d68362a3557bb5fb48fdd1dc7e9373dfa293001dc25c03`.
Pacote `dist/electron-native-edit-context-20261007/win-unpacked`, ASAR
`04da37bc2f2d2d77aedf2f2de99041be6fd2f8c52f5d2b512c0613e5874f52fb`:
`native-edit-context-packaged/report.json` aprovado em **285,22 s**, com
**54 checkpoints**, zero replay e nenhum Electron de teste restante. Smoke,
legado (**20,98 s**) e RAG direto (**22,49 s**) aprovados. Pacote comprovado **104**,
não instalado no PC. Provider de teste local; não certifica qualidade de modelos,
p95 de produção, soak ou canário.

`mcp__get_repo_map` agora ranqueia e pagina arquivos em SQL (100 por padrão,
máximo 500), com até três símbolos por arquivo e recuperação das prévias e
assinaturas abreviadas. Contagens de dependentes usam arquivos distintos; JSON
permanece estruturado e o orçamento textual é independente da paginação. O mapa
inserido no prompt busca até 80 arquivos recentes e seis símbolos de topo por
arquivo, sem carregar todos os arquivos ou fazer consultas completas por arquivo.
O orçamento fixo de contexto existente foi preservado; comentários e testes que
ainda descreviam o antigo ajuste por ambiente foram atualizados. **35 testes
focados**, **2.070 testes em 256 arquivos** e build aprovados.
`native-repo-map-physical/report.json`: **33,22 s**, 554 arquivos, cauda recuperada,
ranking com 553 dependentes e nenhum Electron restante. Fonte
`scratch/harness-candidates/2026-10-07T06-37-53-662Z`, manifesto
`345da67bcac5c9530209f8625e49c3988c9886852c46d5ea3bf08cad54c9a8e9`.
Fonte **105 / 142**, último pacote comprovado **104**; essa contagem não comprova
rollout em produção.

Benchmark sintético (`native-repo-map-benchmark.json`, script
`scripts/harness-repo-map-benchmark.cjs`): mesmo banco com 2.000 arquivos e 16.000
símbolos, mesmos 100 arquivos/símbolos selecionados. Mediana aquecida de três
amostras após aquecimento: **2.471,95 ms → 13,83 ms**, materialização de
**18.000 linhas / 22.694.932 bytes → 400 linhas / 63.593 bytes**. O script foi
adicionado após o congelamento da fonte. São medidas locais sob carga de testes,
não p95 nem aceleração global do agente/provider.

`mcp__search_memory` recebe IDs/pontuações do serviço proprietário da busca e lê
em lote páginas do conteúdo atual no banco do projeto. IDs estrangeiros, arquivados
ou inválidos não viram conteúdo; a hidratação vetorial também verifica o projeto,
além do escopo. O RPC opta pela projeção de IDs, preservando a resposta completa
para consumidores antigos que não a solicitam. Conteúdo tem páginas Unicode de
4.000 caracteres por padrão, máximo 16.384, com recuperação por ID sem repetir a
busca semântica; respostas vazias em JSON permanecem JSON. Consultas inválidas
e cancelamento não disparam fallback. O serviço limita candidatos vetoriais e
IDs, preservando a ordem de relevância e o algoritmo de ranking/deduplicação.
O ranking ainda utiliza o conteúdo completo dos candidatos no serviço proprietário;
essa mudança limita a transmissão e o retorno da ferramenta, não prova ausência
de todos os custos de hidratação na memória. **30 testes focados**, regressão de
**2.076 testes em 257 arquivos** aprovados; projeção RPC com validação adicional,
build e ensaio físico aprovados (35,98 s). Pacote de **106 ferramentas** aprovado: matriz em **277,40 s**, **55 checkpoints** recuperados, zero replay de provider e nenhum Electron de teste restante. Smoke, legado (**18,70 s**) e RAG direto (**23,23 s**) aprovados.

Pacote: `dist/electron-native-memory-pages-20261007/win-unpacked`, ASAR
`83acba77807f38abd40ac0638182ba5934fb9ef05ef2c3785d54dc1b119a161c`.
Fonte congelada: `scratch/harness-candidates/2026-10-07T06-51-51-029Z`,
manifesto `79a75cbad37abdaa12cfbd0c2206c031c2871e5bb1052e99a18fd9ccf51ca171`.
Busca de memória testada com owner isolado e FTS; não mede qualidade vetorial
nem provider real. Instalação do PC e runtime padrão não foram alterados.

### Criação exclusiva e diagramas — fonte posterior ao pacote 106

`create_file` e `diagram_create` usam criação exclusiva no filesystem, sem a
janela access/write que permitia sobrescrita. O wrapper de snapshots revalida a
autoridade depois de gravar a baseline e só confirma a alteração após sucesso.
Doze criações concorrentes de diagramas e dezesseis de arquivos preservam um
único vencedor. Adapters personalizados sem criação exclusiva falham claramente.
O adapter OCI usa publicação por hard link sem substituição; seus argumentos e
falhas foram testados, sem certificação de um container real nesta rodada.

XML tem limite de 4 MiB, varredura linear de tags/atributos e profundidade máxima
de 1.024. A normalização trata cada página, ignora tags em comentários e escapa
títulos; não é um validador geral do schema draw.io. Leituras locais usam handle
aberto, conferem arquivo regular e limitam bytes inclusive após crescimento.
Listagens locais iteram o diretório e fecham o handle após a página; adapters
legados podem ainda materializar sua listagem. Páginas usam ordem do filesystem
e pedem reinício após mudanças no diretório. Erros de IO e cancelamentos não
são tratados como ausência. As quatro operações CRUD entram no catálogo fonte
**110 / 137**, com notificação da gravação ligada ao SSE nativo. Regressão:
**2.125 testes em 261 arquivos**. Build e validação física aprovados (35,49 s).
Pacote `dist/electron-native-diagrams-20261007/win-unpacked`, ASAR
`1b6ea965b527428ba638820aa052b6b15224142b210d10e5fb0c4abf9b2627b6`, aprovado
na matriz de **305,35 s**, **56 checkpoints**, zero replay e nenhum Electron
de teste restante. Smoke, legado (**22,03 s**) e RAG direto (**25,32 s**) aprovados.
Fonte congelada `scratch/harness-candidates/2026-10-07T07-21-31-605Z`, manifesto
`c031cc7fed6900c6b2f902e58fd5b9910b318042881ca70999803d49a104a70d`.

A fonte posterior habilita `diagram_export` (**111 / 136**) com renderizador
Electron descartável e offline, sem APIs do aplicativo, preload ou acesso aos
arquivos do projeto. O worker recebe a imagem, valida formato/tamanho e cria
o arquivo sob a permissão do filesystem. A criação é exclusiva: um novo
`output_name` permite exportar outra revisão sem sobrescrever imagens existentes.
PNG tem dimensões limitadas antes da rasterização; SVG e PNG têm limite de 8 MiB.
Cancelamento RPC aguarda o encerramento do renderizador. Novos arquivos binários
são registrados como opacos no snapshot, sem conversão destrutiva para UTF-8.
Os bridges coder e Company estão ligados; isso não certifica árvores Company
no Rust. Build aprovado; ensaio físico `native-diagram-export-physical-r3/report.json`
aprovado em **36,38 s**, com SVG/PNG reais, nome alternativo, preservação de
imagem existente e quatro cancelamentos de inicialização encerrando as janelas.
Nenhum erro de renderer nem Electron de teste restante. PNG também inspecionado
visualmente. O primeiro ensaio encontrou o diretório de assets ausente no caminho
compilado de desenvolvimento; o segundo produziu imagens, mas foi reprovado pelos
erros de service worker. A resolução do bundle e a opção `pwa=0` corrigiram essas
falhas; os relatórios anteriores permanecem como evidência. A primeira
regressão apontou o teste que exigia o contrato antigo sem effect boundary;
foi substituído por rejeição de lease revogada e verificação do destino exato.
Regressão atual: **2.133 testes em 264 arquivos**, além do teste Node do build.
Pacote de **111 ferramentas** aprovado:
`dist/electron-native-diagram-export-20261007/win-unpacked`, ASAR
`06becee111f7fdfab6b92d18f096476ecd5e25417d2e8b8f42b4b9fa18414456`.
Matriz `native-diagram-export-packaged/report.json`: **318,12 s**, **56 checkpoints**,
zero replay e nenhum Electron de teste restante. Legado (**20,04 s**) e RAG direto
(**24,53 s**) aprovados. O primeiro smoke não conseguiu inicializar o subprocesso
GPU no sandbox; o smoke de execução com os subprocessos permitidos passou
(`native-diagram-export-release-smoke-r2.txt`). Fonte congelada
`scratch/harness-candidates/2026-10-07T07-54-18-607Z`, manifesto
`8d87a884a55aec02786d4abef715564ad7e345a270121af2adb8aaa00b823ed1`.

### Objetivos de sessão — fonte em validação

`create_goal`, `get_goal` e `update_goal` elevam a fonte a **114 / 133**.
A alteração do objetivo é atribuída à chamada e incluída no resultado que o
journal Rust confirma. O adapter não grava uma segunda transcrição legada.
Leitura na attempt usa estado local; histórico e painel usam projeção incremental
dos resultados confirmados. Conteúdo sem terminal confirmado não altera a projeção.
No-ops preservam a geração e a revisão; argumentos têm limites e validação estrita.
Gravações administrativas pelo writer legado são recusadas quando já existe
objetivo nativo. Essa fronteira ainda exige certificação de fallback entre gerações.
Build e **2.158 testes em 268 arquivos** passaram. A primeira regressão teve
timeout no carregamento do driver MSSQL enquanto o build também rodava; a
reexecução completa sem build concorrente passou, sem aumentar o timeout.
Ensaio `native-goals-physical/report.json` aprovado em **47,50 s**: criação,
no-op, leitura pelo painel/API, reinício sem rollout ativo e conclusão em nova
attempt Rust, preservando a geração. Nenhum erro de renderer ou Electron de teste
restante. O teste incremental também confirma que conteúdo sem terminal não
publica objetivo e que leituras aquecidas não releem payloads anteriores.
Pacote **114** aprovado: `dist/electron-native-goals-20261007/win-unpacked`,
ASAR `17d7f71f9b278a60da1e43d229590d1bbea17a70164a2c78008d5d8543c45252`.
Fonte congelada `scratch/harness-candidates/2026-10-07T08-20-00-086Z`, manifesto
`7b6f4df0bbd3111576821bf7a8f383f2548bbfe43992cec2019f3e21a8521f07`.
Smoke, legado (**18,51 s**) e RAG direto (**28,92 s**) passaram; nenhum Electron
de teste restante. Este pacote ainda usa o dashboard anterior à correção do replay.

O primeiro ensaio da matriz empacotada recuperou 57 checkpoints e o objetivo,
mas falhou na nova attempt com `WORKSPACE_RUNTIME_CONFLICT`: compartilhava o
projeto com cenários que deixam efeitos incertos. A barreira permaneceu intacta;
o fixture de objetivos ganhou projeto próprio. Evidência original preservada em
`native-goals-packaged/report.json`. A reexecução `native-goals-packaged-r2` passou
em **317,69 s**, com **57 checkpoints**, zero replay de provider, retomada e
conclusão do objetivo confirmadas e nenhum Electron de teste restante.

### Descoberta e replay da interface — pacote aprovado

`capability_catalog`, `find_tools` e `expand_toolset` levam a fonte a **117 / 130**.
O port nativo fornece o digest e a visibilidade da attempt admitida. A descoberta
não promove ferramentas ausentes, não atualiza um registry selado e verifica
dependências visíveis antes de hidratar skills. Expansão informa quando a família
já está exposta; não inventa mudanças de permissão ou promete ativação futura.
Busca e expansão usam barreiras sequenciais porque o legado pode promover pins.
O catálogo reutiliza a projeção selada; inputs, cursores e instruções têm limites
explícitos. Instruções maiores que 40.000 caracteres indicam `get_skill_content`
em vez de entregar uma instrução cortada silenciosamente.

O dashboard ignora `diagram_export_request` histórico e removeu o listener que
gravava imagens ao receber o evento. A toolbar continua exportando por ação do
usuário; a ferramenta usa o renderizador sob autoridade do executor. Também foi
garantida identidade distinta para objetivos criados no mesmo tick do relógio.
Build completo e **2.168 testes em 269 arquivos** aprovados. O helper de dois testes
novos tinha tipo incompleto para `parallelSafe`; corrigido antes desse build.
`native-discovery-physical/report.json`: **72,40 s**, catálogo paginado, rejeição de
agente não admitido, objetivos após reinício, SVG/PNG e cancelamentos aprovados;
nenhum erro de renderer ou Electron de teste restante. Benchmark sintético de
1.000 ferramentas, 25 amostras aquecidas com resposta idêntica: mediana **0,273 ms**
para reprojetar o catálogo e **0,120 ms** com cache. É uma redução pequena e local,
sem equivalência com aceleração total do agente ou com os gates p95 de produção.

Pacote **117**: `dist/electron-native-discovery-20261007/win-unpacked`, ASAR
`e704c1b23ef2dd781a2761555a629c9d5acb03c0c58ca3b115a154d6014084c3`.
Fonte congelada `scratch/harness-candidates/2026-10-07T08-39-48-874Z`, manifesto
`103ba5f358e59f9481cef3b2973b544f21d5b620aee2acd379a22fe11ded6f6a`.
`native-discovery-packaged/report.json` passou em **327,04 s**: **58 checkpoints**,
zero replay de provider, descoberta e objetivos retomados, nenhum Electron de
teste restante. Smoke aprovado; legado em 28,12 s e RAG direto em 30,97 s.
São execuções locais com provider determinístico, não certificação p95.

### Notas, planos e histórico — fonte em validação

`read_plan`, `save_note`, `list_notes`, `recall_investigations` e
`recall_conversation` levam a fonte a **122 / 125**. A leitura de planos preserva
erros de armazenamento; notas têm páginas por offset vivo e sete categorias.
A seleção limita a memória hidratada, mas ainda varre os arquivos: não é um
índice persistente. Investigações retornadas por IDs são hidratadas diretamente
sem carregar todos os textos do projeto; a busca lexical também limita a janela
retida. Cancelamento explícito alcança o bridge e a consulta de embeddings.

Notas são atualizadas sob a fila de mutação da sessão, por título e operação
atribuída. O writer verifica autoridade imediatamente antes de publicar o arquivo,
inclusive em retries de rename do Windows. Falha depois do envio da gravação tem
resultado incerto, sem repetição automática. O painel recebe a atualização após
o resultado nativo confirmado. A projeção de contexto recarrega somente notas,
sem reconstruir todo o Drive. Estado legado inválido de objetivo só falha quando
uma ferramenta de objetivo é chamada; budgets fracionários antigos são preservados.

**163 testes focados e 2.220 testes amplos em 275 arquivos passaram**, com build.
`native-session-data-physical-r2/report.json` passou em **72,94 s**: plano aprovado
e capítulos legados preservados, paginação, atualização sem duplicata, investigações,
reinício e nova leitura; zero replay, nenhum erro de renderer ou Electron restante.
O primeiro fixture criou a sessão depois do startup sem atualizar o catálogo e
recebeu 404 antes de chamar as ferramentas; a repetição faz a descoberta no startup
normal. Essa falha permanece em `native-session-data-physical/report.json`.

Benchmark com 1.000 investigações de 16.000 caracteres, oito resultados idênticos
e cinco amostras aquecidas: hidratação integral **48,74 ms** de mediana, **1.000
arquivos / 16.656.025 bytes** por consulta; leitura dos IDs **4,16 ms**, **8 arquivos /
133.248 bytes**. `native-session-data-benchmark-r2.json` verifica as contagens.
A primeira instrumentação não atualizava imports ESM e registrava zero leituras;
foi rejeitada e corrigida. Não são resultados de provider ou p95 de produção.
Certificação do novo pacote ainda pendente: o pacote validado permanece o de
117 ferramentas; nenhuma dessas etapas atualizou a instalação do usuário.

O build também passou a reescrever aliases apenas nos arquivos emitidos pelo
programa TypeScript. A varredura recursiva anterior incluía candidatos Electron
e bundles antigos dentro de `dist`. O teste usa imports transitivos excluídos do
glob inicial, declarações, execução repetida e um pacote congelado que deve
permanecer intacto. A execução local visitou **4.453 arquivos em 33,81 s**; não é
medida de latência do agente nem comparação estatística do build.

No mesmo checkout, o RPC MCP preserva cancelamento do chamador, limita JSON a
8 MiB e aguarda o fechamento do stream. Memória e busca não iniciam fallback
após cancelamento. O backend HTTP propaga o sinal de memória, e buscas vazias
contam arquivos por SQL. A deduplicação de memória cacheia tokens apenas dentro
da consulta, preservando a comparação e a autoridade dos resultados. Testes
focados de transporte/memória: 128 aprovados. Benchmark sintético, quatro
amostras por cenário e mediana das três aquecidas, com IDs retidos iguais:
20 candidatos **70,84 / 4,70 ms**, 60 **646,11 / 18,64 ms**, 120 **2.755,80 /
57,77 ms** antes/depois. Evidências: `native-memory-dedupe-before.json` e
`native-memory-dedupe-after.json`. Isso mede deduplicação isolada, não latência
total de memória nem percentis de produção.


### Aliases MCP de documentação — checkout em validação

Os três aliases agora funcionam também no processo stdio independente, por FTS
local e páginas SQLite limitadas. A navegação é compartilhada com o worker do
agente; HTTP preserva seu backend configurado. Busca stdio limita a hidratação
do corpo a 480 pontos de código por candidato e informa o modo lexical.
Seções, caracteres, vizinhos e outlines transportam omissões e recuperação;
IDs fracionários e cursores inválidos falham explicitamente. Sinais de request
são passados e uma resposta após cancelamento não é publicada.

A primeira conexão de uma base nova agora cria o índice FTS de documentação
após as migrations. Índice derivado ausente é reconstruído com os dados atuais;
aberturas normais não contam todo o corpus. Testes cobrem Unicode, páginas
finais, escopo de projeto, índice ausente e cancelamento: 88 focados e **1.891
na regressão ampla, em 229 arquivos**. Typecheck aprovado. Catálogo fonte:
**92 / 155**. Build e fluxo físico aprovados: `native-mcpdocs-physical-r2/report.json`,
31,55 s, busca FTS no processo MCP independente, recuperação das páginas finais
e nenhum processo Electron de teste restante. A primeira execução do fixture
omitiu a flag de desenvolvimento e falhou antes de abrir o aplicativo; corrigida
na segunda execução. Validação empacotada pendente.


### Consultas estruturais MCP — pacote validado

Visão geral, pulso, arquivos recentes, dependências e dependentes usam páginas
de até 500 metadados e agregações no SQLite. Contagem e página compartilham
transação de leitura. O resumo não hidrata arquivos ou snapshots completos;
overview compacto e completo preservam continuação e metadados de omissão.
Os transports MCP passam o sinal por request, sem gravá-lo no contexto global.
Cinco contratos de leitura independentes entram no catálogo Rust: **89 / 158**.
Regressão ampla: **1.880 testes em 228 arquivos**; typecheck aprovado. O
refinamento do cache passou em mais 23 testes focados (incluem regressões já
contadas), verificando invalidação por outra conexão e cópia defensiva. A busca
de compilador em sandbox POSIX no host Windows foi corrigida e passou em sete
testes de diagnóstico. Build e fluxo físico final aprovados
(`native-index-build-r2.txt`, `native-index-physical-r3/report.json`): 554 arquivos,
553 dependentes, recuperação do final das páginas, quatro checkpoints sem
replay e nenhum processo Electron restante. O primeiro fixture falhou por usar
`require` global no Electron ESM; a carga do fixture foi corrigida.

Benchmark SQLite isolado, cache aquecido e cinco amostras por consulta
(`native-index-benchmark-final.json`): com 50 mil arquivos, listar os recentes
teve mediana de **83,39 ms antes / 10,24 ms depois**, hidratando cerca de
28,18 MB / 2,17 KB respectivamente. O resumo agregado inicial revelou 253 ms
na primeira versão; materializar expressões uma vez e cachear por
`data_version` + `total_changes()` reduziu a consulta inicial para **75,48 ms**,
com mediana aquecida de **0,0125 ms**. O cache guarda no máximo 32 resumos pequenos
por conexão, não oculta edições por TTL e não devolve objetos internos mutáveis.
São medidas sintéticas locais, não percentis de produção nem aceleração total
da conversa.

Pacote isolado aprovado em **246,02 s**, com 47 checkpoints recuperados sem
replay e nenhum processo Electron de teste restante. Fallback legado passou
em 20,29 s; smoke do ASAR, incluindo terminação dos workers, aprovado.
Evidências: `native-index-packaged/report.json`, `native-index-legacy/report.json`
e `native-index-release-smoke.txt` em `scratch/harness-20261003`.
Pacote: `dist/electron-native-index-20261007/win-unpacked`.
ASAR SHA-256: `5322b09e031505eb8b7cafc561072b38689e0317341a429924029cd54711d935`.
Fonte: `scratch/harness-candidates/2026-10-07T03-42-38-555Z`, manifesto
`7a994034962ac49cd17bffa01ea0f36f608fd91db2dd582ee804f7e58e6513b1`.
Default legado e instalação preservados; provider local determinístico,
sem certificação de percentis nem provider real.

### Navegação de código — pacote validado

As quatro ferramentas LSP usam um worker TypeScript privado da attempt, com
limite de heap, prazo de 30 segundos e encerramento aguardado após cancelamento.
Consultas sequenciais preservam o programa aquecido; configurações, dependências
e arquivos fora do tsconfig voltam a ser observados. Falhas do compilador não
viram respostas vazias. Resultados têm páginas de até 500 itens com total e
continuação explícitos. Outras linguagens propagam cancelamento até o backend
por ID de leitura e bridge, sem encerrar servidores compartilhados. O catálogo
fonte chega a **84 / 163**. Regressão ampla: **1.871 testes em 227 arquivos**;
mais 12 testes de regressão do serviço do editor aprovados. Typecheck e build
aprovados. O fluxo físico passou (`native-lsp-physical/report.json`): paginação
de mais de 550 referências, definição, hover, correções somente na dependência
e em arquivo fora do tsconfig, cancelamento, cinco checkpoints sem replay e
nenhum processo Electron restante. O probe direto verificou `threadId === -1`
após fechamento e cancelamento do worker real (`native-lsp-worker-probe.txt`).
O pacote `dist/electron-native-lsp-20261007/win-unpacked` passou a matriz
integrada (`native-lsp-packaged/report.json`, 233,20 s), 46 checkpoints sem
replay e nenhum processo Electron de teste restante. ACK de cancelamento LSP:
59 ms nessa execução, sem extrapolar para percentis certificados. Smoke do
ASAR aprovou o worker TypeScript real e seu encerramento; fallback legado
aprovado (`native-lsp-legacy/report.json`, 20,56 s).
ASAR SHA256 `dfd66cc2381e98a71b751874b092cab629c9d22204402f8793d5db0bba8e715f`.
Fonte `scratch/harness-candidates/2026-10-07T03-22-09-195Z`, manifesto
`cb3d942dddc13f80cec69f4b78954dea4ff86a373d640bfc179d59c718f0d6a4`.
O pacote contém 84 nomes e não inclui as cinco consultas estruturais posteriores.
Testes usam provider local; instalação e runtime padrão continuam preservados.

### Diagnóstico e recursos MCP — pacote validado

`get_diagnostics` executa pelo shell port assíncrono; no Rust, compilador e
descendentes pertencem ao Job da attempt. Cancelamento aguarda encerramento.
O contrato é sequencial e de execução, pois compiladores podem executar scripts
do projeto. O cache por mtime do arquivo foi removido: mudanças em dependências
e configuração voltam a ser verificadas. TypeScript usa a dependência instalada
no projeto/workspace, sem downloads implícitos; fallback Python analisa sintaxe
sem importar o arquivo nem escrever `__pycache__`. Falhas e timeout não aparecem
como diagnóstico limpo; omissões de stdout/stderr são explícitas.

`mcp_list_resources` e `mcp_read_resource` propagam sinal de cancelamento e prazo
ao SDK. O catálogo preserva cursores e o servidor publica páginas de 100 entradas
vinculadas à revisão visível. Falhas de transporte/leitura não viram catálogo
vazio ou falso 404. Listar recursos conta arquivos no SQL, sem materializar
todas as linhas. A regressão ampla passou com **1.857 testes em 224 arquivos**
(`native-inspection-all-tools.txt`); typecheck aprovado.
Catálogo dessa etapa: **80 habilitadas / 167 pendentes**. Build e fixture
físico aprovados (`native-inspection-build.txt`, `native-inspection-physical-r2/report.json`):
TypeScript real detectou o erro e confirmou a correção feita somente na
dependência; leitura MCP retornou o resumo do projeto. O cancelamento aguardou
a criação observada do checker e seu filho e confirmou ambos encerrados. Cinco
checkpoints foram recuperados sem replay. A primeira execução do fixture
cancelava por tempo fixo antes de obter os PIDs; o teste foi corrigido para
esperar evidência de processo iniciado, sem alterar o comportamento do produto.

O pacote `dist/electron-native-inspection-20261007/win-unpacked` passou a matriz
integrada (`native-inspection-packaged/report.json`), com 44 checkpoints recuperados,
zero chamadas de provider repetidas e nenhum processo Electron de teste restante.
ACK do checker: 23,4 ms nesta amostra, com pai e filho encerrados. Fallback legado
aprovado (`native-inspection-legacy-r2/report.json`, 18,51 s) e smoke do ASAR
aprovado (`native-inspection-release-smoke-r2.txt`). Os primeiros lançamentos
restritos falharam na inicialização do processo GPU; repetição fora do sandbox
usou o mesmo pacote e perfil isolado. Provider local determinístico, sem
certificação de percentis ou provider externo.
ASAR SHA256 `6d25cd0e0be5178a4f4d00de8aed5b894ffee7bb1e3ec9551fc211451e123155`.
Fonte congelada `scratch/harness-candidates/2026-10-07T03-00-58-430Z`, manifesto
`51bff7482d3e2a578d8e76ddf93eda764cf78dedaf7dd71f762a91a4b6f57d2a`.
Esse pacote contém 80 ferramentas; as quatro LSP posteriores ainda não fazem
parte dele. Runtime padrão legado e instalação do usuário preservados.

### Documentação indexada — pacote Windows validado

`rag_search_docs`, `rag_read_doc` e `rag_doc_outline` estão no catálogo de
desenvolvimento. Busca e navegação usam a conexão WAL do worker, sem enviar
as leituras estruturais ao Electron main. O SQL seleciona colunas e páginas
limitadas; documentos grandes oferecem offsets para recuperar todo o corpo,
incluindo Unicode. As ferramentas propagam cancelamento e não confundem uma
página de seção com uma seção completa. Passaram 1.823 testes na regressão
ampla (`native-docs-all-tools.txt`).
Catálogo fonte: **77 habilitadas / 170 pendentes**. Build e fixture físico
aprovados (`native-docs-build.txt`, `native-docs-physical/report.json`): busca
por projeto, corpo de 66 mil caracteres, páginas de seção e índice, quatro
checkpoints recuperados sem replay e nenhum processo rastreado restante.
Pacote: `dist/electron-native-docs-20261006/win-unpacked`, ASAR SHA256
`3c0848092e01414d320e0f8c233f5c013f5c42114af4f740a0a7bdcf08feed5f`.
A matriz combinada recuperou **42 checkpoints** sem replay e sem processos
rastreados restantes. Fallback legado e smoke do ASAR aprovados. Provas:
`native-docs-packaged/report.json`, `native-docs-legacy/report.json`,
`native-docs-release-smoke.txt`. Snapshot:
`scratch/harness-candidates/2026-10-07T02-43-15-707Z`, manifest SHA256
`ae16204a3a496f7af83724469380e9b3aab2d7435b9620133aaa1ee28961095a`.
Esse pacote contém **77 nomes / 170 pendentes**, sem as alterações posteriores
de diagnóstico e recursos MCP. A instalação e o padrão legado seguem preservados.

### Web pública — pacote Windows validado

`web_fetch` e `web_search` usam GETs pertencentes à attempt, com DNS validado
e endereço fixado no socket. Cada redirect é verificado; credenciais de busca
não cruzam origens. Respostas comprimidas têm limites de bytes recebidos e
descomprimidos. Erros HTTP fecham imediatamente o corpo, mesmo se o servidor
não o terminar. Cancelamento aguarda fechamento de socket e queries DNS.

A conversão HTML/JSON e o parsing das buscas ocorrem em worker com teto de
memória e prazo, encerrado antes de concluir a chamada. O cache tem limite
agregado de 8 MiB, além dos tetos por entrada e quantidade, e separa sessões.
Filtros de domínio conferem hostname/subdomínio, sem aceitar uma coincidência
na query ou em nome enganoso. Cancelamento não dispara busca de fallback.

O contrato explícito de leitura permite lotes no scheduler Rust sem conceder
fence de mutação. Foram aprovados 1.794 testes em 214 arquivos na regressão
ampla (`native-web-all-tools-r2.txt`), além de testes focados de transporte no
Electron (`native-web-electron-transport.txt`) e contrato (`native-web-contract-r2.txt`);
as contagens se sobrepõem. Build com teste real dos workers passou; a compilação
final registra a correção das faixas IPv4 em `native-web-build-final-ts.txt`.
Pacote: `dist/electron-native-web-20261006/win-unpacked`, ASAR SHA256
`f3b1261078e0f2dcd65f50734aba6073302c5b3f32b42c7fe27e8a506d619a89`.
A matriz combinada recuperou **41 checkpoints**, sem replay do provider e
sem processos rastreados remanescentes. O fixture HTTPS confirmou sobreposição
de transferências, resultado rápido antes da ferramenta lenta e cancelamento
com sockets encerrados. ACK: 20,7 ms, uma amostra, não p95. Fallback legado e
smoke do ASAR aprovados, incluindo conversão web em worker e QuickJS.
Provas: `native-web-packaged/report.json`, `native-web-legacy/report.json`,
`native-web-release-smoke.txt`. Snapshot:
`scratch/harness-candidates/2026-10-07T02-24-55-707Z`, manifest SHA256
`de8fa081ba449bf45af6e627656b2e138c8c7ed01e2ad82a84a681c5d8b726cb`.
Esse pacote contém **74 nomes / 173 pendentes**; não inclui as alterações
posteriores de documentação. O provider e os endpoints foram fixtures locais,
com TLS validado. Não foi instalado no PC; o padrão segue legado.

### HTTP nativo — pacote Windows validado

`http_request` usa conexões pertencentes à attempt, preserva o jar da sessão
e confere autoridade antes do envio físico. O timeout cobre o tempo total,
inclusive respostas que gotejam bytes. A conclusão aguarda fechamento do
socket; POST com confirmação perdida mantém resultado incerto e impede
continuação automática, inclusive após restart. GET/HEAD/OPTIONS mantêm risco
de leitura; as chamadas são sequenciais.

Passaram 37 testes focados, 1.599 testes em 189 arquivos na regressão ampla,
build e typecheck. As contagens se sobrepõem. O fixture HTTP no Electron
comprovou login entre attempts, reset de cookies, limite de resposta, status
500, cancelamento e escrita incerta executada uma única vez. Todos os sockets
foram encerrados. Provas: `native-http-focused.txt`, `native-http-all-tools.txt`,
`native-http-physical/report.json`.

Pacote isolado: `dist/electron-native-http-20261006/win-unpacked`. ASAR SHA256
`d35265a4eb60a17cbbf2a616c90722f0d3e85c65c04dc872e5cb33e9f65b715c`.
A matriz combinada recuperou **34 checkpoints**, sem replay do provider e sem
processos rastreados remanescentes. ACK de cancelamento HTTP: 29,8 ms, uma
amostra, não p95. Fallback legado aprovado. Provas: `native-http-packaged/report.json`
e `native-http-legacy/report.json`. Snapshot:
`scratch/harness-candidates/2026-10-07T01-28-27-776Z`, manifest SHA256
`b97c2dbe469f9f24ad92c136397e64060c373bdb8e3bd61a00b0bffffab6ae31`.
Esse pacote contém **65 nomes**, não inclui as alterações posteriores de API.
Não foi instalado no PC; o padrão segue legado.

### Coleções de API — pacote Windows validado

As sete ferramentas usam isolamento por projeto, paginação de resumos e
checagem do request/ambiente imediatamente antes do envio. Leituras de anexos
são limitadas e verificam o caminho físico, incluindo symlinks/junctions.
Uma coleção para na primeira escrita sem confirmação. O login é preservado
entre attempts da mesma sessão; atualizações de variáveis do script de uma
requisição são persistidas no ambiente escolhido.

O módulo isolated-vm existente não possuía binário para Electron 42.5.0. Após
corrigir localmente as chamadas incompatíveis, o linker comprovou ausência
dos símbolos C++ necessários. O executor foi substituído por QuickJS 0.32.0
em WebAssembly, em worker próprio, com limites de memória/tempo/entrada, sem
objetos Node no realm do script. O retorno e o cancelamento aguardam término
físico da thread. A superfície pm.* foi preservada e ganhou atribuição de
method/url/body com a mesma proteção da API get/set. Callbacks de teste async
são recusados para não registrar falso sucesso. Pre-script com erro impede
o envio. O patch C++ experimental não integra o candidato final.

Passaram **211 testes focados em 23 arquivos**, **1.756 testes em 210 arquivos**
na regressão ampla e **31 testes em cinco arquivos no Node 22**; os totais se
sobrepõem. Build passou, incluindo criação e execução do worker/WASM pelo
Electron. O inventário ficou desatualizado durante as edições; foi regenerado
e sua verificação separada passou. Provas: `native-api-focused-r3.txt`,
`native-api-all-tools.txt`, `native-api-inventory-check.txt`,
`native-api-node-runtime.txt`, `native-api-build.txt`.

`native-api-physical/report.json` comprovou importação, listagem paginada,
consulta, edição, verificação e execução de requisição/coleção, login entre
attempts, cancelamento de rede e loop de script, ACK perdido e restart.
Oito checkpoints recuperados, zero replay e zero processos rastreados
remanescentes. ACK de cancelamento: rede 22,7 ms e script 21,6 ms, amostras
individuais, não p95. Catálogo fonte: **72 habilitadas / 175 pendentes**.
O pacote `dist/electron-native-api-20261006/win-unpacked` passou na matriz
combinada: **39 checkpoints** recuperados sem replay, zero processos
rastreados remanescentes, todas as conexões de API encerradas. Cancelamento
de rede: 28,8 ms; script: 19,0 ms (amostras únicas, não p95). Fallback legado
aprovado. Renderização, deep link, indexador e QuickJS executado dentro do
ASAR passaram. O verificador de dependências recebeu parser de JavaScript
para não confundir `obj.require('active')` com importação: 2.465 módulos,
39 pacotes, nenhuma dependência ausente. Provas: `native-api-packaged/report.json`,
`native-api-legacy/report.json`, `native-api-release-smoke.txt` (falso positivo
original da análise estática) e `native-api-closure-r2.txt` (correção aprovada).

ASAR SHA256: `08e05692eaafbc49de51ef55b0c28ca45a4f54c40ff85231abea5dff83001d25`.
Snapshot: `scratch/harness-candidates/2026-10-07T01-56-20-815Z`, manifest SHA256
`8a6a62fcc86a0c0a7d79ef7bccc2440ede45e5fe80f1eae6cd8fb65902b94a69`.
Este pacote contém 72 ferramentas; a integração posterior de web está em
validação no checkout. A instalação do usuário não foi alterada.

### Recuperação de resultados grandes no writer Rust — posterior ao pacote DB

`get_tool_output` está integrado ao catálogo nativo. O executor aguarda a
gravação do conteúdo antes de publicar seu identificador; uma falha de disco
após uma mutação conserva resultado incerto. O armazenamento da attempt usa
chunks de anexos pelo writer Rust, cache limitado e IDs pelo SHA256 completo.
Não grava esses resultados no bundle legado. A consulta explícita após restart
indexa uma fotografia validada uma vez, confere recibos/hashes e recusa grupos
parciais, corrompidos ou de outra sessão. Resultados antigos não ocupam o cache
de mídia do histórico. Paginação preserva UTF-16, limites e cursores existentes.

Passaram **82 testes focados em cinco arquivos** e **1.585 testes em 187
arquivos** na regressão ampla (totais com sobreposição). Build e typecheck
passaram. Provas: `native-output-tests-r2.txt`, `native-output-all-tools.txt`,
`native-output-build.txt`, `native-output-typecheck-final.txt`.

`native-output-physical-r2/report.json` comprovou o fluxo Rust/Electron: leu
um resultado de 280 KB, recuperou o trecho central omitido, alterou a fonte,
reiniciou o aplicativo e recuperou o conteúdo original pelo journal. Quatro
checkpoints foram recuperados sem replay. A nova execução usa opt-in Rust
explícito; desligá-lo continua permitindo leitura, mas impede retomar a sessão
com outro runtime. A primeira execução do fixture tentou continuar com opt-in
desligado e foi corretamente recusada. Nenhum processo rastreado permaneceu.
O snapshot `scratch/harness-candidates/2026-10-07T01-15-17-625Z` possui manifest
SHA256 `57b941f0003b1c85e9e56bc3935ca4d1b5bd55e31a6c7dd23c3b93236c0fd364`.
O pacote separado `dist/electron-native-output-20261006/win-unpacked` passou
na matriz combinada incluindo a recuperação após alteração da fonte/restart.
Recuperou **30 checkpoints**, sem replay do provider e sem processos de teste
remanescentes. ASAR SHA256:
`9d87a8183e9d79361121d680d4f4a65769d49b387541c2081d218f6e6dbc159c`.
Provas: `native-output-packaged/report.json` e fallback legado aprovado em
`native-output-legacy/report.json`. O pacote possui 64 nomes habilitados;
HTTP foi ligado posteriormente no checkout e ainda está em validação física.

### Bancos com conexões privadas da attempt — continuação de 2026-10-06

As quatro ferramentas `db_*` têm contrato nativo e conexões privadas da attempt.
A revisão da conexão é verificada contra o cadastro, segredos são resolvidos no
gateway com validação antes/depois da espera e operações em andamento permanecem
contabilizadas até o drain. Escritas continuam exigindo aprovação específica,
inclusive no modo irrestrito. A perda de confirmação bloqueia continuação e a
próxima ferramenta, conservando a lease para reconciliação.

SQLite executa em processo contido pelo Job Rust, fora do event loop do worker.
Leituras param após provar o limite; `RETURNING` de uma escrita é consumido até
o fim, retendo somente as linhas permitidas. O teste físico cancelou uma
agregação de um bilhão de linhas, confirmou o reap e preservou a escrita anterior.
Outro caso perdeu a resposta depois do commit: a linha permaneceu uma vez e o
processo terminou. Prova: `native-db-physical-process.txt` (dois testes físicos).

Redis serializa SELECT com o comando inteiro e recusa a execução após SELECT
falhar. Todos os erros do pipeline são verificados. O teste com ioredis 5.8.1
reproduziu uma promessa pendurada quando apenas `autoResendUnfulfilledCommands`
era desativado. Desativar também reconexão automática permite encerrar a conexão
e rejeitar a chamada sem repetir a escrita. `native-db-redis-client/report.json`
comprova os quatro casos com cliente real e servidor RESP local; não é uma
certificação de Redis remoto. Nenhum socket de teste permaneceu aberto.

Mongo usa cursores limitados/canceláveis e fecha-os explicitamente; agregações
com `$merge`/`$out` preservam a pipeline e são drenadas. PostgreSQL e MySQL
revalidam autoridade depois da aquisição/setup e descartam a conexão cancelada.
MSSQL e Oracle também verificam a fronteira física; falhas de close não são
mais ocultadas. Essas mudanças possuem testes de contrato, sem certificação
de servidores remotos dos seis engines.

Passaram **214 testes de drivers/tools** em 26 arquivos e **57 de contratos
nativos/segredos** em quatro arquivos (há sobreposição). Provas:
`native-db-regression-r4.txt` e `native-db-contract-tests-r2.txt`.
O build completo passou (`native-db-build-r2.txt`), seguido da correção Redis
compilada com `native-db-tsc-r4.txt` e resolução de aliases.

O fluxo físico do produto passou em `native-db-physical-r2/report.json`:
quatro ferramentas, dez chamadas no caso completo, quatro aprovações de escrita,
SQLite real, cliente Redis real, cancelamento de ambos, conexão emprestada
preservada e ACK perdido sem repetição antes/depois do restart. ACK de cancelamento
de 19,1 ms e 17,8 ms são amostras, não percentis. O primeiro teste expirou por
não responder à aprovação obrigatória; o fixture foi corrigido, sem alterar a
política do produto. Nenhum processo Electron rastreado permaneceu ativo.

A regressão ampla passou com **1.572 testes em 185 arquivos**
(`native-db-all-tools.txt`), com sobreposição aos testes focados. O snapshot
`scratch/harness-candidates/2026-10-07T01-02-31-592Z` possui manifest SHA256
`265ed94b2a064a79b270f44da7954c361792a7a0a54b0691d7280c593222bbb3`.

O pacote separado `dist/electron-native-db-20261006/win-unpacked` passou na
matriz combinada de bancos, preview, browser, arquivos, pesquisa, memória,
interações, MCP e PTY. Recuperou **29 checkpoints sem replay do provider**;
nenhum processo Electron/Chrome/MCP rastreado permaneceu. A confirmação de
cancelamento dos bancos levou 30,1 ms/20 ms nesta amostra. ASAR SHA256:
`2e772ded8a4bec6961ec32eec011ac07157e731941a0e9b716a11419476a3753`.
Provas: `native-db-packaged/report.json` e fallback legado aprovado em
`native-db-legacy/report.json`. Esse pacote contém 63 ferramentas habilitadas;
a recuperação nativa de resultados grandes foi implementada depois dele e
ainda está em validação. O gate de fronteira do legado foi reexecutado e
continua falhando, agora com **484 referências novas**: não foi ampliada a baseline.

A certificação de todos os engines, SSH, plataformas e rollout permanece
aberta. Nenhum banco cadastrado pelo usuário nem o aplicativo instalado foi alterado.

### Navegador de pesquisa com autoridade nativa — continuação de 2026-10-06

As oito ferramentas `browser_*` atravessam o HostCapability com input selado,
identidade da attempt e validação de leases no host. Cada chamada física
revalida autoridade; requisições automáticas da página usam a validade da
attempt, separada do prazo da ferramenta que abriu o contexto. Contextos
anônimos possuem dono opaco; limpeza não fecha o Chrome compartilhado.
Cancelamento, encerramento durante autorização e falhas de limpeza impedem
publicação tardia ou liberação indevida. Ação com resposta perdida mantém
resultado incerto e bloqueia repetição automática.

Passaram **117 testes focados** e **20 de autoridade/cleanup** (com sobreposição),
além da regressão ampla de **1.533 testes em 177 arquivos**. O build completo
passou. Provas sob `scratch/harness-20261003`: `native-browser-focused-r2.txt`,
`native-browser-ownership.txt`, `native-browser-all-tools.txt` e
`native-browser-build-r2.txt`.

O teste físico `native-browser-physical/report.json` executou as oito ferramentas
através do produto Rust/Electron e Chrome real: preenchimento, Enter, clique,
extração, snapshot, screenshot recebido pelo provider e fechamento. Validou
cancelamento, POST bloqueado, contexto anônimo encerrado e navegador emprestado
preservado. Uma ação cujo ACK foi perdido ocorreu uma vez; a próxima escrita e
a continuação foram bloqueadas, inclusive após restart. Recuperou seis
checkpoints sem replay do provider. Os seis PIDs do Chrome de teste e os quatro
do Electron foram encerrados. HTTPS e DNS foram fixtures locais explícitas;
este teste não certifica navegação em sites externos nem o container Chrome.

O snapshot está em `scratch/harness-candidates/2026-10-07T00-17-45-301Z`,
manifest SHA256 `aba93dd13f500ff7b66b896530493b8846ec59db8469f85c8a903d913cb21da8`.
O pacote separado `dist/electron-native-browser-20261006/win-unpacked` passou
na matriz completa Rust, incluindo browser, preview, imagens, pesquisa,
memória, interações, MCP público/stdio e comandos PTY. Recuperou **25 checkpoints**
sem replay do provider; preview e browser conservaram a barreira após ACK perdido.
Nenhum processo de teste restou. ASAR SHA256:
`ab6996d36817d5d4bb8b51390a1433b65301657bafb213a971961f85508f80fd`.
Prova: `native-browser-packaged/report.json`. O fallback legado também passou
no mesmo pacote (`native-browser-legacy/report.json`). Nenhum instalador foi executado.
O pacote inclui as correções de resultado incerto dos bancos abaixo, mas não
inclui as alterações posteriores nos drivers SQLite, Redis e Mongo.

### Preview com autoridade nativa — continuação de 2026-10-06

As 22 ferramentas `preview_*` agora atravessam a admissão Rust e o bridge do
worker com a identidade da attempt e o input selado. O host reconstrói os
argumentos físicos, verifica as duas leases e revalida autoridade antes de cada
comando CDP, navegação, criação e redimensionamento de janela. Identidades opacas
impedem outro escopo de fechar a janela; cancelamento durante a autorização e
fechamento antes de uma resposta tardia também são cercados.

O servidor auto-iniciado usa o Job nativo, saída limitada e confirmação de reap
do processo e descendentes. Servidores do usuário podem ser reaproveitados
quando pertencem ao mesmo checkout, mas não são encerrados pela attempt. Um
worktree não herda o servidor do checkout-base. A liberação da lease aguarda
janelas e servidores; resultado incerto conserva a barreira de reconciliação.
O fechamento destrói a janela mesmo quando a página tenta vetar `close()`.

Os **132 testes focados** passaram. O fluxo físico não empacotado executou as
22 ferramentas, entregou screenshot ao provider, concluiu e cancelou uma espera,
com os quatro PIDs de servidor/filho encerrados e nenhuma janela ou processo do
aplicativo remanescente. Provas: `native-preview-final-tests.txt` e
`native-preview-physical-r2/report.json` sob `scratch/harness-20261003`.
A primeira execução falhou porque o teste exigia `127.0.0.1` e o resolvedor
retornou `localhost`; o teste foi corrigido e a falha foi preservada.

O pacote separado `dist/electron-native-preview-20261006/win-unpacked` passou
na matriz Rust completa com as 22 ferramentas preview, ACK perdido após efeito,
cancelamento e restart. Foram recuperados **22 checkpoints**, sem replay do
provider. O efeito remoto ocorreu uma vez; a próxima escrita e a continuação
ficaram bloqueadas antes e depois do restart. Os seis PIDs de servidor/filho e
as janelas de preview foram encerrados. ASAR SHA256:
`6df23855faa125b39dbead0d57e78ad3ac5312f63f2ff26929bd17bfd52920e9`.
Prova: `native-preview-packaged/report.json`. O snapshot de código está em
`scratch/harness-candidates/2026-10-06T23-54-28-014Z` (manifest SHA256
`7cfa632905385763815ef597d90ddbb4aa5cb7960552580a8ae7d59fb19207d7`).
O fallback legado também passou no mesmo pacote, sem processos órfãos:
`native-preview-legacy/report.json`. Nenhum instalador foi executado.

A regressão ampla passou com **1.497 testes em 175 arquivos**, além dos
cenários HTTP focados; os totais têm sobreposição com a suíte de 132 e não devem
ser somados. Prova: `native-preview-all-tools.txt`. O gate geral de tamanho
continua com 56 violações; não houve ampliação de allowlist.

Estas alterações ainda não fazem parte do instalador `CodeStudio-Tools-Candidate`
descrito abaixo. Consultas CDP e inspeção do dashboard foram extraídas para
`queries.ts` e `inspector.ts`, reduzindo o serviço principal a menos de 500 linhas.

### Escritas de bancos — posterior ao pacote de preview

`db_query` e `db_command` preservam resultado incerto após uma falha ou um
cancelamento de escrita já despachada. O ledger bloqueia a repetição; consultas
de leitura canceladas permanecem distintas. Cancelamento durante aquisição não
inicia uma escrita tardia. Drivers que ignoram o sinal podem concluir em segundo
plano: isso não comprova rollback e ainda impede habilitar bancos no catálogo
nativo sem a integração física por driver.

Comandos com formas Mongo e Redis simultâneas são classificados como escrita,
evitando usar a interpretação de leitura de um engine para liberar mutação no
outro. Passaram **213 testes em 23 arquivos**, incluindo SQLite real e oito novos
casos de resposta perdida/cancelamento/classificação. Provas: `db-outcome-tests.txt`
e `db-outcome-regression.txt`. Estas mudanças de bancos ainda não estão no pacote
de preview acima.

| Caminho | Problema reproduzido | Correção e alcance |
|---|---|---|
| `ToolRegistry` | Um sinal já cancelado ainda permitia iniciar o handler; cancelamento durante admissão de workspace também escapava. | Verificação antes da admissão e imediatamente antes do handler. Aplica-se às ferramentas registradas do Coder, Company, DocsAgent, chamadas aninhadas e adaptador HostCapability. Resultados de efeitos já confirmados são preservados. |
| Assistente de plugins | Aprovação recebida depois do cancelamento ainda iniciava a ferramenta seguinte; falha na confirmação encerrava o stream sem resultado da ferramenta. | Espera de aprovação cancelável, remoção dos listeners, falha estruturada e interrupção da fila antes de novos handlers. Texto contínuo é consolidado no histórico enviado ao provider: o teste de 10.000 deltas mantém um bloco de texto, preservando todos os eventos da interface e as fronteiras de tool calls. Não implica interrupção física de handlers que ignoram cancelamento. |
| MCP interno | Falhas de transporte sempre recomendavam repetir, inclusive após despachar uma mutação. | Contrato explícito para os 33 nomes internos, confrontado com as definições do servidor. Resposta perdida de mutação/contrato desconhecido produz `TOOL_OUTCOME_UNKNOWN` e bloqueia novo despacho pelo ledger. Leituras canceladas não recomendam retry. Apenas `search` e `grep_code` continuam explicitamente independentes. |
| Preview Electron e browser | Cancelamento durante o despacho podia ocorrer antes de registrar o listener. Erro síncrono na rotina de cancelamento podia interromper a resolução. | Helper comum registra o listener antes de despachar, trata falhas de cancelamento e remove listeners em sucesso/falha. Cobre as 22 ferramentas preview e oito browser através dos bridges. Cancelar RPC não comprova rollback de um efeito já executado. |
| Comandos de plugins | Fila de streaming sem limite e decodificação UTF-8 independente por pacote. | Pausa os dois pipes ao alcançar 1 MiB ou 256 frames pendentes; retoma abaixo de metade desses limites. Não descarta saída normal. Decoder preserva caracteres divididos entre pacotes; chamadas já canceladas não criam processos; retorno antecipado fecha os pipes. Buffers dos pipes e um pacote recebido são adicionais ao limite da fila. |
| `db_schema` | Listagem ou descrição de tabela lenta bloqueava o cancelamento e podia continuar a cadeia de inspeção. | Cancela a espera e ignora a resposta tardia; não inicia a próxima leitura. Drivers sem API de cancelamento de metadados podem terminar a leitura em segundo plano. Mantém paginação e expansão de uma única tabela. |
| Pool compartilhado de banco | Aquisições simultâneas criavam drivers duplicados. Conexão que terminava de abrir após `closeKey`/`closeAll` voltava ao pool. | Uma abertura por chave; encerramento invalida e aguarda a abertura pendente. Resultado tardio é fechado. Chaves independentes continuam concorrentes e uma falha permite nova tentativa. |
| Identidade de conexão do agente | Invalidar `agent:1:2` como prefixo também encerrava conexões `agent:1:20`, `agent:1:21` etc. | Aquisição por identidade exata; rotação continua usando `closeKey` para a conexão selecionada. |
| Inventário | Era possível esquecer ferramentas fora do catálogo nativo ou dos tiers usuais. | Scanner AST sem executar handlers ou ler credenciais. Cruza nomes do catálogo nativo e tiers; gera JSON/Markdown e oferece `--check` para detectar divergências. |
| Preview: resultado incerto | Resposta perdida de clique, digitação, navegação ou avaliação podia ser tratada como falha comum. | Bridge preserva `effectOutcome: unknown` após despacho e impede repetição automática pelo ledger. Falhas anteriores ao despacho e leituras mantêm sua classificação normal. |
| Preview: ciclo de vida | Janela em abertura podia aparecer depois do encerramento; duas operações do mesmo agente disputavam a página; falha ao parar servidor perdia sua identificação. | Fila limitada por janela, chaves independentes concorrentes, cancelamento por requisição e encerramento aguardando operações pendentes. Servidor iniciado pelo preview permanece identificado até confirmação de parada. |
| Browser de pesquisa | Aberturas concorrentes duplicavam conexões; cancelamento durante DNS/conexão/criação podia publicar contexto tardio. Snapshot materializava handles para a página inteira e extração transportava todo o texto. | Uma conexão pendente compartilhada, fila por sessão, contextos registrados antes de criar a página, fechamento confirmado e nova abertura bloqueada após falha de limpeza. Apenas a janela solicitada recebe handles; corte de texto ocorre dentro da página. |

## Persistência independente do executor

Os 63 módulos de implementação do fs-store agora pertencem a
`packages/session-storage/src/fs-store`. Os caminhos anteriores são reexports
de compatibilidade. Foram redirecionados 144 consumidores; formato dos journals,
leases e checkpoints foi preservado. Contratos de sessão, importação, limites,
policy shadow, snapshots e review também saíram do executor legado.

Os codecs e as transformações puras de compactação passaram para sete módulos
de `session-storage/src/compaction`. Invocação do provider e contabilização
continuam no executor. O store não importa o runner, os serviços ou o motor de
pipelines. O teste que verifica ausência de SQLite/dependências do executor
agora examina a implementação real, além da compatibilidade pelos caminhos antigos.

Isso reduz o acoplamento necessário à migração; não elimina por si só os custos
lineares de serialização do histórico nem conclui a retirada do legado.

## Validação desta rodada

- Reprodução anterior: quatro falhas no cancelamento do registry e três no
  assistente de plugins; depois, 33 testes focados aprovados.
- Suíte final reproduzível: **1.444 testes aprovados em 174 arquivos**, sendo
  1.425 em Electron e 19 em Node. Abrange tools do Coder, Company, DocsAgent,
  plugins, assistente de plugins, MCP, preview, bancos, registry, executor
  HostCapability e catálogo nativo. Executar `npm run test:tools`.
- Comandos reais de plugins em Node: **17 testes aprovados** incluindo controle
  de fila, saída grande com consumidor lento e caracteres UTF-8 divididos.
- Git em Node: **sete testes aprovados**. O mesmo arquivo apresentou `EPERM` na
  remoção de sua fixture ao executar via Electron; não alteramos permissões do
  produto para contornar o ambiente de testes.
- Preview/browser/bancos: **76 testes focados aprovados**, incluindo os novos
  cenários de cancelamento. Parte desses testes está incluída na regressão ampla;
  não somar os totais como se fossem testes distintos.
- MCP interno: **17 testes focados aprovados**, incluindo cobertura do contrato,
  ACK perdido, ausência de segundo despacho e cancelamento antes/depois do envio.
- Pool: três regressões reproduzidas antes da correção. **205 testes de banco
  aprovados em 22 arquivos**, incluindo seis cenários de ciclo de vida e uma
  regressão SQLite real para IDs que compartilham prefixo. Incluídos na suíte final.
- **TypeScript sem emissão aprovado**, inventário consistente e gate Rust de
  tamanho aprovado: 891 módulos de produção dentro do limite de 250 linhas.
- **Persistência e consumidores:** 268 testes aprovados em 42 arquivos cobrem
  storage, imports, compactação, Company, histórico HTTP e control plane. Depois
  da remoção da dependência cíclica de telemetria, seus três testes focados passaram.
- **Rust físico no Windows:** 21 testes aprovados em quatro arquivos cobrem
  conversa, arquivos, continuação e interação com processos reais.
- **Preview no pacote Windows:** os 22 handlers foram executados contra o
  Electron/CDP real, incluindo screenshot, refs, inputs, teclado, CSS, rede,
  storage e memória. Cancelamento da espera reconhecido em **92,5 ms** nesta
  amostra; nenhuma janela de preview ou processo do aplicativo permaneceu.
  Não é percentil nem prova de admissão pelo scheduler Rust. Reproduzir com
  `scripts/harness-electron-preview.mjs <pasta-evidencias> <CodeStudio.exe>`.
- **Matriz do pacote:** conversa, arquivos, imagem, busca, memória/skills,
  continuação, cinco interações, terminal ConPTY, interrupção da preparação,
  MCP público e externo via stdio passaram. Restart recuperou **19 checkpoints**
  sem repetir provider ou mutação MCP de resultado incerto. O fallback legado
  também passou. Não permaneceram processos rastreados do aplicativo/MCP.
  A primeira matriz falhou com contexto de avaliação remoto destruído durante
  a prova de preparação; os três casos passaram isolados. A instrumentação passou
  a observar a confirmação de parada sem manter uma avaliação remota pendente
  durante o teardown, e a matriz completa passou. Os relatórios de falha foram
  preservados; isso não comprova ausência de outras falhas intermitentes.
- **Build:** TypeScript de desenvolvimento e produção, dashboard, preload,
  plugins e pacote de binários Rust passaram. Compilação usa os CLIs locais,
  evitando que `pnpm exec` tente sincronizar/remover dependências durante o build.
- **Gates globais ainda falham:** referências ao legado fora da baseline
  caíram de 573 para **459** e arquivos acima de 500 linhas de 58 para **56**.
  O gate separado de fronteiras de pacotes também permanece pendente. Não regeneramos a
  baseline nem ampliamos a allowlist para transformar esse resultado em aprovação.

Evidências locais: `scratch/harness-20261003/all-tools-*.txt`,
`storage-preview-final-tools.txt`, `storage-browser-storage-tests.txt`,
`storage-browser-native-windows.txt`, `storage-preview-electron-build.txt`
e `tools-review-preview-physical/report.json` na mesma pasta. Os arquivos nessa
pasta não são parte do pacote distribuído. Nenhum destes testes usa os bancos
reais cadastrados pelo usuário ou comprova paridade de todos os drivers remotos.

## Trabalho restante por família

Os nomes exatos, inclusive os pendentes, estão no inventário. A lista abaixo
define o que falta para cada família poder ser considerada concluída.

| Família | Próxima entrega necessária |
|---|---|
| Arquivos, edição, patch, Git e comandos | Completar servidores persistentes entre attempts e reconexão de processos vivos; ampliar a matriz de falhas sem repetir efeitos incertos. A regressão combinada do novo pacote já passou. |
| Preview Electron — 22 ferramentas | Autoridade, ownership e drain integrados. Matriz empacotada, screenshot no provider, cancelamento, ACK perdido e restart aprovados. Permanecem os gates gerais de rollout e paridade das demais plataformas. |
| Browser — oito ferramentas | Integração HostCapability, teste físico e matriz empacotada Rust/Electron/Chrome concluídos, inclusive cancelamento, ACK perdido e restart. Restam ambientes/rollout e paridade global. |
| Bancos — quatro ferramentas | Escopo/segredos no gateway, contrato de cancelamento e resultado incerto por driver; paridade dos oito engines e validação física das conexões de teste. |
| MCP interno — 33 nomes | 25 habilitados na fonte 138, incluindo exportação; 24 no pacote 137. Restam `save_memory`, `index_project` e seis ferramentas de runs/agentes. Runs aninhados exigem árvore inteira no mesmo runtime. |
| MCP externo e plugins dinâmicos | Catálogo selado por attempt, permissões e contratos por plugin/servidor; provar cancelamento, atualização de catálogo e efeito desconhecido sem repetir mutação. |
| LSP, diagnósticos e RAG | Integrar cancelamento e cache pela revisão do workspace; testar documentos grandes, serviços indisponíveis e resultados tardios. |
| HTTP e API collections | Preservar classificação por método, autenticação, limites, confirmação de escrita e resultados progressivos de coleção. |
| Memória, notas, skills e descoberta | Concluir ferramentas restantes preservando revisão da preparação, orçamento proativo, consultas explícitas aguardadas e escopo de memória. |
| Goals, planos, tasks, workflow e review | Migrar alterações de estado para o writer autorizado, incluindo aprovações, retomada e revisão, sem depender de mutações do turno legado. |
| Diagramas e imagens | Certificar persistência, anexos, exportações, consumo pelo provider e abertura na interface. |
| Subagentes e Company — 77 nomes próprios Company | Migrar árvores inteiras, canais, permissões, tarefas, kanban, serviços, QA e arquivos compartilhados. Não alternar runtime no meio da árvore. |
| DocsAgent — seis ferramentas próprias | Integrar planejamento, fontes, pesquisa, síntese e término com custo/uso, cancelamento e recovery. |

## Histórico da entrega e instalação — 2026-10-06

Estas alterações são **posteriores** ao instalador congelado
`CodeStudio-Harness-Candidate-2026-10-06.exe` e ainda não estão nele. Há um pacote
separado de validação em `dist/electron-tools-review-20261006/win-unpacked`.
Seus testes de preview, matriz Rust com restart e fallback legado passaram.
Relatórios em `tools-review-native-final/report.json` e
`tools-review-legacy/report.json` sob a pasta de evidências acima.

O novo instalador é
`dist/electron-tools-review-20261006/CodeStudio-Tools-Candidate-2026-10-06.exe`,
com 319.575.580 bytes e SHA256
`31ab7b3f4a65e505dcbf51e81988df96128c99361c79cdf76a7e03c9592181cf`.
Os **4.856 arquivos** extraídos coincidem, por SHA256, com o pacote testado.
O ASAR é `cc3d76412c7369d13a18556ba4071f9277fef3bb3044d2b966593b7490ec8166`.
O instalador não possui assinatura Authenticode e não foi executado.
O candidato anterior foi preservado com seus hashes originais.

O código desse pacote migrou uma nova cópia do snapshot consistente de schema
266 para 268, preservando os valores das **30 tabelas** de configuração/banco/SSH.
O leitor validou os **16 journals** copiados com a mesma quantidade de commits
e bytes da baseline, incluindo quatro sessões vazias. O snapshot e os journals
permaneceram idênticos. Isso é verificação de cópias, não backup integral do perfil
nem teste das conexões reais. Relatórios: `tools-review-profile-final/report.json`
e `tools-review-installer-verification-final.json` na pasta de evidências.

O aplicativo instalado não foi fechado ou atualizado. Configurações e permissões do usuário
não foram alteradas. Rust continua opt-in de desenvolvimento; o padrão é legado.

Para atualizar o inventário, executar `npm run tools:inventory`. Para conferir
que a documentação acompanha o checkout, executar `npm run check:tool-inventory`.
O comando não executa ferramentas, não acessa providers e não lê dados do perfil.
