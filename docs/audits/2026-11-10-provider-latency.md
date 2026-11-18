# Latência de inferência e persistência — CodeStudio 3.16.21

Status: implementação, quatro execuções e pacote verificados; meta de velocidade ainda pendente. Data local: 10/11/2026.

**Retificação em 11/11/2026:** os quatro bancos isolados desta rodada confirmam que os perfis semânticos permaneceram em ONNX e iniciaram geração em segundo plano. Os campos antigos usados pelo preparo do benchmark não desligaram esse mecanismo. Os totais continuam sendo medições reais, mas o experimento não isolou inferência de indexação local. Veja a [investigação por turno e correção do método](2026-11-11-harness-cost-latency-causes.md).

**A meta de se aproximar do Codex ainda não foi alcançada.** A entrega levou 9min21s contra 9min30s da referência refeita nesta rodada: diferença de 1,6%, insuficiente para afirmar melhora consistente. As correções removeram custos locais comprovados, mas o tempo total continua dominado por inferência e decisões do agente. Todos os resultados, inclusive as candidatas mais lentas, estão abaixo.

## Diagnóstico

A execução anterior de 3.16.20 consumiu 648.362 ms: 42 chamadas ao modelo somaram 450.175 ms (69,4%), ferramentas ocuparam 159.541 ms e a espera por persistência somou 26.997 ms. São medições do cliente, não tempos internos da fila ou da GPU do provedor. Os artefatos estão em `.tmp/harness-improvements-20261110` e o relatório anterior em `2026-11-10-harness-admission-performance.md`.

A conversa já ficava na RAM do runner. As operações de arquivo já utilizavam I/O assíncrono; o problema era aguardar o fechamento da transação anterior antes de chamar o modelo. O microbenchmark anterior mediu cerca de 3 ms de `JSON.stringify` contra segundos de gravações duráveis. Trocar JSON por outro formato, isoladamente, não explica nem resolve os 69%.

No adaptador ChatGPT/Responses, a conversão reconstruía apenas texto público e chamadas de função. Os itens de continuação retornados pela API eram descartados. Também não havia conexão WebSocket persistente nem `text.verbosity` explícito. O catálogo local do Codex para `gpt-6.1-sol` indica `default_verbosity=low`, `default_reasoning_summary=none` e `apply_patch_tool_type=freeform`; o CodeStudio já usava o formato freeform e o esforço `high` nesta comparação.

Esses achados não provam qual transporte foi usado pela execução anterior do Codex: não temos seu trace HTTP bruto. Seu `turn_context` confirma `gpt-6.1-sol/high`, mas não registra a prioridade efetiva do serviço. A configuração local atual indica o tier padrão, sem provar o tier daquela execução. A comparação usa os artefatos da execução, os parâmetros locais observados e os contratos oficiais, sem supor detalhes internos do cliente.

A medição da primeira candidata revelou um defeito adicional no caminho real: `PluginChatProvider.chat` construía outro cliente a cada chamada. O cache existente guardava apenas o módulo do plugin. Por isso, os clientes perdiam conexão/pool entre turnos e o host não expunha suas capacidades; a candidata ainda esperava a persistência e fazia outro handshake a cada turno. A hipótese inicial de que a limpeza do request fechava a conexão foi descartada: o teste integrado confirmou que a causa era a recriação do cliente. Esse defeito atinge o host comum de provedores, não apenas o adaptador ChatGPT.

## Correções

- O host de plugins mantém um cliente por instância e modelo. Inicializações concorrentes compartilham a mesma promessa; falhas de criação podem ser tentadas novamente. Trocar modelo recria opções específicas, e instâncias/credenciais diferentes não compartilham estado. As capacidades reais passam pelos wrappers de plugins, orçamento e subagentes. O primeiro acesso a um plugin ainda desconhecido continua conservador.
- O núcleo pode iniciar inferência enquanto a gravação anterior termina. Antes de registrar a nova resposta, executar ferramentas ou concluir, exige a confirmação durável. Uma falha cancela o request e impede efeitos adicionais. Provedores desconhecidos e caminhos com ferramentas executadas no servidor mantêm a barreira anterior.
- A capacidade de inferência sem efeitos foi verificada nos adaptadores Anthropic, Gemini, Bedrock, Kimi, OpenAI compatível sem injeções de gateway e ChatGPT sem geração de imagem no servidor. Os wrappers preservam essa capacidade. Não se aplica a extensão desconhecida por inferência do nome do modelo.
- Medições comuns a todos os provedores: primeiro evento, primeiro conteúdo, tempo total do stream, custo dos callbacks locais e duração/espera da persistência. Metadados nativos mais precisos são preservados. Não são inventados tempos de cabeçalho para SDKs que não os expõem.
- Responses preserva os itens originais em ordem, inclusive raciocínio criptografado, fases públicas e chamadas customizadas. A continuação é vinculada à conta, endpoint, modelo e conteúdo canônico. Edições e compactação invalidam o replay incompatível; outros adaptadores não o recebem como texto. O estado sobrevive à reabertura e fica fora das linhas públicas do chat/SSE.
- Respostas simples sem raciocínio também preservam IDs de itens. Esse caso foi descoberto na primeira prova real, corrigido e coberto por regressão.
- WebSocket habilitado para o endpoint oficial ChatGPT já verificado. Uma conexão por sessão, cache limitado, envio incremental somente com prefixo/configuração compatíveis e encerramento por inatividade. Cancelamento, reconexão, compactação e troca de sessão não reutilizam referências incompatíveis. Um `previous_response_not_found` anterior à geração permite uma única repetição com contexto completo; falhas após saída parcial não são mascaradas. Se o upgrade falha antes do envio, usa HTTP/SSE.
- Verbosidade `low` nos modelos Codex com capacidade conhecida; esforço escolhido pelo usuário preservado. Não foi ativada prioridade paga nem reduzida a cobertura de validação.
- O prompt comum orienta agrupar alterações relacionadas e suas regressões, aproveitar testes que já reproduzem o defeito, usar correções mecânicas configuradas pelo projeto somente nos arquivos alterados e revisar o diff. Na rodada de entrega, o agente efetivamente usou `xo --fix` e depois conferiu o diff. A confirmação de uma gravação bem-sucedida evita releitura sem mudança externa; escrever o relatório não invalida verificações anteriores. Isso não substitui revisão nem testes afetados por alterações posteriores.

Configurações de diagnóstico: `CODEX_WEBSOCKET_MODE=0` desliga o novo transporte; `CODER_OVERLAP_PERSISTENCE=0` mantém a espera anterior. Nenhuma dessas opções muda o esforço de raciocínio.

## Verificações técnicas

- 51 suítes / 398 testes passaram no runtime Electron. Incluem todos os adaptadores, cancelamento, limites e parâmetros de raciocínio, cache, término do stream, persistência, SSE e recuperação WebSocket.
- Após a correção do caso sem raciocínio, 26 testes direcionados passaram, incluindo uma regressão adicional (399 casos distintos verificados nesta rodada; não somar execuções repetidas).
- Após encontrar a integração incompleta, passaram 64 testes em oito arquivos: incluem o host de plugins, credenciais distintas, troca de modelo durante inicialização, retry de criação, orçamento, subagentes e duas chamadas Responses atravessando plugin + wrappers + consumidor de stream + WebSocket local. Essa execução contém testes repetidos das suítes anteriores.
- Build TypeScript completo passou.
- Prova real de duas chamadas com `gpt-6.1-sol/high`: ferramenta simulada, resposta concluída, mesma conexão e segunda chamada incremental enviando apenas um item. A conexão inicial levou aproximadamente 334 ms; a preparação da continuação, 0,17 ms. Isso confirma o protocolo; não é um benchmark representativo da tarefa de programação.
- Credenciais da prova real lidas somente em memória; nenhuma renovação de token ou modificação do perfil instalado.

## Comparativo controlado

Mesma biblioteca Ky 2.2.0, cinco defeitos semeados, prompt do usuário e cópias com hashes idênticos, mesmo `gpt-6.1-sol/high`, uma execução por variante, ordem 3.16.20 → transporte inicial → integração corrigida → orientação final, perfis descartáveis separados, sem memória do projeto/MCP externo. A busca semântica deveria estar desligada, mas seu perfil permaneceu ativo; veja a retificação acima. As execuções não concorreram com nossos builds ou suítes externas. Projetos e evidências: `.tmp/harness-provider-performance-20261110`.

- Commit de seed: `8baf0cadd8ca66659d6e86b2ebf4583e2f15bcb4`.
- Hash dos arquivos: `cb60a66e7f4d63474396cbb093efff1aade678082f1419181ed13700d4043f58`.
- SHA-256 do prompt: `561f9eacf7b571f25ccbfc8173c5cd7dbec999772f75afdf990af0035489cecb`.
- Avaliador independente: 45 verificações funcionais, mais build, tipos, lint dos fontes alterados e suíte Node completa. Resultados dos participantes não são corrigidos pelo avaliador.

| Medida | Referência 3.16.20 | Transporte inicial | Integração corrigida | Entrega 3.16.21 |
| --- | ---: | ---: | ---: | ---: |
| Pasta da evidência | `baseline` | `candidate` | `final` | `optimized` |
| Tempo total | 570.069 ms (9min30s) | 648.852 ms (10min49s) | 656.532 ms (10min57s) | 560.688 ms (9min21s) |
| Admissão | 28.245 ms | 8.793 ms | 11.087 ms | 10.293 ms |
| Chamadas ao modelo | 29 | 46 | 39 | 37 |
| Tempo nas chamadas | 357.120 ms | 460.363 ms | 438.116 ms | 407.328 ms |
| Espera da persistência antes das chamadas, arredondada | 23.199 ms | 29.004 ms | 0 ms | 0 ms |
| Tempo ocupado por ferramentas | 160.082 ms | 148.730 ms | 204.374 ms | 139.358 ms |
| Tokens de entrada | 1.635.028 | 2.714.280 | 1.875.088 | 2.108.165 |
| Tokens de saída, incluindo raciocínio | 11.904 | 14.268 | 14.608 | 11.604 |
| Tokens de raciocínio | 2.512 | 4.175 | 4.802 | 2.916 |
| Suíte Node independente | 1.547 aprovados | 1.565 aprovados | 1.543 aprovados | 1.554 aprovados |
| Aceitação externa | 45/45 | 45/45 | 45/45 | 45/45 |

Todas passaram build, tipos, lint dos fontes (zero erros, seis avisos preexistentes) e diff check. O avaliador não alterou o código dos participantes. Os fontes TypeScript das duas últimas variantes são idênticos: os manifests comprovam que somente `dist/packages/code-agent/src/prompts/build.txt` mudou entre elas.

O tempo nas chamadas aumentou 14,1% entre a referência contemporânea e a entrega, apesar da remoção da espera por persistência. A entrega fez oito chamadas adicionais. Portanto, não é correto descrever essa rodada como aceleração comprovada da inferência. A admissão da referência demorou 18 segundos a mais, por si só maior que a diferença de nove segundos no total. Os resultados anteriores de 10min48s e 9min32s também permanecem registrados; não usamos apenas o mais lento como denominador para anunciar ganho.

## Decomposição dos 69% e limite da comparação

Na entrega, as operações de provedor somaram 407,3 segundos, 72,6% do total. A porcentagem pode aumentar quando outro custo é removido; o que importa também é o tempo absoluto. Os diagnósticos nativos estavam disponíveis para 36 das 37 chamadas; o total de 37 e seus tempos vêm dos eventos SSE, independentemente dessa lacuna.

Nas 36 chamadas com diagnóstico nativo:

- O stream somou 391,1 segundos; 249,5 segundos decorreram até o primeiro conteúdo (texto, resumo visível ou argumentos de ferramenta). A mediana foi 7,62 segundos. Esse intervalo inclui processamento/raciocínio/fila do provedor; o cliente não consegue separá-los.
- A preparação/conexão somou 464 ms; a mediana foi 2,54 ms. O primeiro evento chegou com mediana de 187 ms. Isso distingue chegada do protocolo de chegada de conteúdo útil.
- Houve 27 continuações incrementais. Prefixos/configurações diferentes usaram o contexto completo, preservando a correção.
- As gravações duraram 27,3 segundos somados, sobrepostos à inferência. A espera adicional da barreira foi 0,15 ms somado, sem retirar a confirmação antes de efeitos de ferramentas.
- Os callbacks locais de texto/raciocínio/início de ferramenta somaram 13,3 ms. Isso não mede toda a CPU da aplicação, mas não sustenta a hipótese de que esses callbacks expliquem os minutos de stream.

Os tokens de entrada tiveram 92,3% de cache na entrega. A referência histórica do Codex concluiu em 234.779 ms (3min55s), com 25 atualizações únicas de uso, 7.380 tokens de saída e 1.870 de raciocínio. Passou nos 45 casos e 1.529 testes Node; a avaliação independente encontrou três erros de lint nos fontes. O CodeStudio de entrega fez 37 chamadas, gerou 11.604 tokens de saída e 2.916 de raciocínio. Essas diferenças de trabalho solicitado ao modelo são observáveis; não provam uma causa única nem que ambos receberam a mesma prioridade interna do serviço.

A conclusão é limitada: removemos gargalos locais reais e corrigimos continuidade/ciclo de vida, mas **não demonstramos aproximação do tempo total do Codex**. O próximo experimento precisa manter prioridade/horário observáveis e comparar também saídas, rodadas e a fase de revisão, com ordem alternada e mais de uma execução. Reduzir `high`, esconder falhas de lint ou retirar testes não foi usado para melhorar o número. O benchmark real desta rodada usa Sol; compatibilidade dos demais adaptadores foi verificada por testes, não por um benchmark pago completo de cada modelo.

## Integridade e entrega

### Adendo: atribuição por etapa e defeito encontrado após o empacotamento

O detalhamento pedido posteriormente foi recalculado a partir dos eventos existentes, sem novas chamadas pagas. Script reproduzível: `.tmp/harness-provider-performance-20261110/latency-attribution.mjs`; dados: `latency-attribution.json`. A partição confere os 560.688 ms e as 37 chamadas. Os marcos são chamadas públicas de ferramentas, sem inspeção do raciocínio interno do modelo.

| Etapa observada | Tempo decorrido | Chamadas ao modelo | Tempo nas chamadas |
| --- | ---: | ---: | ---: |
| Admissão | 10,3 s | 0 | 0 |
| Descoberta e verificação inicial, antes de gerar o primeiro patch | 95,3 s | 11 | 60,9 s |
| Primeiro patch, diagnóstico e correção do arquivo corrompido | 115,0 s | 7 | 86,3 s |
| Escrita de regressões adicionais | 90,8 s | 4 | 87,5 s |
| Lint, suíte final e revisão do diff | 151,7 s | 9 | 80,1 s |
| Relatório e fechamento após a revisão | 97,6 s | 6 | 92,6 s |

No total, 407,3 s (72,65%) estiveram em chamadas ao modelo, 139,4 s (24,85%) em intervalos ocupados por ferramentas, 10,3 s na admissão e 3,7 s nas demais transições/preparação. As linhas por etapa incluem trabalho necessário; não representam uma lista de tempos inteiramente removíveis.

**Foi encontrado um defeito real no editor do harness.** Ao receber um único bloco `@@` com várias alterações separadas por contexto, o parser dividia o bloco e o aplicador procurava cada fragmento desde o início do arquivo. No benchmark, o último `return value` da alteração de `cloneDeep` foi substituído dentro de `cloneShallow`. A ferramenta informou sucesso, mas o build revelou a corrupção. Do primeiro build falho até build/testes focados aprovados decorreram **58.678 ms**, com quatro chamadas ao modelo somando **38.685 ms**. Essa janela inclui revalidação necessária e não equivale a ganho medido após corrigir o defeito.

O código agora conserva o vínculo entre os fragmentos e aplica o contexto do bloco inteiro, mantendo linhas vazias. A correção está em `packages/code-agent/src/tools/apply-patch.ts` e atende tanto chamadas freeform quanto function de outros provedores. Duas regressões, LF e CRLF, falharam antes; após a correção, **46/46 testes** de patch e navegação entre projetos passaram. TypeScript sem emissão passou com acesso normal às dependências. A primeira tentativa no sandbox falhou antes de coletar os testes por `EPERM` no cache do Vitest; ela não foi contada como resultado de regressão.

Outros custos observados:

- Uma chamada de lint presumiu `node_modules/xo/cli.js`, que não existe nessa instalação. O agente precisou consultar o erro e mudar para o executável configurado. O erro não foi de inferência ou de transporte.
- O fechamento consumiu seis chamadas e 97,6 s, com leitura do progresso, busca do arquivo do relatório, gravação, resposta final e nova checagem de tipos. A resposta do turno 35 já anunciava a conclusão; o turno 36 executou novamente o typecheck após gravar apenas o relatório. O relatório era exigido pelo benchmark, mas sua escrita não alterou os fontes TypeScript. Essa revalidação permanece uma oportunidade concreta de redução de rodadas.
- O CodeStudio gerou **11.604 tokens de saída**, contra **7.380** no Codex (**57,2% a mais**), e 2.916 tokens de raciocínio contra 1.870 (**55,9% a mais**). Também escreveu 27 regressões novas, contra duas; ambos passaram no avaliador de 45 casos, mas o Codex deixou três erros de lint. Portanto, o trabalho realizado não foi idêntico mesmo com o mesmo pedido.
- O cache cobriu 92,34% da entrada no CodeStudio e 95,83% no Codex. A entrada não coberta foi 161.541 contra 68.774 tokens. Uma chamada do CodeStudio teve cache zero apesar de o hash de prefixo, fingerprint de ferramentas e tamanho do sistema permanecerem iguais ao turno anterior; esses registros não explicam a decisão interna de cache do provedor.
- As 37 chamadas do CodeStudio são medidas diretamente. As 25 do lado Codex são **atualizações únicas do contador público de uso**, não um trace que prove o número exato de requests físicos.

O JSON em disco já não explica a maior parte da demora desta execução: nas 36 chamadas instrumentadas, a espera adicional pela persistência somou **0,15 ms**, enquanto o tempo até primeiro conteúdo somou **249,5 s**, mediana **7,62 s**. Esse tempo antecede texto/resumo público/argumentos de ferramenta; fila, processamento de contexto e raciocínio no servidor continuam indistinguíveis no cliente.

Mesmo a diferença total de 9,4 s frente à referência contemporânea requer cuidado: retirando a admissão, a referência levou **541,8 s** e a entrega **550,4 s**. Não houve ganho demonstrado no trabalho após admitir a sessão. Ainda faltam repetições alternadas para estimar variância e medir o efeito isolado da correção do patch.

**Escopo da nova correção:** os 9min21s e o instalador 3.16.21 abaixo são anteriores a esse reparo do `apply_patch`. A correção adicional está no código e foi testada; o instalador existente não foi substituído, nem foi anunciado novo resultado de desempenho.

Os quatro servidores foram encerrados por PID/horário/executável conferidos, e os quatro perfis temporários ficaram com zero registros OAuth e zero chaves de API. Nenhum refresh token foi copiado. A instalação 3.16.18 e seu perfil original foram preservados. As evidências incluem `metrics-*.json`, `transport-*.json`, `*-independent-verification.json`, `acceptance-*.json`, `runtime-*-hashes.json`, `native-context.json` e `auth-cleanup-*.json` na pasta do experimento.

Instalador: [CodeStudio Setup 3.16.21.exe](<D:/MCP/dist/electron-provider-performance-3.16.21-20261110/CodeStudio Setup 3.16.21.exe>).

- Versão do executável: `3.16.21`; tamanho: 341.088.225 bytes.
- SHA-256: `AF5502A9251A5FCE62CB5D881609EC7CACD130B0D08490424BE995EE1F39E447` (também no arquivo `.exe.sha256`).
- Assinatura Authenticode: `NotSigned`.
- 4.190 arquivos empacotados comparados com o runtime `optimized`: nenhuma divergência.
- Grafo do pacote: 2.492 módulos e 43 pacotes alcançáveis, sem dependências ausentes.
- Provas em perfil descartável: renderer, deep link, indexador em worker, QuickJS/WASM, conversão HTML e processamento de imagem/vídeo passaram.
- O instalador foi gerado, não instalado nem publicado. Nenhum commit/push foi feito nesta etapa.

## Fontes primárias

- [Continuação de raciocínio e itens criptografados](https://developers.openai.com/api/docs/guides/reasoning).
- [WebSocket, envio incremental e recuperação de referências](https://developers.openai.com/api/docs/guides/websocket-mode).
- [Limites da integração ChatGPT/app-server](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
- [Configuração do Codex](https://learn.chatgpt.com/docs/config-file/config-reference).

As exigências específicas de cada API ficam nos adaptadores. Os mecanismos de persistência, cancelamento e medição permanecem no harness comum.
