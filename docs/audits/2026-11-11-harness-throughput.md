# Continuidade, validação e desempenho do harness — 3.16.22

Data: 11/11/2026. Evidências locais: `.tmp/harness-throughput-20261111`. Correções de integridade verificadas; meta de velocidade total ainda não atingida.

**Retificação do método em 11/11/2026:** a inspeção dos bancos após esta rodada comprovou que os perfis semânticos atuais continuaram em ONNX, apesar de `embeddings_enabled=0` e `search_mode=fts` no projeto. Os seis perfis desta rodada iniciaram geração semântica em segundo plano. Em `release-2`, 106 arquivos produziram 3.015 itens entre 04:33:49 e 04:40:38 UTC, durante a tarefa. Os tempos abaixo são observações reais do produto com essa carga; **não isolam inferência nem o efeito individual das otimizações**. Detalhamento e atribuição por turno: [causas de consumo e demora](2026-11-11-harness-cost-latency-causes.md).

## Resultado da investigação

A primeira candidata **não melhorou o tempo total**. Seus dois resultados foram 12min32s e 12min52s, contra 9min41s da referência concluída. A orientação adicional de arquivos foi retirada da revisão seguinte porque não demonstrou benefício. A segunda referência foi interrompida por expiração do escritor da sessão e não integra a média de tarefas concluídas. A revisão `release-1` completou em **15min07s**, também mais lenta no total, embora tenha reduzido chamadas e tempo absoluto no modelo nesta execução. A revisão `release-2`, com o diagnóstico opcional desligado, completou em **17min00s** e revelou 291,8 segundos de espera adicional pela persistência. Não há ganho total ou paridade com o Codex demonstrados nesta rodada.

As correções de integridade e encerramento são separadas da hipótese de aceleração. Menos chamadas numa execução não prova menor latência: a primeira candidata fez 33 chamadas contra 37 da referência, mas gastou mais tempo tanto no modelo quanto nas ferramentas.

## Correções

- **Aplicação de patches:** segmentos oriundos do mesmo hunk conservam seu contexto conjunto. Trechos curtos repetidos em funções diferentes não são aplicados isoladamente ao primeiro local semelhante. Hunks explicitamente separados mantêm sua semântica.
- **Validação final:** comandos conhecidos com logs redirecionados, executáveis locais e cadeias `&&` são reconhecidos. Falhas, execução sem confirmação de término, pipelines e expressões ambíguas não viram evidência de sucesso.
- **Documentação e testes:** escrever um relatório de prosa não invalida automaticamente os testes do código. Alterações em código, prompts, MDX, configurações e validações que incluem documentação continuam exigindo evidência atualizada. A revisão do texto permanece explícita.
- **Telemetria:** turnos que pedem uma revisão final agora também persistem seus tempos. A candidata registrou 33/33 e 38/38 chamadas; a referência registrou 36/37.
- **Descoberta de ferramentas:** o prompt informa os executáveis de validação realmente encontrados no projeto. As instruções de build e habilidades foram encurtadas, preservando revisão, regressões e permissões.
- **Python no Windows:** processos iniciados pelo agente usam UTF-8 por padrão, respeitando configurações explícitas do usuário/projeto, inclusive a comparação de variáveis sem distinguir maiúsculas. Isso cobre `run_command` e execução persistente. Uma escrita Python na candidata falhou com `UnicodeEncodeError` e precisou ser recuperada pelo agente.
- **Sessão após atraso:** uma pausa de I/O ou do event loop não invalida sozinha a exclusividade de um escritor vivo. A renovação atrasada exige o mesmo token, proprietário, prazo anteriormente registrado e fence durável. Substituição do escritor, revogação do fence, corrupção ou alteração externa do lease continuam bloqueando a escrita. O teste de um concorrente tentando tomar uma sessão de um processo vivo permanece ativo.
- **Diagnóstico de política opcional:** o modo experimental de comparação gravava uma decisão e uma comparação antes de cada ferramenta, mesmo sem autoridade para autorizá-la ou recusá-la. Agora esse diagnóstico depende de ativação explícita. As verificações reais de permissão, escopo, plano e recuperação continuam no dispatcher; os modos explícitos de diagnóstico e enforcement continuam testados.
- **Gravações repetidas:** após a medição de `release-2`, o fechamento de um turno deixou de gravar `session.json` duas vezes; a gravação de uso já atualiza o timestamp. Métricas continuam duráveis, mas não regravam `metrics/summary.json` se todos os totais forem iguais. Substituições, rollback, mudanças de tokens e novas tentativas do provedor continuam atualizando o resumo. Essas duas mudanças posteriores precisam ser distinguidas da execução completa de `release-2`.

Essas mudanças do núcleo, armazenamento, ferramentas e prompts são compartilhadas entre provedores. As melhorias anteriores de reutilização de clientes e sobreposição de persistência foram preservadas. Transporte incremental Responses continua restrito ao adaptador com capacidade verificada; não foi imposto aos demais provedores.

## Método

Biblioteca Ky 2.2.0 com cinco defeitos semeados, cópias independentes e o mesmo prompt. Modelo `gpt-6.1-sol`, esforço `high`, mesma conta, perfis separados e memória do projeto desligada. A tentativa de desligar a busca semântica usou campos antigos e não desativou os perfis atuais: a geração semântica em segundo plano permaneceu ativa. As execuções cronometradas não concorreram com nossos builds ou verificações externas. A indexação estrutural normal do produto permaneceu habilitada.

- Seed: `8baf0cadd8ca66659d6e86b2ebf4583e2f15bcb4`.
- SHA-256 dos arquivos: `cb60a66e7f4d63474396cbb093efff1aade678082f1419181ed13700d4043f58`.
- SHA-256 do prompt: `561f9eacf7b571f25ccbfc8173c5cd7dbec999772f75afdf990af0035489cecb`.
- Ordem inicial: referência, candidata, candidata, referência. `release-1` e `release-2` são execuções posteriores separadas, não incorporadas à média da candidata rejeitada.
- Verificação independente: build, tipos, lint dos fontes alterados, suíte Node e 45 verificações externas. Os resultados dos participantes não são editados pelo avaliador. Navegador fora do escopo desta tarefa.

| Medida | Referência 1 | Candidata 1 | Candidata 2 |
| --- | ---: | ---: | ---: |
| Total | 581.197 ms | 751.581 ms | 771.550 ms |
| Admissão | 11.362 ms | 35.940 ms | 9.695 ms |
| Chamadas ao modelo | 37 | 33 | 38 |
| Tempo nas chamadas | 323.205 ms | 368.629 ms | 359.159 ms |
| Fração do total no modelo | 55,61% | 49,05% | 46,55% |
| Tempo ocupado por ferramentas | 226.628 ms | 324.741 ms | 391.080 ms |
| Chamadas de ferramentas | 35 | 49 | 60 |
| Espera adicional pela persistência | 10.151 ms | 12.592 ms | < 1 ms |
| Duração da persistência, com sobreposição | 85.458 ms | 67.713 ms | 71.622 ms |

A duração da persistência não deve ser somada ao tempo do modelo: parte ocorre simultaneamente. A conversa já fica em memória; os dados duráveis são registrados de forma assíncrona. Aguardar a confirmação antes de novos efeitos conserva a segurança de retomada.

## Onde o tempo foi gasto

O lint de oito arquivos demorou 150,7 e 146,0 segundos nas candidatas. A referência executou uma variante com `--fix` em 72,0 segundos; não são comandos idênticos e a diferença não prova regressão do executor. As candidatas também tiveram testes, correções após lint e novas validações. Esses custos são separados do tempo de inferência.

O mesmo comando de oito arquivos da candidata 1 foi executado fora do harness e levou 125,2 segundos. Terminou com quatro erros de configuração: os arquivos de teste não pertenciam ao projeto TypeScript usado pelo serviço do linter. O lint independente dos quatro fontes passou. A medição externa ocorreu junto de outros verificadores de release e não serve para calcular um ganho percentual do executor; demonstra que a operação continua cara fora do agente.

As primeiras saídas das chamadas somaram 172,4 segundos na referência, contra 245,3 e 231,8 segundos nas candidatas. Isso é latência observada pelo cliente e inclui fatores que o servidor não separa para nós, como espera e processamento. Não temos evidência para atribuir todo esse tempo à rede, nem para afirmar prioridade diferente do serviço.

Usar a mesma conta/modelo não garante o mesmo trabalho: o tamanho das leituras, conteúdo do prompt, chamadas adicionais e decisões de validação mudam a sequência. A primeira candidata recebeu cerca de 298 mil caracteres de resultados de ferramentas, contra 155 mil da referência, apesar de fazer menos chamadas ao modelo. A listagem adicional foi removida; não se anuncia ganho apenas por encurtar instruções.

O Codex histórico completou a tarefa em 3min55s, mas essa execução não é um novo par contemporâneo, gerou outra cobertura de regressões e tinha três erros de lint nos fontes. O resultado é uma referência útil, não prova de equivalência de qualidade ou uma medição atual do transporte do Codex.

## Interrupção da segunda referência

Após admissão de 36,6 segundos, a preparação de uma chamada `mcp__search` expirou. A sessão depois terminou com `SessionFenceLostError`: o prazo de 30 segundos do escritor venceu. Não houve novo proprietário conhecido. O próprio tratamento de erro não conseguiu atualizar os metadados porque dependia do escritor expirado.

O log também registrou checkpoints SQLite de 10,4 e 7,9 segundos. Isso confirma atrasos locais observados, sem identificar isoladamente sua causa. Uma amostra posterior mostrou aproximadamente 49 GiB de RAM disponível; ela não comprova nem exclui contenção de disco no instante anterior.

A conexão foi encerrada pelo servidor com evento de erro. O coletor classificou a execução como falha a partir desse evento, sem reenviar a mensagem. O servidor de teste foi encerrado, e as credenciais copiadas foram removidas. O perfil instalado não foi modificado.

## Verificações e entrega

Os 410 testes direcionados da revisão final passaram, incluindo regressões de leases, patches, validação, prompts e processos. A rodada de adaptadores e armazenamento anterior nesta investigação passou em 399 testes; há sobreposição entre essas seleções e os totais não devem ser somados como casos distintos.

As três entregas concluídas passaram build, tipos, lint dos fontes, diff check e 45/45 verificações externas. As suítes Node passaram em 1.554 casos na referência, 1.548 na candidata 1 e 1.547 na candidata 2. O lint adicional de arquivos de teste permanece com a limitação de configuração descrita acima.

Duas provas com os módulos compilados também compararam a versão anterior e a corrigida:

- Python real: a anterior falhou com `UnicodeEncodeError`; a corrigida gravou e exibiu corretamente `ação 中文 🚀`, com modo UTF-8 ativo e exit code 0.
- Pausa real do event loop de 1.500 ms com lease de 1.000 ms: a anterior lançou `SessionFenceLostError`; a corrigida confirmou o primeiro commit após a pausa. Os testes de substituição do escritor e revogação do fence continuam recusando gravações.

## Revisão medida antes de retirar o diagnóstico opcional

Runtime `runtime-release`, sessão `002b1bf4-1988-4b1e-bd2e-1fcc92d74b6a`, resultado `completed`. Nenhum código do participante foi alterado pelo avaliador.

| Medida | Referência concluída | `release-1` |
| --- | ---: | ---: |
| Total | 581.197 ms | 906.636 ms |
| Admissão | 11.362 ms | 10.762 ms |
| Chamadas ao modelo | 37 | 23 |
| Tempo observado nas chamadas | 323.205 ms | 278.354 ms |
| Tempo em intervalos de ferramentas | 226.628 ms | 591.125 ms |
| Espera adicional da persistência | 10.151 ms | 20.373 ms |
| Duração da persistência, com sobreposição | 85.458 ms | 88.175 ms |
| Tokens de entrada | 1.629.578 | 1.224.399 |
| Tokens de saída, incluindo raciocínio | 10.131 | 9.868 |
| Chamadas com telemetria nativa | 36/37 | 23/23 |
| Suíte Node independente | 1.554 aprovados | 1.553 aprovados |
| Aceitação externa | 45/45 | 45/45 |

Build, tipos, lint dos fontes e diff check passaram. Foram aprovados **410 testes direcionados da revisão final** e a seleção de **399 testes de provedores/armazenamento** executada antes do ajuste final de lease. Os testes de armazenamento afetados foram novamente incluídos nos 410; os totais têm sobreposição. O TypeScript do produto e do dashboard também passou.

Na tarefa final houve 37,8% menos chamadas e 13,9% menos tempo absoluto nelas, mas **56,0% mais tempo total**. São observações de uma amostra, não estimativas estáveis de aceleração. O p50 de primeiro conteúdo por chamada subiu de 3,23 para 6,17 segundos: reduzir quantidade e contexto não tornou individualmente cada request mais rápido.

A maior tentativa de lint levou 139,8 segundos e falhou pela configuração TypeScript dos testes. Uma aplicação de patch em quatro arquivos de teste levou 85,4 segundos no executor. O caminho de patch usa o armazenamento de snapshots, mas esta rodada não separou suas fases; não é correto atribuir os 85,4 segundos integralmente a snapshots ou ao disco. Testes completos foram executados novamente após uma correção de fonte feita pelo lint, o que manteve a verificação válida.

Os intervalos de ferramentas são a união dos períodos entre eventos de início e resultado recebidos. Incluem preparação, pós-processamento e entrega dos eventos, não apenas o corpo da ferramenta. A soma dos tempos internos reportados pelas ferramentas foi 473,2 segundos; a soma de seus intervalos individuais foi 630,3 segundos, com 157,2 segundos de diferença. Esses intervalos podem se sobrepor e não devem ser somados ao tempo total. Separar essa preparação/pós-processamento é uma pendência concreta da investigação.

O fechamento corrigido foi observado: as últimas operações foram revisão do diff, consulta da existência de `BENCHMARK_RESULT.md` e escrita do relatório. Em seguida houve conclusão; o harness não solicitou uma nova validação após o relatório.

O bundle desta sessão contém 95 arquivos em `events/policy-decisions` para 47 chamadas de ferramentas. O código confirma que o dispatcher aguardava `recordCapabilitySet`, `recordDecision` e `recordComparison` do observador experimental antes da execução. A diferença de 157,2 segundos entre intervalos e execução não deve ser atribuída inteira a esse caminho sem medição específica.

Uma prova local com os dois runtimes compilados usou quatro sessões artificiais, em ordem anterior/corrigido/corrigido/anterior, com seis invocações em cada uma. O caminho antigo gastou 2.938,6 ms e 1.072,9 ms somente no observador, criando 13 arquivos de diagnóstico por sessão (incluindo o índice). O padrão corrigido não criou o observador nem arquivos desse diagnóstico; o ramo vazio levou menos de 0,01 ms por lote. Isso demonstra a eliminação desse custo específico, não uma aceleração equivalente da tarefa completa. Evidência: `policy-shadow-timing.json`.

Após mudar o padrão do diagnóstico, a seleção passou em 457/461 casos na primeira execução. Os quatro restantes excederam o limite de tempo durante compilação concorrente. A reexecução isolada dos dois arquivos afetados passou em 18/18 casos, incluindo esses quatro, sem mudar os testes nem aumentar seus limites. As 51 verificações adicionais de política/permissões passaram. As seleções anteriores de 410 e 399 casos se sobrepõem e não devem ser somadas.

As duas remoções posteriores de gravações duplicadas foram verificadas em todos os 118 casos do armazenamento: 117 passaram na primeira execução, e um caso de recuperação excedeu seu limite de tempo. Esse caso passou isoladamente, também sem aumentar o limite. A união das seleções atuais, considerando o resultado mais recente de cada caso, contém **463 testes distintos aprovados**; isso não significa uma única execução de 463 casos sem falhas intermediárias. Evidência: `tests-final-summary.json`.

O log apresentou também falhas não fatais de telemetria auxiliar de pipelines tentando escrever em uma sessão com outro escritor ativo. Isso permanece como limitação dessa telemetria auxiliar; os tempos de provedor/turnos usados na tabela vieram de outro caminho e estão completos em 23/23 chamadas. A renovação de lease não permite tomar o lugar de um proprietário diferente.

Os processos de benchmark foram encerrados e a limpeza confirmou zero credenciais OAuth e zero chaves de API nos seis perfis isolados, incluindo `release-2`. O perfil instalado e seus provedores permaneceram intactos.

## Medição com diagnóstico opcional desligado

Runtime `runtime-release2`, sessão `d8d6cd0d-74fa-41e0-a4a0-efc637dd1e59`, resultado `completed`.

| Medida | `release-2` |
| --- | ---: |
| Total | 1.020.489 ms |
| Admissão | 12.846 ms |
| Chamadas ao modelo | 35 |
| Tempo observado nas chamadas | 347.122 ms |
| Tempo nativo reportado pelas chamadas | 323.447 ms |
| Tempo em intervalos de ferramentas | 376.960 ms |
| Espera adicional da persistência | 291.820 ms |
| Duração da persistência, com sobreposição | 406.414 ms |
| Chamadas com telemetria nativa | 35/35 |
| Turnos de WebSocket incremental | 26 |
| Suíte Node independente | 1.534 aprovados |
| Aceitação externa | 45/45 |

Build, tipos e diff check passaram na verificação independente. O lint dos quatro fontes levou 109,3 segundos e encontrou **um erro** em `source/utils/merge.ts:138`: `unicorn/no-new-array`, além de seis avisos. A solução do participante não foi corrigida pelo avaliador; a rodada não tem aprovação completa de lint nem demonstra equivalência de qualidade com a revisão anterior que passou nesse requisito.

No turno 6, o provedor respondeu em 4.060 ms, mas a barreira da conversa levou 176.800 ms no total e acrescentou 172.731 ms de espera. Outro turno acrescentou 44,7 segundos. A soma não deve ser confundida com inferência ou custo de serialização JSON: mede toda a espera pela cadeia de persistência. O coletor SSE também apresentou atrasos na entrega, portanto seus intervalos diferem dos relógios nativos.

Uma amostra do host durante a rodada mostrou 59% de CPU total e fila instantânea de disco de 4. Os contadores de bytes/s retornaram zero nessa amostra e não oferecem base para calcular utilização do disco. Não foi identificado um responsável único por esses atrasos do host.

Houve três rejeições de patches cujos contextos não coincidiam com os fontes, uma falha esperada nos testes iniciais, uma chamada aninhada que excedeu 15 segundos e um lint que excedeu os 120 segundos escolhidos pelo agente. O chat se recuperou e concluiu. Esses tempos de retrabalho permanecem no resultado; não foram excluídos para melhorar a comparação.

A prova sintética de persistência da versão anterior às duas remoções adicionais registrou seis commits de conversa, 12 gravações de metadados, 12 de resumo e 44 flushes atômicos. Ela preservou 12 mensagens e a contabilidade correta, mas não reproduziu a pausa de 173 segundos. A causa exata dessa pausa não está comprovada pelo teste sintético.

## Comparação isolada das últimas correções de I/O

A mesma prova de seis turnos foi repetida com os módulos compilados que vão para o instalador:

| Medida | Antes | Corrigido |
| --- | ---: | ---: |
| Gravações atômicas de metadados | 12 | 6 |
| Gravações atômicas do resumo | 12 | 7 |
| Total de gravações atômicas de arquivos | 44 | 33 |
| Commits do journal | 6 | 6 |
| Mensagens recuperadas | 12 | 12 |
| Tokens de entrada / saída preservados | 600 / 60 | 600 / 60 |
| Duração do lote | 2.561,1 ms | 2.552,8 ms |

São 25% menos gravações atômicas nesse cenário. O tempo ficou praticamente igual nesta amostra; não há base para anunciar aceleração de 25%. Os seis commits continuam sincronizados antes da confirmação. Evidências: `persistence-profile-before.json` e `persistence-profile-after.json`.

Os únicos módulos de produção que mudaram depois da rodada completa `release-2` foram `file-session-repository.js` e `fs-store/conversation-writer.js`; os outros hashes diferentes são testes. A rodada completa de 17 minutos, portanto, não mede essas duas alterações posteriores. O build TypeScript do produto e as regressões do armazenamento foram executados novamente.

## Pendências de desempenho

- Medir separadamente os snapshots e a preparação/pós-processamento das ferramentas antes de alterar garantias de desfazer ou durabilidade.
- Evitar a tentativa de lint fora do projeto TypeScript configurado, sem desabilitar regras ou excluir testes de regressão.
- Encaminhar a telemetria auxiliar ao escritor da sessão, sem criar um escritor concorrente.
- Repetir a medição em outro tipo de tarefa e alternar ordem/condições; esta rodada não demonstra paridade com o Codex.

## Instalador

Instalador NSIS **3.16.22** gerado e verificado em 11/11/2026:

- Arquivo: [CodeStudio Setup 3.16.22.exe](<D:/MCP/dist/electron-harness-throughput-3.16.22-final-20261111/CodeStudio Setup 3.16.22.exe>).
- Tamanho: **341.095.924 bytes**.
- SHA-256: `BEA7B5DC589796A8348942EA68DF36BC11567D0B2A1016707705C9E639CA931D`.
- Assinatura Authenticode: `NotSigned`.
- **4.193 arquivos do runtime empacotado comparados, zero divergências** contra os módulos compilados finais. Incluem as duas reduções de gravação posteriores ao benchmark completo e a retirada da rodada extra após relatórios.
- Smoke test do pacote aprovado: dependências transitivas (2.494 módulos, 43 pacotes), renderização em perfil isolado, deep link, indexação com tree-sitter em worker, execução QuickJS, conversão de HTML e processamento de imagem/vídeo com Sharp e FFmpeg.

Evidências em `.tmp/harness-throughput-20261111/installer-verification.json` e `artifact-final.json`; checksum também salvo ao lado do executável. O instalador foi gerado, mas não aplicado ao perfil instalado do usuário. Essa validação de pacote não substitui o comparativo completo de desempenho, que permanece com as limitações descritas acima.
