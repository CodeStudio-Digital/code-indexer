# Reconstrução do catálogo e comparação com outros harnesses

Data: 11/11/2026. Versão candidata: CodeStudio 3.16.24.

## Diagnóstico confirmado

A redução de entrada sem cache da versão 3.16.23 não demonstrou redução do custo ou do tempo total. Nas três execuções anteriores do mesmo exercício Ky, a mediana passou de 34 para 44 chamadas, de 1.921.926 para 2.714.664 tokens de entrada e de 8min51,8s para 9min08,9s. A entrada sem cache caiu de 100.656 para 78.790 tokens. São métricas diferentes: preservar cache não resolve rodadas excessivas.

O catálogo sofreu uma regressão verificável. O log da 3.16.22 registrava 16 ferramentas protegidas e duas descobertas fixadas em 28 vagas. Na 3.16.23, eram **27 protegidas em 28 vagas**. `mcp__grep_code`, leituras indexadas e listagem de diretórios ficaram fora. Novas proteções para processos, recuperação e controles competiam com a navegação básica.

Outro problema: a descrição original de `code_exec` tinha 5.556 caracteres, mas o catálogo enviava apenas 57: a primeira frase. Desapareciam o exemplo de `Promise.all`, a obrigação de aguardar promessas, o contrato de retorno, o reaproveitamento de dados e as regras de recuperação. O parâmetro `code` não compensava essas perdas. Nas três execuções da 3.16.23, oito de onze scripts chamavam explicitamente uma única ferramenta; 118 de 132 rodadas emitiam uma única chamada de topo. Uma chamada `code_exec` pode conter várias chamadas internas; essas contagens não são intercambiáveis.

Isso confirma defeitos de seleção e de orientação, mas não prova que eles explicam todas as rodadas adicionais. Rejeições de patches, estratégia do modelo, polling e exigências do exercício também contribuíram.

## Comparação por código-fonte

Foram lidos snapshots fixados por commit. Nenhum código dos três projetos foi executado. Esta análise não é um benchmark de OpenCode ou pi, nem uma descrição completa da infraestrutura privada do aplicativo Codex.

| Aspecto | Evidência primária | Implicação para CodeStudio |
|---|---|---|
| Superfície de ferramentas | Codex escolhe o par `exec_command`/`write_stdin` ou o shell simples conforme a configuração; seu code mode tem instruções explícitas de orquestração. [spec_plan](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/core/src/tools/spec_plan.rs), [contrato code mode](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/code-mode-protocol/src/description.rs) | Não publicar alternativas equivalentes sem necessidade; disponibilizar um fluxo completo e ensinar como agrupá-lo. |
| Instruções para agrupar | OpenCode orienta chamadas independentes em paralelo e separa claramente ferramentas comuns de code mode. [prompt](https://github.com/anomalyco/opencode/blob/72616be4dbe772dc645640b5623cb3d6f4453bd3/packages/core/src/session/runner/prompt/system.txt), [code mode](https://github.com/anomalyco/opencode/blob/72616be4dbe772dc645640b5623cb3d6f4453bd3/packages/core/src/codemode/instructions.ts) | Uma frase genérica sobre economia não substitui um contrato executável de agrupamento. |
| Núcleo pequeno | pi monta instruções condicionais sobre um núcleo de leitura, bash, edição e escrita. [system-prompt](https://github.com/earendil-works/pi/blob/b22e525b325ff1934b4110f7fc60426fd6f0a8f3/packages/coding-agent/src/core/system-prompt.ts) | Não preencher vagas com funções frias só porque estão registradas. |
| Despacho durante stream | Codex enfileira a execução ao receber um item completo; OpenCode inicia a ferramenta após um evento de chamada completo. [turn.rs](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/core/src/session/turn.rs), [step.ts](https://github.com/anomalyco/opencode/blob/72616be4dbe772dc645640b5623cb3d6f4453bd3/packages/core/src/session/runner/step.ts) | CodeStudio ainda espera consumir a resposta antes de despachar. É uma oportunidade separada; o ganho não foi medido nesta alteração. |
| Paralelismo de comandos | Codex marca os handlers de execução persistente e stdin como compatíveis com paralelismo. [exec_command](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs), [write_stdin](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs) | CodeStudio mantém comandos como barreiras sequenciais. Alterar isso exige modelar posse de processos e conflitos; marcar todo shell como leitura seria incorreto. |
| Persistência | Codex usa fila limitada e escritor assíncrono de rollout. pi mantém entradas em memória, mas também usa `appendFileSync`. [recorder.rs](https://github.com/openai/codex/blob/e58bf8f5233b51e7cd1679d947e3028c1ed91b06/codex-rs/rollout/src/recorder.rs), [session-manager.ts](https://github.com/earendil-works/pi/blob/b22e525b325ff1934b4110f7fc60426fd6f0a8f3/packages/coding-agent/src/core/session-manager.ts) | Não é correto atribuir toda a diferença ao JSON, nem afirmar que todos os concorrentes persistem sem bloquear. |

O [guia oficial de prompting do Codex](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) também orienta o agrupamento de operações independentes. Foram preservados os adaptadores próprios de outros providers; o desenho novo não depende de uma API exclusiva da OpenAI.

## Implementação

1. **Seleção por fluxo:** `tools/workflow-catalog.ts` define um núcleo com descoberta, busca, leitura, edição, execução persistente, recuperação e memória. Não usa a antiga lista crescente `NEVER_TRIM` para a projeção estável de produção.
2. **Alternativas canônicas:** leitura/listagem têm alternativas quando a primeira está desabilitada. O par `exec_command`/`write_stdin` substitui `run_command` na superfície direta quando disponível. As operações frias continuam no conjunto autorizado e são alcançadas por `find_tools` e `code_exec`.
3. **Fluxos completos:** spawn/resume/collect e abertura/fechamento de tarefas inline permanecem juntos. Os conjuntos próprios de Company, preview, API, navegador, diagramas, banco e QA permanecem protegidos quando aplicáveis.
4. **Modo correto:** Build não publica `submit_plan`, `submit_spec`, `submit_tasks` ou `decision_gate` sem o contexto correspondente. `task_list` é a interface canônica; os handlers históricos continuam registrados. Configurações explícitas e limites verificados do provider são respeitados.
5. **Contratos compactos escritos:** `tools/catalog-contracts.ts` substitui o corte automático na primeira frase. Metadados externos são preservados inteiros, salvo quando o próprio contribuidor fornece `catalogDescription`. Schemas continuam completos; não há poda automática de argumentos.
6. **Menos redundância:** novos spawns apresentam somente `profile`; a normalização ainda aceita os aliases históricos. Descrições de opções de `ask_user` foram compactadas sem remover limites ou permissões de diretório.
7. **Prompt coerente:** agrupamento com `Promise.all`, reaproveitamento de leituras e acompanhamento de processos estão explícitos. Preflight deixa de prometer que suas sugestões de ferramentas foram publicadas. A leitura nativa deixa de obrigar uma chamada anterior de outline apenas para obter a contagem de linhas.
8. **Estabilidade e autorização:** descobertas não trocam a lista pública. Desabilitar uma ferramenta revoga sua presença e autorização. Um filtro de relevância não pode retirar dependências do fluxo nem inserir ferramentas fora da projeção. Mudanças reais de modo e limite invalidam a memoização.
9. **Verificação sem rodadas artificiais:** depois da rodada medida, foram corrigidas duas falhas reproduzidas por testes. Inspeções conhecidas de Git, versão do Node e leitura literal de logs em PowerShell não invalidam a checagem de código. Comandos estruturados em `argv` ou `shell` passam a produzir recibos de validação, aguardando a saída real do processo. Isso não altera permissões, classificação de mutação nem paralelismo. Comandos desconhecidos, redirecionamentos potencialmente mutantes e entrada interativa continuam conservadores.
10. **Contrato real do processo:** a descrição final distingue `status=running` de `status=exited`/`exit=0`. O handler retorna `session_id` também após terminar; portanto, esse identificador isolado não exige novo polling.

A projeção antiga fica restrita a chamadores de compatibilidade; o nó de execução de produção usa `stableCatalog:true`, que entra na nova seleção. O limite de 28 é um orçamento de apresentação, não autorização e não motivo para cortar metade de um papel. Se o conjunto necessário exceder um limite rígido confirmado pelo provider, o sistema retorna um erro explícito.

## Medição determinística do catálogo

O probe usa definições reais das ferramentas nativas e o snapshot preparado do MCP interno, sem executar handlers, iniciar MCP externo ou chamar modelo. O catálogo anterior reconstruído tem fingerprint `d4876d25d0ca922bc86c8f134329b9152b3c005c`, exatamente o registrado nas três execuções finais da 3.16.23.

| Métrica | 3.16.23 | 3.16.24 |
|---|---:|---:|
| Ferramentas diretas | 28 | 27 |
| JSON das definições, caracteres | 26.213 | 25.778 |
| Descrição de `code_exec`, caracteres | 57 | 1.093 |
| Busca exata de código direta | Ausente | Presente |
| Outline, corpo de símbolo e preparação de edição diretos | Ausentes | Presentes |
| Recolher agentes e continuar tarefas inline diretamente | Ausentes | Presentes |

Nesse registro controlado, o catálogo fica **1,66% menor** e recupera os contratos perdidos. A primeira tentativa intermediária tinha 34.773 caracteres; foi revisada antes de empacotar. O perfil real do benchmark também registra `invoke_skill`: são **28 ferramentas e 26.913 caracteres**, 2,67% acima da 3.16.23. Portanto, o ganho pretendido está em evitar rodadas de descoberta/releitura, não numa grande redução do prefixo. Caracteres não são tokens faturados; esses números não demonstram, sozinhos, redução de latência nem do número de rodadas.

Artefatos reproduzíveis em `D:/MCP/.tmp/harness-source-audit-20261111/`: `sources.json`, `rounds-analysis.json`, `rounds-summary.json`, `probe-tool-contracts.mjs`, `tool-contract-probe.json`, `measure-catalog.ts`, `catalog-before-3.16.23.json` e `catalog-measurement.json`.

## Validação e limites

Os **408 testes em 23 arquivos** da seleção final passaram: seleção, revogação, estabilidade, configuração de sete famílias de providers, recuperação HTTP/SSE de schemas, Company e papéis especializados, code_exec, prompts, compatibilidade de spawn e contabilização de validações. A matriz de providers usa fixtures locais, não sete chamadas a modelos reais. O exemplo de agrupamento publicado é executado num teste, não apenas comparado como texto. TypeScript e build React passaram tanto na candidata medida como na compilação final entregue.

O sandbox bloqueou conexões de loopback com `EACCES` e produziu resolução inconsistente de tipos das dependências. O teste de transporte e o TypeScript foram conferidos fora dessa virtualização, preservando o perfil do usuário. Não foram corrigidos centenas de falsos erros de tipos por meio de alterações no produto.

## Rodada real: tempo, consumo e qualidade

Foi repetido o mesmo exercício Ky, com cinco tarefas, `gpt-6.1-sol`, esforço `high`, Node 22.20.0 e cópia isolada do commit `8baf0cadd8ca66659d6e86b2ebf4583e2f15bcb4`. O prompt mantém SHA-256 `561f9eacf7b571f25ccbfc8173c5cd7dbec999772f75afdf990af0035489cecb`. O modelo não teve acesso à outra solução. Memória, embeddings, reranker e subagentes permaneceram desligados conforme o protocolo anterior.

| Métrica | 3.16.23: mediana de três execuções anteriores | 3.16.24: uma execução nova | Variação observada |
|---|---:|---:|---:|
| Tempo total | 9min08,9s | 7min26,4s | −18,7% |
| Chamadas ao modelo | 44 | 35 | −20,5% |
| Tokens de entrada total | 2.714.664 | 1.927.139 | −29,0% |
| Tokens de entrada sem cache | 78.790 | 72.803 | −7,6% |
| Tokens de saída | 13.740 | 12.054 | −12,3% |
| Tempo observado no modelo | 7min19,0s | 6min16,4s | −14,2% |

**Limite da comparação:** a nova versão tem uma amostra, sem ordem intercalada. Latência do provider, cache remoto, carga da máquina e escolhas do modelo não foram controlados perfeitamente. O resultado é favorável neste exercício; não demonstra redução universal de tempo, custo monetário ou paridade com o Codex.

O comportamento desejado apareceu: os sete scripts `code_exec` agrupavam 5, 8, 6, 3, 6, 4 e 5 chamadas explícitas, todos com `Promise.all`. Na versão anterior, oito de onze scripts das três execuções faziam uma única chamada explícita. A nova execução preservou **um único fingerprint de ferramentas nas 35 chamadas**, com 28 ferramentas diretas e 26.913 caracteres. Foram 35 transportes WebSocket, 30 continuações incrementais e 31 chamadas com replay de raciocínio.

O tempo desta rodada se divide em aproximadamente **376,4s no modelo, 57,2s nas ferramentas, 7,8s de admissão, 1,0s de preparação e 3,9s não atribuídos**. A persistência somou 26,4s de trabalho em segundo plano, mas somente **0,054ms de espera contabilizada na barreira do provider**. Essa soma de trabalho assíncrono não deve ser adicionada ao tempo total nem interpretada como travamento do agente.

A validação independente confirmou **45/45 critérios**, **1.555 testes Node**, build, typecheck solicitado, lint do código alterado e `git diff --check`. O agente acrescentou 28 casos de regressão. O lint do código registrou seis avisos. O lint dos testes não passou: a configuração TypeScript original não inclui `test/*.ts`; ela não foi afrouxada. Testes de navegador estavam excluídos do protocolo. Esses limites impedem afirmar aprovação de todos os checks possíveis do repositório.

A medição inclui duas chamadas finais extras. Após testes aprovados, inspeções via `exec_command` foram classificadas como possíveis escritas, e o runner exigiu outra verificação. Dois testes reproduziram as falhas antes da correção: sequência final de inspeção/relatório e reconhecimento de checagens em `argv`. A versão entregue inclui as correções dos itens 9–10; **não foi descontado tempo hipotético nem repetida a chamada real ao modelo depois desses ajustes**. Os dados de desempenho continuam sendo os da candidata original congelada.

O servidor de teste próprio foi encerrado, não havia filhos pendentes, as credenciais temporárias foram apagadas e a instância habitual ficou intacta. Evidências: `D:/MCP/.tmp/harness-catalog-20261111/` e o resumo reproduzível `D:/MCP/.tmp/harness-source-audit-20261111/catalog-result-summary.json`.

## Instalador entregue

- Arquivo: [CodeStudio Setup 3.16.24.exe](<D:/MCP/dist/electron-workflow-catalog-3.16.24-final-20261111/CodeStudio Setup 3.16.24.exe>).
- Tamanho: 341.112.122 bytes.
- SHA-256: `9ab00082507ec54703ad16bb773467ebb2bbdb510aa46b17938e2874d613579c`; arquivo `.exe.sha256` ao lado do instalador.
- Assinatura Authenticode: `NotSigned`.
- Comparação de 4.208 arquivos empacotados com o runtime final congelado: nenhuma divergência. Sem diretórios de benchmark, perfis, `.git` ou `.mcp-indexer` no ASAR.
- Sete verificações do pacote aprovadas: fechamento de módulos (2.500 módulos, 43 pacotes), montagem do renderer/recursos, deep link, indexer, execução QuickJS, conversão HTML e processamento de imagem/vídeo.
- Não foi instalado sobre o perfil habitual. O artefato intermediário da mesma versão permanece apenas como evidência; o link acima aponta para o pacote final com as correções posteriores à medição.

Evidências de release: `D:/MCP/.tmp/harness-catalog-release-20261111/installer-verification.json` e `artifact-final.json`. Evidências dos testes: `D:/MCP/.tmp/harness-source-audit-20261111/release-tests.json`.

## Pendências de desempenho fora deste catálogo

- Nos logs da 3.16.23, quatro ou cinco rodadas dedicadas a polling consumiram entre 38,3s e 71,0s de inferência por execução. Na nova rodada foram quatro, com 19,0s. Melhorar o agendamento de resultados ainda é uma frente distinta.
- Em uma rodada da candidate-7, build/typecheck, AVA e lint foram despachados em uma janela de 20,3s; o terceiro só começou cerca de 14,7s depois do primeiro. Processos podem continuar após o yield; isso não significa que suas vidas inteiras foram serializadas.
- A persistência de métricas disputou a fila da sessão por 5,7s e 6,8s nas duas últimas execuções da 3.16.23; a nova rodada não apresentou espera material nessa barreira. A pausa histórica de 173s pertence a outra rodada. Isso não permite inferir ausência de contenção em sessões longas ou Company.
- Despachar chamadas completas durante o stream, distinguir início/poll de processo da seção crítica de mutações e agrupar métricas derivadas são próximos experimentos. Nenhum deles deve enfraquecer o registro durável de intenção/resultado ou repetir operações com resultado incerto.
- O exercício exige progresso por tarefa e relatório final. Não se deve eliminar a revisão ou os testes para aparentar uma melhora de tempo. O Codex de referência tinha dois erros de lint, apesar dos testes de aceitação aprovados.
