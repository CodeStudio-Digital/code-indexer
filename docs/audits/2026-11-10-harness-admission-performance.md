# Admissão e desempenho do harness — 10/11/2026

## Escopo e método

Investigação do comparativo anterior de cinco correções em Ky 2.2.0. Modelo GPT 6.1 Sol, esforço `high`, mesmo prompt e mesma árvore inicial em cópias independentes. O trabalho não modifica nem reinicia a instância instalada em uso. Os servidores experimentais usam perfis temporários, porta 7442 e o mesmo Electron/Node da instalação.

O primeiro comparativo registrou 3min54,779s no Codex e 9min31,841s no CodeStudio instalado 3.16.18. Ambos passaram nas 45 verificações independentes. O CodeStudio adicionou mais regressões e corrigiu problemas apontados pelo lint; a duração não deve ser comparada sem esses resultados de qualidade.

Evidências detalhadas, prompts, hashes, eventos e logs: `.tmp/harness-comparison-20261110` e `.tmp/harness-improvements-20261110`. Os logs experimentais não são incluídos no instalador.

## Admissão no perfil existente

Uma única pasta `events/runs` ilegível fazia a recuperação global rejeitar todas as admissões. Além disso, a promessa de recuperação rejeitada permanecia em cache, tornando a indisponibilidade permanente até reiniciar o processo. As duas tentativas anteriores receberam HTTP 503 sem execução do modelo.

A inspeção somente em leitura localizou a sessão `a29adb33-abfb-4914-9b30-4ccf96362382`, projeto 10. O Windows confirmou **“O arquivo ou pasta está corrompido e ilegível”** no diretório:

```text
F:\HapVida\ProtomakerWeb\Legacy.Hapvida.Assistance.Sigah.Protocol.Protomaker.Hosp.Web\.mcp-indexer\session\a29adb33-abfb-4914-9b30-4ccf96362382\events\runs
```

Correções:

- Recuperação isolada por sessão; sessões saudáveis continuam disponíveis.
- Uma sessão com falha é reavaliada na próxima admissão, sem recuperar novamente sessões saudáveis que já começaram a trabalhar.
- Falha no catálogo global pode ser tentada novamente.
- Estado terminal do run só é gravado após recuperar tentativas e comandos, permitindo repetir uma recuperação parcialmente concluída.
- Coder e Company retornam `SESSION_RECOVERY_UNAVAILABLE` com a sessão afetada. Uma rejeição antes da execução não fica gravada como sucesso ou impede reenviar a mesma chave idempotente.

**Limite:** a correção não repara corrupção física do sistema de arquivos nem recupera o histórico dessa pasta. Nenhuma pasta de sessão do usuário foi apagada ou movida. Havia oito runs não terminais na instalação; ela foi preservada.

## Onde o tempo é gasto

Na execução anterior de 571,841s, as 36 chamadas ao modelo ocuparam 394,144s observados (69%). As ferramentas reportaram 113,912s. A admissão levou 8,867s. Os intervalos restantes incluem persistência, filas, coordenação e transporte dos eventos; não devem ser atribuídos todos à API ou todos ao disco.

Comparação de uso anterior: Codex gerou 7.380 tokens e CodeStudio 11.871; o cache correspondeu a aproximadamente 96% e 95% dos tokens de entrada, respectivamente. Mesmo provedor e nome de modelo não implicam o mesmo número de chamadas, instruções, ferramentas, contexto ou quantidade de saída. Não há evidência suficiente para afirmar que o servidor entrega menos tokens por segundo ao CodeStudio.

A nova instrumentação separa o tempo de preparação do tempo aguardando a persistência do turno. A primeira execução com melhorias de descoberta/leitura demorou 670,742s (11min10,742s), com 43 chamadas e 46,368s de espera pela persistência. **Essa rodada não demonstra ganho de velocidade do prompt.**

## Escritas de sessões

O diário da conversa acrescenta um registro por turno; ele não reescreve a conversa inteira a cada token. A gravação inclui resultados de ferramentas, metadados, métricas e confirmação em disco. O próximo turno aguarda a conclusão dessa cadeia para não executar novas ações sem um histórico durável.

Foi encontrada uma renovação atômica com sincronização do arquivo `writer.lease` em cada mutação, embora a posse tenha validade de 30 segundos e um heartbeat próprio. A correção verifica o proprietário e o fencing token em cada mutação, mas só renova a validade quando necessário. As confirmações do diário e dos dados permanecem. Uma posse expirada ou substituída continua impedindo novas escritas.

O custo de `JSON.stringify` é medido separadamente em um experimento de oito turnos com ferramentas aninhadas, incluindo fechamento e reabertura para verificar a integridade do histórico. Não se deve confundir serialização de JSON com o custo de sincronizar vários arquivos no disco.

Resultado isolado (mesmo Electron 42.5.0 / Node 24.17.0, sem outro benchmark/build simultâneo):

| Medida | Antes | Depois |
| --- | ---: | ---: |
| Gravação dos oito turnos | 10.618 ms | 6.751 ms |
| Mediana por turno | 1.300 ms | 811 ms |
| Tempo acumulado em `JSON.stringify` | 3,46 ms | 3,01 ms |
| Renovações atômicas da posse durante o trecho medido | 73 | 0 |
| Mensagens / commits / ferramentas após reabrir | 16 / 8 / 40 | 16 / 8 / 40 |

Redução de 36,4% nesse trecho de persistência. A medição posterior dura menos que o intervalo de renovação; zero renovações nesse trecho não significa heartbeat desativado. Os testes específicos verificam a renovação perto da expiração e a rejeição de proprietário substituído/expirado. Este ganho não equivale a reduzir a tarefa inteira em 36,4%.

## Chamadas ao provedor

O adapter Codex habilitava `parallel_tool_calls` e a chave estável de cache apenas para três modelos GPT 5.6. O GPT 6.1 Sol ficava explicitamente com chamadas paralelas desativadas. A lista compartilhada agora inclui os modelos Codex GPT 6 e 6.1 conhecidos. Backends desconhecidos permanecem opt-in. O executor continua paralelizando apenas leituras declaradas seguras; ações mutáveis e comandos mantêm sua ordenação.

A contabilização agora preserva `output_tokens_details.reasoning_tokens` como parcela de raciocínio, sem somá-la novamente ao total de saída. O esforço selecionado pelo usuário é preservado.

Referências oficiais: [chamadas de funções](https://developers.openai.com/api/docs/guides/function-calling) e [continuidade de raciocínio](https://developers.openai.com/api/docs/guides/reasoning).

**Pendência identificada:** o adapter reconstrói o histórico público e não preserva os itens opacos de raciocínio da Responses API. A documentação recomenda preservar esses itens entre chamadas de ferramentas. Ainda não se atribui um custo medido a essa diferença nem se declara esse transporte corrigido nesta entrega.

## Descoberta, leitura e validação

- O prompt orienta descoberta de caminhos antes de adivinhar nomes, leituras limitadas, uso das ferramentas declaradas pelo projeto e repetição de testes somente após mudanças relevantes.
- `read_file` oferece sugestões limitadas ao diretório pai autorizado quando o arquivo não existe; erros de permissão não enumeram caminhos.
- Se um lote `code_exec` falhar, resultados pequenos de leituras já concluídas e entregues continuam disponíveis ao modelo. Resultados de operações mutáveis não são reapresentados como instrução para repetir ações.
- Revisão final, lint e regressões continuam obrigatórios conforme a tarefa. Reduzir testes para obter um tempo menor não faz parte do experimento.

## Validação e medições finais

Os dois braços da dupla controlada passaram nos mesmos 45 casos independentes, no build, na checagem de tipos e no lint dos fontes alterados. O controle passou em 1.567 testes Node; o braço com melhorias em 1.547. As seis advertências do lint já existiam nos arquivos-base; não houve erro de lint.

| Rodada | Tempo total | Chamadas ao modelo | Tempo nas chamadas | Espera pela persistência | Testes independentes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Instalação 3.16.18, comparação anterior | 9min31,841s | 36 | 394,144s | não instrumentada | 45/45 |
| Controle atual | 12min34,732s | 62 | 508,753s | 56,867s | 45/45 |
| Melhorias de descoberta/leitura/prompt | 11min10,742s | 43 | 447,018s | 46,368s | 45/45 |
| Conjunto final, incluindo posse e configuração Codex | 10min48,362s | 42 | 450,175s | 26,997s | 45/45 |

A ordem foi melhorias → controle, sequencialmente. A diferença de 11,1% nessa dupla não estabelece ganho geral: há apenas uma execução por braço, os modelos produziram quantidades diferentes de testes e a rodada anterior foi mais rápida. As correções de posse e configuração do provedor foram compiladas depois dessa dupla e não estão nesses dois tempos.

A terceira rodada usou outra cópia idêntica e perfil novo, sem builds ou outros benchmarks simultâneos. Passou em **1.559 testes Node**, build, tipos, lint e 45/45 casos independentes. Realizou 61 chamadas de ferramentas em 42 chamadas ao modelo, com 13.221 tokens de saída, incluindo 3.482 de raciocínio. Aproximadamente 95% dos tokens de entrada vieram do cache. A soma de durações de ferramentas pode incluir sobreposição; `toolBusyMs` mede a união dos intervalos e evita contá-la duas vezes.

O total caiu 14,1% contra o controle atual e 3,3% contra o braço com melhorias de prompt/leitura, mas continua acima dos 9min31,841s da primeira rodada e dos 3min54,779s do Codex. Não está demonstrada equivalência de desempenho. A queda na espera de persistência de 46,368s para 26,997s é consistente com o experimento isolado; as execuções completas têm escolhas de ferramentas e regressões diferentes, portanto não constituem uma ablação perfeita de cada alteração. Quantidade de casos de teste também não é, por si só, medida de qualidade: testes parametrizados podem representar a mesma cobertura com contagens distintas.

Validação adicional: 146 testes passaram em 22 arquivos, cobrindo armazenamento, injeção de falhas, recuperação, fencing, provider, sockets, chamadas em lote e barreira de persistência. Antes disso, 90 testes de admissão/rotas e 127 de ferramentas haviam passado. Compilação TypeScript concluída.

Os três perfis de benchmark foram encerrados e as credenciais temporárias removidas, com contagem final zero de OAuth e chaves de API. A instância original permaneceu ativa na porta 7333.

## Instalador entregue

[CodeStudio Setup 3.16.20.exe](../../dist/electron-harness-admission-3.16.20-20261110/CodeStudio%20Setup%203.16.20.exe)

- Tamanho: 341.077.776 bytes; versão do executável e do pacote: 3.16.20.
- SHA-256: `F8A8898FB99565CB77789147FF16CDD90D3AC6EF8951EB872EA976459FC3AC4A`.
- 4.184 arquivos empacotados conferiram por hash com o runtime preservado do teste final; nenhuma divergência.
- Fechamento de dependências: 2.489 módulos e 43 pacotes, sem módulo ausente.
- Smoke em perfil temporário: renderer, assets, imagens MCP, deep link, indexador, scripts QuickJS, conversão HTML e visão de imagem/vídeo passaram.
- Instalador gerado e verificado, sem instalar ou publicar. Assinatura Authenticode: `NotSigned`.

O pacote inclui o estado existente do workspace, incluindo as correções anteriores de memória, fila de mensagens e abertura de projetos. As mudanças desta investigação e suas validações estão descritas acima; este teste não certifica todos os fluxos React, Company, MCP externo ou sessões longas.
