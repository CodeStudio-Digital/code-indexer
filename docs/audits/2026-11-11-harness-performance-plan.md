# Plano de correção de consumo e latência do harness

Data: 11/11/2026. Estado: correções funcionais e instalador 3.16.23 verificados; comparação concluída. As metas de reduzir rodadas e entrada sem cache não foram atingidas, e não foi demonstrado ganho global de velocidade. O plano original e suas metas foram preservados; resultados e limitações estão no [relatório de validação](2026-11-11-harness-performance-results.md). Não representa alterações presentes no instalador 3.16.22.

Base: [investigação por turno](2026-11-11-harness-cost-latency-causes.md). O objetivo é aproximar tempo e consumo do Codex preservando correção, recuperação, memória, MCP e suporte aos demais provedores. Os alvos abaixo são critérios propostos de engenharia, não ganhos demonstrados ou limites impostos ao agente.

## Ordem e entregas

| Ordem | Prioridade | Entrega | Condição para avançar |
| --- | --- | --- | --- |
| 0 | P0 | Medição confiável e nova referência | Isolamento conferido no runtime e tempos atribuídos por operação |
| 1 | P0 | Catálogo estável e ferramentas essenciais acessíveis | Descoberta não altera o catálogo; execução persistente e recuperação de saída continuam disponíveis |
| 2 | P0 | Persistência com caminho crítico mínimo | Atrasos localizados e corrigidos, com recuperação após falha preservada |
| 3 | P1 | Execução e validação com menos bloqueios | Comandos independentes podem progredir; resultados continuam associados à versão validada |
| 4 | P1 | Indexação subordinada à interação | Configuração efetiva respeitada e trabalho de fundo com concorrência limitada |
| 5 | P1 | Menos releituras, patches rejeitados e fechamento duplicado | Menos rodadas sem reduzir testes úteis ou aceitar patches ambíguos |
| 6 | P0 para entrega | Comparativo final e instalador | Qualidade aprovada, ganhos medidos e pacote conferido |

Fazer as entregas em alterações separadas, para atribuir resultados e reverter uma regressão sem perder as demais. A instrumentação do item 0 deve preceder mudanças no armazenamento; a correção do catálogo pode ser avaliada independentemente da persistência.

## 0. Corrigir a medição antes de otimizar

**Problema confirmado:** campos antigos desligados não impediram a geração ONNX. Na rodada de 17 minutos houve indexação de fundo durante 409 segundos. Esses 409 segundos se sobrepõem ao trabalho do agente.

Tarefas:

- Usar a versão 3.16.22 final como referência nova, com o mesmo projeto, prompt, modelo, esforço, conta e limites de concorrência da candidata.
- Conferir os perfis efetivos de código, documentos e memória e os jobs ativos antes, durante e depois de cada execução. O preparo corrigido já existe; falta exercitá-lo numa rodada completa.
- Separar dois cenários: execução com o índice pronto e manutenção inativa; uso normal do produto com indexação/memória habilitadas. Publicar ambos com suas condições.
- Registrar tempos monotônicos por sessão/turno/operação: admissão, montagem de contexto, modelo, ferramentas, espera na fila de persistência, serialização, escrita, fsync, rename e atualização de projeções.
- Registrar atraso do event loop e carga do host. Não confundir espera por fila com tempo da operação de arquivo nem somar intervalos sobrepostos.
- Manter telemetria em buffer limitado, com exportação fora da fila crítica. Testar com atrasos artificiais conhecidos para conferir a atribuição; o observador não deve introduzir uma nova gravação durável antes de cada ferramenta.

Critérios: configuração efetiva registrada; nenhum job semântico no cenário isolado; contadores de turnos e tokens conciliados; etapa lenta identificável por nome e duração. Amostras com carga inesperada permanecem no relatório, identificadas, e não sustentam uma alegação de ganho isolado.

## 1. Estabilizar o catálogo e preservar ferramentas essenciais

**Problema confirmado:** duas promoções alteraram o catálogo, interromperam a continuação incremental e coincidiram com cache zero em 98.759 tokens de entrada. O limite de 28 também ocultou execução persistente.

Tarefas:

- Definir, no início da execução, um núcleo estável de ferramentas por capacidade. Incluir execução persistente, consulta de processos, recuperação de saída, descoberta e edição quando essas capacidades estiverem habilitadas.
- Manter nomes, schemas, descrições e ordenação determinísticos. Descobrir uma ferramenta não deve expulsar outra nem reordenar o catálogo inteiro.
- Usar o executor genérico existente, `code_exec`, para capacidades descobertas, com schema retornado pela descoberta e validação no registro real. Se um adaptador exigir outro formato, oferecer um despachante estável equivalente. Não depender de APIs de ferramentas adiadas exclusivas de um provedor.
- Retirar a promoção automática que altera o conjunto público a cada descoberta. Manter revogação de permissões e alterações reais de MCP efetivas imediatamente; quando exigirem mudança de contrato, invalidar a continuação explicitamente e registrar o motivo.
- Respeitar limites verificados de cada provedor. O limite interno de 28 não deve ser tratado como limite universal da API.
- Manter permissões, escopo de projeto, validação de argumentos, cancelamento e registro de resultados no mesmo dispatcher, inclusive pelo executor genérico.

Arquivos iniciais: `packages/code-agent/src/core/runner/assembly/tools.ts`, `packages/code-agent/src/core/runner/nodes/executing.ts`, `packages/code-agent/src/tools/tiers.ts` e testes de projeção/dispatch.

Critérios: descobrir e chamar várias ferramentas mantém o fingerprint quando não há mudança real de contrato; ferramentas essenciais não desaparecem; MCP reconectado/revogado não reutiliza autorização ou schema obsoleto; compatibilidade com provedores de limites menores. Medir cache real e qualidade: não prometer taxa de cache que depende do servidor.

## 2. Corrigir a espera de persistência preservando durabilidade

**Problema confirmado:** 291,8 segundos de espera adicional; um turno acrescentou 172,73 segundos depois de o modelo responder. A operação específica responsável ainda não foi isolada.

A conversa já fica em memória e os arquivos já usam I/O assíncrono. A mudança necessária é reduzir o trabalho e a espera na cadeia crítica, não apenas trocar chamadas síncronas por promises.

Tarefas:

- Instrumentar a entrada/saída da fila do escritor, o heartbeat/lease e cada operação de arquivo antes de escolher uma nova arquitetura.
- Separar o registro necessário à recuperação de conversa, intenções/resultados de ferramentas e estado terminal das projeções reconstruíveis, estatísticas e diagnósticos.
- Fazer a barreira aguardar somente a durabilidade necessária para o próximo efeito. Agrupar atualizações derivadas e drená-las em segundo plano, com buffer limitado, tratamento de falha e confirmação no fechamento.
- Encaminhar telemetria ao escritor proprietário da sessão. Eliminar tentativas de abrir um segundo escritor para gravar métricas na mesma sessão.
- Preservar um escritor por sessão, ordem dos eventos, idempotência e confirmação de commits. Se a gravação crítica falhar, não executar silenciosamente um novo efeito nem declarar sucesso.
- Se a medição localizar fsync excessivo, agrupar gravações da mesma transação. Se localizar trabalho de CPU, isolá-lo; se localizar checkpoints/indexação concorrentes, corrigir o agendamento. Não mudar o formato de armazenamento sem evidência de benefício.

Arquivos iniciais: `packages/session-storage/src/session-writer.ts`, `file-session-repository.ts`, `fs-store/conversation-writer.ts`, `fs-store/session-directory.ts`, `atomic-file.ts` e `packages/code-agent/src/core/runner/turn-persistence-barrier.ts`.

Critérios de integridade: fechar/reabrir recupera mensagens, resultados, uso e ordem; interrupção entre escrita/flush/rename não confirma dados perdidos; revogação de lease impede escrita; nenhuma ferramenta com efeito é repetida automaticamente por perda de confirmação.

Alvos iniciais no cenário controlado: espera de persistência p95 menor que 500 ms, menos de 2% do tempo total e nenhuma pausa maior que 2 segundos sem uma operação causadora registrada. Usar amostras suficientes de turnos para p95; uma rodada curta não valida esse percentil.

## 3. Executar comandos longos sem paralisar trabalho independente

Tarefas:

- Expor o conjunto completo `exec_command` / `write_stdin` / consulta de sessões e orientar seu uso para comandos longos.
- Distinguir prazo de espera do cliente de prazo máximo do processo. Devolver identificador e progresso quando o comando continuar; não matar uma validação somente porque acabou o intervalo de espera da interface.
- Acompanhar conclusão por eventos e esperas eficientes. Evitar consultas frequentes ao modelo só para perguntar se um processo terminou.
- Preservar cancelamento da árvore de processos criada, limites explícitos, isolamento por sessão e resultados parciais de lotes.
- Paralelizar somente operações independentes. Não editar os arquivos sob teste enquanto uma validação final os está lendo; alterações posteriores invalidam a evidência afetada.
- Executar scripts de lint/build/testes realmente configurados. Não inventar executáveis nem expandir lint a arquivos fora do tsconfig sem resolver a configuração.

Critérios: tarefa longa não prende o fluxo de leituras independentes; processo finalizado publica o exit code correto; falha de um comando não apaga resultados concluídos do lote; cancelamento não deixa processos do teste; lint/build/testes obrigatórios mantêm resultado verificável.

## 4. Controlar indexação e memória em segundo plano

Tarefas:

- Centralizar a resolução da configuração efetiva e fazer painel, API, coordenador e benchmark consultarem a mesma decisão. Definir migração/precedência explícita para campos antigos.
- Priorizar consulta ao índice e recuperação de memória usada pelo agente. Backfill, reindexação completa e manutenção são trabalhos de menor prioridade.
- Limitar concorrência e tamanho de lote do ONNX. Reduzir ou pausar o próximo lote quando houver pressão de CPU/I/O ou atraso do event loop, retomando o progresso de forma persistente.
- Não interromper à força uma inferência nativa em execução; aplicar a pausa entre lotes. Mudanças de arquivo continuam registradas para posterior reconciliação.
- Evitar reiniciar uma geração completa ao abrir sessão ou reabrir projeto quando só há deltas.

Critérios: perfil desligado não inicia embeddings; trabalho pausado retoma sem perder deltas; consultas continuam disponíveis; sessões paralelas não disparam gerações duplicadas. Medir o cenário com serviços habilitados, além do cenário isolado.

## 5. Reduzir rodadas de recuperação e fechamento

Tarefas:

- Devolver caminhos verificados e trechos delimitados nas leituras; verificar se as apresentações dos diferentes leitores preservam contexto e indentação usados pelo patch.
- Em falha de patch, informar arquivo/hunk e contexto mínimo relevante para recuperação, sem aceitar correspondências ambíguas ou alterar outro trecho parecido.
- Agrupar leituras independentes e evitar repetir conteúdo que permanece válido. Invalidar qualquer reaproveitamento quando o arquivo mudar.
- Associar validações à revisão dos arquivos e ao comando. Reusar resultados atuais; mudanças relevantes ou falhas exigem nova execução.
- Preservar a correção já entregue que não invalida testes por escrever relatório de prosa.
- Fechar com comandos/resultados/falhas de forma compacta. Quando o usuário pedir relatório detalhado, atender à extensão solicitada; evitar repetir o documento inteiro no chat.

Critérios: regressões de patch/contexto aprovadas; nenhuma edição aplicada fora do trecho pretendido; resultado de validação nunca reutilizado depois de mudança relevante; nenhuma rodada forçada apenas pela escrita de relatório. Quantidade de chamadas é métrica de eficiência, não teto que encerra uma tarefa incompleta.

## 6. Provar o ganho e gerar o instalador

Validação em três níveis:

1. Testes determinísticos de projeção, dispatch, persistência, cancelamento, recuperação e configuração semântica. Simular falhas e atrasos; conferir consistência com sessão reaberta.
2. Regressões dos adaptadores usados pelo produto, incluindo ChatGPT/Responses, OpenAI API, Anthropic, Gemini e demais adaptadores afetados. Verificar limites e parâmetros escolhidos, cancelamento, cache e término; não impor WebSocket/Responses a quem não os suporta.
3. Comparativo real com mesma tarefa e configurações: pelo menos três execuções de cada versão em ordem alternada, contabilizando falhas e tentativas. Fazer uma nova referência Codex contemporânea. Acrescentar casos de React/preview e sessão longa; o Ky sozinho não representa o produto inteiro.

Controlar custos: começar com provas locais e um par real por alteração de maior risco; executar as repetições completas somente na candidata integrada. Publicar mediana e dispersão das tarefas, não um p95 calculado com três amostras. Comparar modelos diferentes dentro de suas próprias referências e distinguir compatibilidade testada de desempenho realmente medido.

O avaliador deve executar os mesmos 45 casos externos do Ky, build, typecheck, lint e suíte Node, além das regressões novas. O resultado do agente não deve ser corrigido pelo avaliador para fazê-lo passar. Validar o patch/revisão final e o resultado real dos comandos, não apenas o relato do agente.

**Alvos de eficiência:** reduzir em pelo menos 25% as rodadas e 30% a entrada sem cache em relação à nova referência equivalente; perseguir mediana de tempo até 1,25 vez a referência contemporânea do Codex, sob a mesma exigência de qualidade. Esses números são metas de investigação, não promessa de que cada tarefa ou modelo atingirá a proporção. Não forçar conclusão, reduzir esforço ou retirar testes para alcançá-los.

**Condição de entrega:** critérios funcionais e de recuperação aprovados, nenhuma regressão conhecida introduzida e resultados de desempenho publicados com as limitações. Gerar nova versão, conferir hashes dos módulos empacotados, executar o smoke test Electron em perfil isolado e entregar instalador com checksum. Preservar dados e provedores instalados.

## Progresso no início deste plano

- Concluído anteriormente: correção de aplicação de patches; reconhecimento de validação; retirada da revalidação só por relatório; recuperação do lease após pausa; redução de gravações redundantes; diagnóstico de política opcional desligado por padrão; pacote 3.16.22 verificado.
- Concluído no diagnóstico: identificação das duas alterações de catálogo/cache; localização da espera na barreira; descoberta e retificação do isolamento semântico; preparo do benchmark atualizado.
- Pendente: implementar e medir o catálogo estável, decompor e corrigir a pausa longa, assegurar o fluxo de execução persistente, controlar a carga de fundo, rodar a comparação corrigida e gerar o próximo instalador.

## Resultado da execução

Catálogo estável, proteção de ferramentas essenciais, fila de diagnósticos, encaminhamento ao worker proprietário, instrumentação por operação, execução persistente e orçamento ONNX foram implementados. Compilação e baterias de regressão passaram. A pausa antiga de 172,7 segundos não foi reproduzida na nova referência isolada; não há evidência para atribuí-la integralmente a uma operação específica.

A comparação final usou três rodadas de cada runtime e uma nova referência Codex; o piloto e três intermediárias permanecem documentados. As intermediárias revelaram espera excessivamente curta e aspas incorretas no lançamento de comandos Windows, corrigidas antes da coorte final. Esta última ocorreu depois das referências, sem alternância. Regressões de interface, preview, QA e compactação passaram. O ensaio local ONNX preservou 12/12 recuperações sintéticas e demonstrou a troca entre menor CPU e maior duração do backfill. Isso não substitui um comparativo de uma tarefa React real ou de uma conversa de muitas horas.

Medianas: 8min51,8s/34 chamadas na 3.16.22 e 9min08,9s/44 chamadas na 3.16.23; Codex contemporâneo em 7min57,6s/26 ciclos públicos. A entrada sem cache caiu 21,7%; a entrada total aumentou 41,2%. O alvo de tempo até 1,25× o Codex foi atendido neste recorte; os alvos de redução de chamadas e de entrada sem cache não foram. As três candidatas passaram nos 45 casos externos, build, tipos, lint e suíte Node. As pausas residuais de I/O de 6,8s e 5,7s foram localizadas por operação; ficaram abaixo de 2% de cada tarefa, sem retirar durabilidade.

O instalador 3.16.23 foi gerado: 4.205 arquivos conferidos com o runtime final e sete checks do pacote aprovados. A redução de rodadas, a investigação inferior ao nível das APIs de arquivo e comparativos reais de React/Company, outros provedores e sessões longas permanecem pendentes de demonstração. A entrega não é uma declaração de que todas as metas de desempenho foram alcançadas.
