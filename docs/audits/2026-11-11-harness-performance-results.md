# Desempenho do harness — CodeStudio 3.16.23

Estado: correções funcionais, comparação e pacote 3.16.23 validados. Não foi demonstrado ganho global de velocidade nem atingida a meta de reduzir rodadas. O instalador foi gerado e verificado, sem substituir a instalação do usuário.

## Comparação final

| Versão | Tempo | Chamadas/ciclos | Entrada total | Entrada sem cache | Saída |
| --- | ---: | ---: | ---: | ---: | ---: |
| CodeStudio 3.16.22 — mediana de 3 | 8min51,8s | 34 | 1.921.926 | 100.656 | 12.046 |
| CodeStudio 3.16.23 — mediana de 3 | 9min8,9s | 44 | 2.714.664 | 78.790 | 13.740 |
| Codex contemporâneo — 1 execução | 7min57,6s | 26 ciclos públicos | 2.030.610 | 94.994 | 16.009 |

As medianas são calculadas separadamente para cada métrica. Os ciclos do Codex vêm do registro público de uso.

| Repetição final | Tempo | Chamadas | Entrada sem cache | Casos externos | Testes Node |
| --- | ---: | ---: | ---: | ---: | ---: |
| candidate-5 | 10min38,5s | 44 | 78.504 | 45/45 | 1555 |
| candidate-6 | 9min8,9s | 48 | 102.444 | 45/45 | 1549 |
| candidate-7 | 7min28,2s | 40 | 78.790 | 45/45 | 1541 |

Variações das medianas frente à 3.16.22: tempo **3,2%**, chamadas **29,4%**, entrada total **41,2%**, entrada sem cache **-21,7%**. A mediana final corresponde a **1,15×** o tempo da referência Codex.

Faixa de tempo da referência: 8min2,7s a 10min8,2s. Faixa final: 7min28,2s a 10min38,5s. Três amostras não sustentam um p95 de tarefa.

| Meta | Resultado |
| --- | --- |
| Reduzir chamadas em 25% | Não atingida |
| Reduzir entrada sem cache em 30% | Não atingida |
| Mediana até 1,25× o Codex contemporâneo | Atingida neste recorte |

| Repetição final | Tempo observado no modelo | Ocupação das ferramentas | Espera adicional de persistência | p95 da espera de persistência por turno | Catálogos |
| --- | ---: | ---: | ---: | ---: | ---: |
| candidate-5 | 8min50,9s | 1min29,3s | <1 ms | <1 ms | 1 |
| candidate-6 | 7min19s | 1min22,2s | 6.832 ms | <1 ms | 1 |
| candidate-7 | 5min36,8s | 1min28,4s | 5.704,8 ms | <1 ms | 1 |

Os intervalos podem se sobrepor. Ocupação das ferramentas mede as chamadas observadas, não toda a vida de processos executados em segundo plano. A espera de persistência é apenas o trecho adicional que bloqueou o próximo passo; duração de I/O sobreposta à inferência não é atraso somável.

Avaliação independente da coorte final: **aprovada em todas as repetições**. Foram executados build, typecheck, lint dos fontes alterados, suíte Node, diff-check e os mesmos 45 casos externos, sem corrigir os participantes.

As correções de catálogo, comandos e aspas foram validadas, mas a meta de reduzir as rodadas não foi atingida. A menor entrada sem cache veio acompanhada de maior entrada total e saída; não há base para declarar economia financeira geral. A mediana das médias de tempo observado por chamada ficou próxima: 9,29 s na referência e 9,15 s na candidata. O agrupamento de trabalho caiu de 1,71 para 1,27 chamadas de ferramenta por rodada. Esses dados localizam o gargalo restante no número e na composição das rodadas, sem provar qual mudança de prompt ou ferramenta causou a diferença. Uma nova alteração nesse ponto precisa de comparação própria.

## Alterações implementadas

- Catálogo público estável durante descoberta. `find_tools` entrega o schema completo e a chamada pode ser feita pelo `code_exec` existente. Mudanças reais de autorização, schema ou disponibilidade continuam invalidando a projeção. O despacho genérico usa o mesmo controle de permissões.
- `apply_patch`, execução persistente e recuperação de saída permanecem disponíveis no núcleo autorizado. O teto interno não pode expulsá-los; limites verificados do provedor continuam sendo respeitados.
- Diagnósticos derivados são agrupados em uma fila limitada e gravados fora da barreira da conversa. Quando há um worker proprietário, a telemetria segue esse proprietário. Intenções, resultados, conversa, consumo e estado necessários à recuperação continuam duráveis antes do próximo efeito.
- Instrumentação de fila, lease, serialização, escrita, fsync, rename e persistência por turno. A exportação é opcional, limitada e não contém o texto da conversa. Foram acrescentados os motivos de perda da continuação WebSocket.
- Comandos longos podem continuar em sessões persistentes. Uma consulta vazia de `write_stdin` espera até 10 segundos por padrão, retornando antes se o processo terminar. No Windows, esperas positivas de início têm mínimo de 10 segundos e consultas vazias de 5 segundos. Zero continua retornando imediatamente; entrada interativa preserva a espera curta. Cancelamento interrompe a espera. A descrição deixou de desencorajar execução persistente para testes e de recomendar `list_sessions` antes de cada uso de um ID conhecido.
- Corrigido o lançamento de scripts `cmd.exe` em pipe e PTY: a linha de comando preserva as aspas do script, em vez de receber o escape de argumentos CRT que fazia filtros como `"test/*.ts"` chegarem com aspas literais. Execução direta por argv e PowerShell mantêm seus contratos próprios.
- Prompt de execução orienta localização de caminhos, leituras focadas, patches agrupados e reaproveitamento de verificações ainda válidas. A revisão final e os testes continuam necessários. Escrever somente o relatório não invalida a validação do código.
- Inferência ONNX local usa até dois threads internos, lotes menores e intervalos entre trabalhos de fundo. Consultas interativas têm prioridade. A pressão medida no processo/worker reduz o orçamento de manutenção, sem polling ocioso.

As mudanças compartilhadas não dependem de Responses ou de WebSocket. Os adaptadores de OpenAI API, Anthropic, Gemini e outros continuam usando seus próprios protocolos. Continuação WebSocket é específica do adaptador ChatGPT compatível.

## Método e limites

Referência: runtime 3.16.22 congelado antes destas alterações. Candidata: runtime 3.16.23 congelado depois dos testes. Cópias distintas do mesmo Ky, commit `8baf0cadd8ca66659d6e86b2ebf4583e2f15bcb4`, com as mesmas cinco tarefas, dependências e esforço `high` no `gpt-6.1-sol` via ChatGPT. O desenho final tem três execuções da referência e três da candidata final. Um piloto e três execuções intermediárias permanecem separados e documentados.

As primeiras execuções intermediárias foram intercaladas com referências. Após encontrar as diferenças de espera e de aspas no Windows, a candidata mudou; o último runtime congelado é `runtime-release-final`. As três repetições finais vêm depois das referências. Portanto, a coorte final não tem ordem alternada, o que limita o controle de variação temporal do serviço. Os resultados intermediários não foram incluídos na mediana final nem apagados.

Hash dos 116 arquivos iniciais: `705a82a6b1dfa1a0339e69d065f46caa938f20211a4f507bae7ad87a3e02fedb`. Hash do prompt CodeStudio: `561f9eacf7b571f25ccbfc8173c5cd7dbec999772f75afdf990af0035489cecb`. Na referência Codex mudou somente o caminho de fallback da cópia de trabalho.

Os perfis semânticos efetivos de código, documentos e memória foram desativados nas cópias descartáveis. Não basta alterar os antigos campos `embeddings_enabled` e `search_mode`: o coordenador atual usa `semantic_profiles`. Não houve alteração dessas opções no perfil instalado. Tokens de autorização foram copiados somente para os perfis isolados, sem refresh token, e apagados ao encerrar cada servidor.

Nenhum build, teste do avaliador ou teste ONNX foi executado durante os tempos dos agentes. As avaliações independentes ocorreram depois de cada execução. A máquina continuou disponível ao usuário; a carga global passou a ser registrada nas repetições finais. Não há amostragem global equivalente para a primeira referência, o piloto ou o chat Codex.

Uma nova referência Codex foi criada no chat `01a1caf5-4496-74e0-b20c-7213addd6efb`, sem intervenção do avaliador. Seus ciclos são contados pelas atualizações públicas de uso, não por acesso à implementação interna do serviço. Há uma execução Codex contemporânea, insuficiente para estimar sua dispersão. Os adaptadores adicionais foram testados por contratos e regressões locais; o desempenho real com LLM foi medido apenas com o modelo escolhido.

Entrada total, entrada com cache, entrada sem cache e saída são métricas distintas. Não são uma fatura: não foi aplicado preço hipotético a tokens de uma assinatura ChatGPT. Tempos observados no stream não isolam o tempo de computação remoto do provedor. Tempo de comandos em segundo plano não pode ser somado à espera do modelo como se os intervalos não se sobrepusessem.

## Referências, piloto e execuções intermediárias

| Execução | Tempo | Chamadas/ciclos | Entrada total | Entrada sem cache | Saída |
| --- | ---: | ---: | ---: | ---: | ---: |
| Referência 3.16.22, rodada 1 | 8min51,8s | 32 | 1.718.960 | 100.656 | 12.890 |
| Piloto 3.16.23, separado | 8min43,2s | 58 | 3.637.039 | 161.071 | 11.696 |
| Intermediária 3.16.23, rodada 1 | 8min34,5s | 44 | 2.616.525 | 76.237 | 12.374 |
| Referência 3.16.22, rodada 2 | 10min08,2s | 50 | 2.463.020 | 78.252 | 12.046 |
| Intermediária 3.16.23, rodada 2 | 8min50,3s | 41 | 2.429.127 | 77.511 | 12.585 |
| Referência 3.16.22, rodada 3 | 8min02,7s | 34 | 1.921.926 | 119.814 | 11.107 |
| Intermediária com espera corrigida | 9min27,8s | 53 | 3.164.857 | 78.521 | 13.948 |
| Codex contemporâneo | 7min57,6s | 26 ciclos públicos | 2.030.610 | 94.994 | 16.009 |

O piloto não demonstrou ganho e não foi descartado da documentação. A proteção de `apply_patch` estava incompleta sob o teto interno; foi corrigida antes das execuções intermediárias. Isso é um defeito de seleção confirmado, não prova de que ele sozinho causou as 58 chamadas do piloto.

Na primeira intermediária, a redução de espera por ferramentas foi em grande parte compensada por mais chamadas ao modelo. O catálogo não mudou e a espera adicional de persistência foi inferior a 1 ms no conjunto da execução. A entrada sem cache caiu 24,3% frente à primeira referência, mas a entrada total aumentou 52,2%. Não se deve resumir isso como uma redução geral de consumo.

O registro contemporâneo do Codex revelou uma diferença concreta: pedidos de `exec_command` com `yield_time_ms: 1000` tiveram espera efetiva de até 10 segundos no Windows. Três comandos de aproximadamente 2,6 a 4,2 segundos voltaram completos na primeira chamada. O CodeStudio podia devolvê-los ainda em execução após um segundo, exigindo nova chamada ao modelo para consultar. A política final alinha essa espera, mantendo zero explícito para sobreposição útil. Isso é evidência de comportamento observado, não acesso à implementação privada do Codex.

A terceira intermediária (`candidate-4`) expôs outro defeito: filtros de testes válidos eram transmitidos com aspas literais pelo lançamento de `cmd.exe`. O agente recebeu falhas de descoberta de testes, precisou ler logs e repetir comandos. Três regressões reais de shell/PTY falharam antes da correção e passaram depois. A bateria integrada de comandos, incluindo PowerShell, argv, permissões e cancelamento, passou em 133/133 casos. `candidate-5` foi pausada antes de criar servidor ou enviar tarefa; a coorte final usa `candidate-5`, `candidate-6` e `candidate-7` com o mesmo runtime corrigido.

O atraso antigo de 172,7 segundos após uma resposta não se repetiu na nova referência nem nas intermediárias. A rodada antiga misturou indexação ONNX e execução do agente; seus 409 segundos de indexação eram sobrepostos e não podem ser subtraídos do total. As melhorias de escrita já entregues na 3.16.22 fazem parte da nova referência, não podem ser atribuídas novamente à 3.16.23.

Na primeira intermediária, as 383 serializações atômicas instrumentadas somaram 3,38 ms e as 45 serializações do journal somaram 0,89 ms. O maior commit observado levou 4,98 segundos, dos quais uma operação de fechamento de arquivo consumiu 2,66 segundos; o event loop esteve ativo por 104 ms durante esse commit. O trabalho se sobrepôs à chamada seguinte ao modelo e não criou espera adicional relevante nessa rodada. Portanto, este registro aponta espera de arquivo/fila, não custo de converter a conversa para JSON. Não identifica por si só qual componente do sistema operacional causou a espera.

Na segunda repetição final (`candidate-6`), o turno 12 registrou uma pausa adicional de 6.831,9 ms. O commit da mensagem 11 levou 9.533,8 ms, e a chamada seguinte ao modelo levou 2.696,9 ms. O trace dessa gravação registrou `atomic.fsync` de até 2.159,0 ms, `journal.fsync` de 1.711,2 ms, abertura de arquivo de 1.557,9 ms, escrita de 1.392,1 ms e espera na fila de 908,7 ms; o event loop esteve ativo por apenas 31,0 ms. A operação foi identificada, sem retirar a garantia de durabilidade. Isso representa aproximadamente 1,24% da tarefa; o p95 por turno abaixo de 1 ms não deve esconder essa cauda. A causa inferior à API de arquivos — sistema de arquivos, driver, competição externa ou outra — não foi isolada.

Na terceira repetição final (`candidate-7`), o turno 6 acrescentou 5.704,7 ms. A mensagem 5 aguardou 9.718,2 ms na fila de mutações; a operação que já ocupava essa fila foi `FsProviderAttemptRepository.record`, com duração de 9.726,9 ms. Esse registro contabiliza a tentativa do provedor e atualiza `summary.json`; teve 5.203,8 ms acumulados em fsync, 2.150,3 ms em escrita e 1.252,0 ms em rename. O commit da conversa levou 13.543,5 ms, parcialmente sobreposto à chamada ao modelo. A espera adicional foi aproximadamente 1,27% da tarefa. Agrupar contabilização e commit, preservando recuperação e uso, permanece um alvo identificável de redução de I/O; não foi removida durabilidade para esconder essas pausas.

## Inferência local, medida separadamente

Três repetições alternadas, offline, com `Xenova/multilingual-e5-small` q8 já presente na máquina. Mesmo conjunto de 64 documentos. O modelo foi carregado em processos descartáveis; o carregamento ficou separado da inferência aquecida. A máquina tem 32 processadores lógicos.

| Mediana na geração dos 64 vetores | Referência | Candidata |
| --- | ---: | ---: |
| Tempo decorrido | 286,5 ms | 461,2 ms |
| CPU acumulada do processo | 3.703 ms | 1.094 ms |
| CPU média, relativa aos 32 processadores | 41,4% | 7,4% |
| Maior atraso observado no event loop do processo | 128,1 ms | 72,5 ms |

A inferência usa menos CPU e demora mais: é uma escolha de orçamento para trabalho de fundo. Não é uma prova de melhora de frames ou latência da interface Electron. O período ocioso de cinco segundos ficou próximo de 0,1% de CPU em ambos; esta medição não demonstrou ganho de CPU em repouso.

A similaridade cosseno mínima entre vetores foi 0,9967: os resultados numéricos não são idênticos com lotes diferentes e quantização. Em uma regressão sintética separada com 12 temas e 12 consultas, ambas as versões retornaram o documento esperado em primeiro lugar nas 12 consultas. Isso não substitui uma avaliação ampla de qualidade de recuperação.

As opções de threads usadas são suportadas pelo runtime Node; ver [configuração de threads do ONNX Runtime](https://onnxruntime.ai/docs/performance/tune-performance/threading.html) e [SessionOptions](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html). Não foi aplicado o parâmetro de spinning específico de WebAssembly ao runtime nativo.

## Validação e entrega

Já passaram: compilação TypeScript e dashboard; 313 testes na bateria de persistência/catálogo; 765 na bateria de provedores/recuperação/semântica; 133 na bateria final de comandos, incluindo 27 de execução persistente e seis de aspas/argv/PowerShell; 154 de preview/QA/compactação; e 24 testes de interface Chromium. As baterias compartilham alguns casos: esses números não devem ser somados como testes distintos.

Na primeira execução concorrente dos validadores ocorreram timeouts e falhas de teardown; as baterias afetadas passaram depois sem essa carga. A expectativa antiga que exigia `expand_toolset` no erro de uso de `write_stdin` foi atualizada para o novo contrato `find_tools`/`code_exec`.

As três referências, o piloto e as três intermediárias passaram nos 45 casos externos do Ky, build, tipos, lint dos quatro fontes alterados e suíte Node. O Codex passou nos mesmos 45 casos, build, tipos e 1.530 testes Node; a avaliação externa encontrou dois erros de lint em `source/utils/merge.ts`. O avaliador não corrigiu os participantes.

A limpeza dos perfis descartáveis da terceira referência e das duas últimas repetições finais teve um `SQLITE_IOERR_TRUNCATE` depois do término e da coleta das métricas. A repetição da limpeza, após verificar que o processo proprietário já havia terminado, concluiu com zero credenciais e nenhum job semântico. Os erros e as recuperações estão preservados nos logs; não fazem parte do tempo medido nem foram atribuídos a uma causa de sistema operacional sem evidência.

A bateria de compactação e recuperação cobre contratos de contexto longo; não foi executada uma conversa real de muitas horas nem um comparativo visual completo de Company. Os testes de interface são regressões controladas, não certificação de ausência de travamentos em qualquer projeto.

Evidências locais: `D:\MCP\.tmp\harness-performance-20261111`. Os manifestos, resultados e provas de limpeza permanecem nesse diretório. Os dez perfis descartáveis foram encerrados, com zero credenciais temporárias; as repetições de limpeza estão registradas. Nenhum benchmark foi repetido ou teve seu tempo alterado por causa dessa limpeza.

## Instalador verificado

- Arquivo: `D:\MCP\dist\electron-harness-performance-3.16.23-20261111\CodeStudio Setup 3.16.23.exe`.
- Tamanho: 341.103.114 bytes.
- SHA-256: `64af1a34a0e9c8fefe0e4f107eb801b087b5ca88a8333ea6acb615cd460a69a6`.
- Assinatura Authenticode: `NotSigned`.
- 4.205 arquivos empacotados comparados com o runtime final: nenhuma divergência; nenhum perfil de benchmark ou diretório temporário incluído.
- Sete checks aprovados: fechamento de módulos (2.498 módulos/43 pacotes), montagem do renderer e imagens `mcp://`, deep link, indexador em worker, scripts QuickJS, conversão HTML e imagem/vídeo com Sharp/FFmpeg.
- Perfil instalado, projetos e provedores do usuário preservados. O instalador foi entregue como arquivo local, sem instalar por cima nem publicar uma atualização remota.

## Limitações que permanecem

Não há demonstração de redução global de latência nesta amostra. A mediana foi 3,2% maior que a referência; a dispersão foi grande e a coorte final ocorreu depois das referências. A entrada sem cache caiu 21,7%, mas a entrada total aumentou 41,2% e as rodadas aumentaram 29,4%. Não se deve apresentar esta rodada como uma redução geral de custo.

A maior prioridade de eficiência permanece medir separadamente as mudanças de prompt e de exposição das ferramentas, com foco no agrupamento do trabalho e nas validações repetidas. O modelo, o esforço e a tarefa do Codex foram conferidos; sua prioridade interna de serviço não aparece no registro público. Não foi demonstrada uma causa única para a diferença entre os harnesses.

O comparativo com LLM cobriu Ky/TypeScript no `gpt-6.1-sol`. Compatibilidade de outros provedores, React, preview e compactação foi coberta por regressões locais. Não houve uma comparação real de longa duração em React/Company, nem prova de ausência de travamentos em qualquer projeto. O ensaio ONNX mede CPU da inferência, não fluidez global do Electron.
