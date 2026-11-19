# Consumo e demora: atribuição por turno

Data: 11/11/2026. Análise dos registros existentes, sem novas chamadas ao modelo. A referência do Codex é histórica; não há trace HTTP bruto dela. A rodada mais recente do CodeStudio é `release-2`, anterior às duas últimas reduções de gravações de arquivos da versão 3.16.22.

## O que explica o consumo maior

Há dois mecanismos observáveis, além do trabalho diferente produzido pelos agentes.

**Mais rodadas:** o CodeStudio fez 35 chamadas; o Codex registrou 25 atualizações distintas do contador público de uso. Estas últimas não comprovam a quantidade de tentativas físicas HTTP. A entrada média foi **53.745 tokens no CodeStudio e 65.978 no Codex**. Portanto, nesta amostra, a entrada acumulada maior do CodeStudio não decorre de um prompt médio maior: decorre de repetir mais ciclos com a conversa. A saída média foi 315 contra 295 tokens por ciclo registrado; o acumulado foi 11.027 contra 7.380.

**Mudanças no catálogo invalidam a continuação:** o limite de 28 ferramentas mantém a quantidade, mas não mantém o conjunto estável. A promoção de uma ferramenta reorganiza as ferramentas expostas e remove outra. O runtime registra duas alterações de `tools_fingerprint`:

| Turno | Mudança registrada antes da chamada | Entrada | Cache | Continuação incremental |
| --- | --- | ---: | ---: | --- |
| 6 | Promoção de `mcp__prepare_edit`, remoção de `get_tool_output` | 28.138 | 0 | não |
| 28 | Promoção de `get_tool_output`, remoção de `invoke_skill` | 70.621 | 0 | não |

O hash do início do prompt ficou igual. Em ambos os casos o catálogo mudou, o cliente deixou de enviar apenas a continuação e o provedor reportou cache zero. Essas duas chamadas somam **98.759 tokens sem cache**, 56,4% dos 175.089 tokens de entrada sem cache da rodada. A diferença total frente ao Codex foi 106.315 tokens sem cache. Não se deve interpretar os 98.759 como economia garantida: parte da entrada era nova, e a política interna de cache do provedor não foi observada.

A seleção do catálogo está em `packages/code-agent/src/core/runner/assembly/tools.ts`; as promoções aparecem em `server-release-2-out.log`, e os hashes/timings vêm dos arquivos de métricas do próprio turno. A descrição de estabilidade no comentário do limite é incompleta: novas promoções alteram o catálogo durante a execução.

**Trabalho e recuperação:** a etapa de patches ocupou sete rodadas e gerou 3.015 tokens de saída, com três rejeições por contexto incompatível e releituras. As rejeições protegeram os arquivos; não foram erros mascarados como sucesso. A etapa de relatório e resposta final gerou 2.809 tokens e gastou 71,7 segundos nas chamadas ao modelo. O relatório era exigido pelo benchmark, mas a extensão dele não foi limitada. O CodeStudio acrescentou sete regressões, enquanto o Codex acrescentou duas. Isso explica parte do trabalho diferente, sem comprovar que toda saída adicional melhorou a qualidade: o lint independente encontrou um erro no CodeStudio e três no Codex.

## Onde os 17 minutos foram gastos

Esta partição usa fronteiras públicas de turnos/ferramentas e soma exatamente os 1.020.489 ms. Não usa conteúdo privado de raciocínio.

| Etapa | Tempo decorrido | Rodadas | Tempo nas chamadas do modelo |
| --- | ---: | ---: | ---: |
| Admissão e preparação | 13,3 s | 0 | 0 |
| Descoberta e testes iniciais | 365,7 s | 9 | 34,5 s |
| Patches, rejeições e recuperação | 105,2 s | 7 | 80,1 s |
| Validação focada e novas regressões | 160,5 s | 8 | 82,0 s |
| Build, lint, suíte completa e revisão | 295,1 s | 9 | 55,2 s |
| Relatório e resposta final | 80,7 s | 2 | 71,7 s |

Pontos concretos:

- As chamadas somaram **323,4 segundos pelo relógio nativo do stream**, cerca de 31,7% desta rodada. Os 69% discutidos anteriormente pertenciam a outra execução. Esse relógio inclui processamento/fila do provedor e consumo do stream; não mede exclusivamente inferência na GPU.
- A barreira que aguarda a persistência acrescentou **291,8 segundos**. No turno 6 o modelo terminou em 4,06 segundos, mas o harness esperou **172,73 segundos adicionais** antes de prosseguir. Essa espera não pode ser atribuída ao modelo. O ponto ainda sem diagnóstico fino é qual operação dentro da fila de persistência/event loop/armazenamento sustentou a pausa.
- Os testes iniciais, antes da primeira tentativa de patch, bloquearam `run_command` durante **112,5 segundos**. Depois das correções, a mesma seleção de arquivos levou 12,7 segundos; essa diferença não isola o executor, porque o código defeituoso exercitava retries/timeouts e a carga de fundo também mudou.
- O lint ocupou **120,6 segundos** e terminou por timeout. O Codex não executou lint nessa rodada histórica; a avaliação externa encontrou três problemas nele. Logo, essa diferença não deve ser tratada como ganho gratuito obtido removendo validação.
- Um lote de build/typecheck/lint/diff falhou em uma chamada aninhada e ocupou 39,35 segundos. O agente consultou os resultados e executou novamente o que não tinha confirmação. A recuperação foi útil, mas custou rodadas.
- `exec_command` e `write_stdin` foram excluídas do catálogo visível pelo limite de 28 ferramentas. A sequência do CodeStudio usou comandos bloqueantes. O Codex iniciou a suíte em uma sessão persistente e continuou outras verificações. Isso identifica uma diferença de fluxo; não prova que expor essas ferramentas, isoladamente, faria o agente escolher a mesma sequência.

Os intervalos recebidos por SSE e os relógios nativos não são perfeitamente alinhados; pausas do host também atrasam os eventos. Por isso, os tempos de stream, persistência e ferramentas não são somados como se fossem categorias mutuamente exclusivas. A tabela de etapas acima é a partição sem sobreposição.

## Erro encontrado no isolamento do benchmark

O preparo configurou `projects.embeddings_enabled=0`, `search_mode='fts'` e memória do projeto desabilitada. Entretanto, o coordenador atual consulta **`semantic_profiles.embedding_target`**. Os perfis `code`, `docs` e `memory` permaneceram com o padrão local ONNX.

Os dez bancos de perfis auditados — as quatro variantes da investigação anterior e as seis desta — registram início de geração semântica. Em `release-2`, o job automático `automatic-local-project-open` indexou **106 arquivos / 3.015 itens** entre **04:33:49 e 04:40:38 UTC**, duração de 409 segundos. A tarefa inteira ocorreu entre 04:33:35 e 04:50:36 UTC.

Esse trabalho ocorreu em paralelo, incluindo a janela da pausa de 172,73 segundos. **Não são 409 segundos adicionais que possam ser subtraídos do total**, nem prova de que o ONNX causou toda a espera de persistência. Há outras pausas após o job terminar. O achado prova que a afirmação anterior de isolamento semântico estava errada e que a carga de fundo não foi controlada.

Os dois relatórios anteriores foram retificados. O script de preparação foi corrigido para desligar os três perfis semânticos reais e seus rerankers, conferir o resultado e recusar jobs inesperados antes do servidor iniciar. O script originalmente executado foi preservado como `start-benchmark-server.as-measured.mjs`. O novo preparo teve sua sintaxe verificada; uma nova rodada completa com essa configuração ainda não foi executada. Os bancos medidos e o perfil instalado do usuário não foram alterados.

## Prioridades sustentadas pelos registros

1. Estabilizar o catálogo e manter execução persistente e recuperação de saídas disponíveis; medir o efeito sobre cache e quantidade de rodadas. Respeitar limites reais de cada provedor, sem forçar o protocolo Responses aos demais.
2. Instrumentar separadamente espera na fila, escrita, flush e operações de checkpoint da persistência. A posição da pausa já é conhecida; o responsável específico pelos 172,73 segundos ainda precisa de prova.
3. Separar indexação de fundo da medição do agente: medir o sistema completo e também a execução com o índice preparado/inativo, com as condições explicitamente registradas.
4. Medir descoberta, falhas de patch, comandos de validação e relatório separadamente. Preservar revisão e regressões; economizar rodadas de consulta e recuperação redundantes.

O novo instalador entregue continua contendo as correções verificadas anteriormente. Esta análise não declara corrigidos o catálogo mutável, a pausa longa ou o agendamento de ONNX, e não alterou o binário já entregue.

## Evidências reproduzíveis

- `.tmp/harness-throughput-20261111/explain-cost-latency.mjs --summary`: reconstrói contadores, alterações de catálogo e partição por etapas; valida a soma de tempos e rodadas.
- `.tmp/harness-throughput-20261111/cost-latency-evidence.json`: resultado detalhado, contendo apenas contadores e chamadas/resultados públicos de ferramentas do Codex, sem texto privado de raciocínio.
- `.tmp/harness-throughput-20261111/read-semantic-evidence.mjs`: consulta somente leitura dos dez bancos isolados, via SQLite.
- `.tmp/harness-throughput-20261111/semantic-background-evidence.json`: perfis efetivos, jobs e gerações encontrados.
- `metrics-release-2.json`, `transport-release-2.json`, `codestudio-events-release-2.jsonl` e `server-release-2-out.log` na mesma pasta.
