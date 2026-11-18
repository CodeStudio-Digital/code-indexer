# CodeStudio — rodadas evitáveis do harness (após a 3.16.24)

**Data:** 11/11/2026. **Base:** trace da candidata 3.16.24 (`candidate-1`, 35 chamadas, 7min26,4s) descrito no [relatório consolidado](2026-11-11-relatorio-consolidado-otimizacoes-e-benchmarks.md).

Este documento classifica as 35 rodadas daquela execução, descreve as correções feitas sobre o que o trace mostrou e separa o que foi **provado offline** do que **ainda depende de nova rodada com modelo**. Nenhuma chamada ao modelo nem benchmark novo foi executado nesta etapa.

## 1. Onde as rodadas foram parar

Cada rodada reenvia o transcript inteiro (de 8,7k tokens no início a 78k no fim). Por isso uma rodada a menos economiza latência e também a entrada acumulada.

| Categoria | Rodadas | Tempo no modelo | Entrada dessas rodadas | Causa no harness |
|---|---|---:|---:|---|
| Recuperação de `apply_patch` | R11, R12, R13 | 34,2s | 147.571 | Casamento por substring exata; um tab a mais rejeitou o patch de 4 arquivos |
| Relendo conteúdo truncado | R4, R5, R7 (em grande parte) | 21,8s | 92.770 | Retorno do `code_exec` limitado a 24k para um lote de até 8 resultados; corte cabeça/cauda descartou arquivos inteiros do meio |
| Poll só para saber o estado | R8, R20, R28, R30 | 19,0s | 252.750 | Poll vazio voltava `running` após 5s; saída ocorrida durante outro trabalho só era vista por poll |
| Lendo log de saída redirecionada | R9, R21, R29 | 14,9s | 181.165 | Modelo redirecionava a saída para arquivo; o resultado vinha `(no new output)` |
| Revalidação no fechamento | R34, R35 | 9,6s | 155.253 | Já corrigido depois do benchmark (relatório consolidado, §4.5) |
| **Total** | **15 de 35** | **99,4s de 376,4s** | **829.509 de 1.927.139** | |

A coluna de entrada é a soma da entrada daquelas rodadas no trace. Eliminar rodadas também muda o tamanho do prefixo das seguintes, então ela é um teto, não uma economia aditiva.

As demais 20 rodadas foram leitura inicial, edições (R16 gastou 67,4s gerando 3.253 tokens de testes; R32 gerou o `BENCHMARK_RESULT.md`), comandos de validação e a resposta final.

## 2. Correções

### 2.1 `apply_patch`: casamento por linha, como o `seek_sequence` do Codex

[apply-patch-match.ts](../../packages/code-agent/src/tools/apply-patch-match.ts) e [apply-patch.ts](../../packages/code-agent/src/tools/apply-patch.ts).

- Os hunks são localizados linha a linha em quatro níveis: exato → ignorando espaço final → ignorando indentação → normalizando pontuação Unicode. Os modelos GPT aprenderam o formato com essa tolerância no Codex.
- Quando o casamento tolera indentação, as linhas de contexto vêm do arquivo (nunca do patch) e as linhas adicionadas são reindentadas pelo deslocamento observado. Evidência inconsistente deixa as linhas como o modelo escreveu.
- Busca a partir do ponto onde o hunk anterior caiu e depois volta ao topo. O texto após `@@` (ex.: `@@ function second() {`) passa a orientar onde começar.
- Não casa mais um fragmento no meio de uma linha (antes `x = 1;` podia editar `max = 1;`). Uma adição sem contexto agora vai para o fim do arquivo, como no Codex. Antes, ela era colada no início sem quebra de linha.
- O erro de casamento mostra a região mais parecida com números de linha e a primeira diferença, e afirma que nenhum arquivo foi alterado. Isso elimina o `git diff` e a releitura que o modelo fez em R11 e R12.
- O sucesso informa quando um hunk só casou com tolerância.

### 2.2 Comandos: espera pela conclusão e aviso de saída

[exec-command.ts](../../packages/code-agent/src/tools/exec-command.ts), [background-notices.ts](../../packages/code-agent/src/core/background-notices.ts), [executing-dispatch.ts](../../packages/code-agent/src/core/runner/nodes/executing-dispatch.ts).

- Um poll vazio (`write_stdin` sem `chars`) de um comando que nunca recebeu entrada espera até o processo terminar: piso de 30s, máximo de 60s, retorno imediato na saída. Zero explícito continua imediato. Sessões interativas (pty ou com stdin escrito) mantêm as esperas curtas anteriores.
- A espera padrão do `exec_command` subiu de 10s para 30s, com retorno imediato na saída. O mínimo de 10s no Windows para esperas positivas não mudou.
- Uma sessão que o modelo deixou rodando e que terminou enquanto ele fazia outra coisa é relatada **uma vez**, anexada ao último resultado do próximo lote de ferramentas. O corpo é o mesmo que um poll devolveria. Um poll posterior responde "já relatado" em vez de erro.
- O aviso vai só para o agente (runner) que recebeu o `running`. Subagentes compartilham o `sessionId` do pai, então sem isso o aviso podia ir parar no agente errado.
- Os contratos compactos de `exec_command` e `write_stdin` deixaram de incentivar `yield_time_ms` curto. Agora dizem que a saída fica retida (`output_ref`) e não precisa ser redirecionada para arquivo.

### 2.3 `code_exec`: retorno legível, truncamento justo, orçamento do lote

[batch-return-format.ts](../../packages/code-agent/src/core/batch-return-format.ts), [code-exec.ts](../../packages/code-agent/src/tools/code-exec.ts), [pure-helpers.ts](../../packages/code-agent/src/core/runner/pure-helpers.ts), [runner.ts](../../packages/code-agent/src/core/runner.ts).

- Listas e objetos com texto de várias linhas saem como seções cruas (`── [0] ──`), sem o escape JSON de `\n`, `\t` e `"`. Retornos pequenos e estruturados continuam JSON.
- Quando o retorno não cabe, cada valor recebe uma fatia justa. Valores pequenos ficam inteiros e os grandes mantêm início e fim, com marcador de linhas omitidas. Nenhum arquivo do lote desaparece.
- Um bloco com N chamadas internas pode usar min(N, 4) orçamentos de um resultado: o mesmo total que as chamadas teriam separadas, ainda limitado pelo teto relativo ao contexto. O orçamento é derivado do cabeçalho do próprio conteúdo, por isso o corte na retomada da sessão é idêntico ao corte ao vivo e o prefixo em cache não muda.

## 3. Evidência offline (replay do trace)

Script: [.tmp/harness-replay-20261111/replay.ts](../../.tmp/harness-replay-20261111/replay.ts). Resultado: `replay-result.json` na mesma pasta. O script só lê o trace gravado e os blobs brutos das ferramentas; não chama modelo nem servidor.

**`apply_patch`.** O patch de R10, rejeitado na execução, aplicado aos arquivos do seed (`git show HEAD:`) agora é aceito. Dois hunks de `timeout.ts` e um de `body.ts` casaram ignorando indentação. Os 4 arquivos resultantes são **idênticos byte a byte** aos do patch corrigido que o modelo enviou em R13. Ou seja, R11–R13 (34,2s de modelo) produziram exatamente o que a primeira tentativa já produz.

**`code_exec`** (orçamento base de 24k, nível *economic*):

| Lote | Chamadas | JSON bruto → seções | Valores completos (antes → depois) | Valores com início visível |
|---|---:|---:|---:|---:|
| R3 | 8 | 121.784 → 112.467 | 1 → 4 de 8 | 2 → 8 de 8 |
| R4 | 6 | 25.005 → 23.197 | 5 → 6 de 6 | 4 → 6 de 6 |
| R5 | 3 | 33.614 → 31.624 | 1 → 3 de 3 | 2 → 3 de 3 |
| R7 | 6 | 26.743 → 24.661 | 4 → 6 de 6 | 5 → 6 de 6 |
| R14 | 4 | 24.016 → 22.439 | 3 → 4 de 4 | 3 → 4 de 4 |

O escape JSON inflava cada lote em 5–8%. R4, R5, R7 e R14 passam a caber inteiros. Em R3, todos os arquivos aparecem com início e fim. Isso mostra o que o modelo teria visto; não prova que ele deixaria de pedir as releituras.

## 4. Validação

- Testes novos: [apply-patch-match.test.ts](../../packages/code-agent/src/tools/__tests__/apply-patch-match.test.ts) (inclui o caso exato de R10), [exec-command-completion.test.ts](../../packages/code-agent/src/tools/__tests__/exec-command-completion.test.ts) e [batch-return-format.test.ts](../../packages/code-agent/src/core/__tests__/batch-return-format.test.ts).
- Legado `src/__tests__/apply-patch.test.ts`: 36/36, sem alteração nos casos.
- Nós do runner + `code-exec*`: 384/385. A falha ("still trips the budget on a tool-free synchronous spin") passou isolada; ela mede o tempo do avaliador com 37 suítes em paralelo.
- Varredura ampla (`tools/__tests__`, `core/__tests__`, `core/runner/__tests__`, assembly/catálogo, apply-patch legado): 1.812/1.835. As 23 falhas foram classificadas uma a uma:
  - 16 em `create-skill`: o binário `better_sqlite3.node` está compilado para a ABI do Electron (ambiente, não código).
  - 3 em `implement-subagent-context`: persistem com o novo gancho de avisos desligado; são compatíveis com o catálogo estável do WIP, que não promove mais `expand_toolset`.
  - 2 em `prompt-budget`, vindas do WIP anterior: `# Tool contract` tinha 560 caracteres para teto de 200; o prefixo estático, 5.509 para 5.400 (plano: 7.176 para 7.000). **Corrigido depois** (§4.1).
  - 2 sensíveis a tempo (`code-exec` "does not deadlock…", com `timeoutMs = 200`, e `code-exec-outcome-unknown`): passam isolados.
- `tsc --noEmit` do monorepo: zero erros.

### 4.1 Correção do `prompt-budget`

O crescimento vinha de duplicação, não de regra nova:

- A frase sobre `find_tools` em `# Tool contract` repetia `# Tool discovery`, que aparece sob a mesma condição (`base.txt` renderiza as duas quando `find_tools` existe).
- Parte do parágrafo de agrupamento repetia os contratos de `code_exec`, `read_file` e `find_tools`.

A seção foi condensada mantendo as regras próprias dela: agrupar leituras independentes em um `Promise.all`, manter dependências e mutações em sequência, reaproveitar o conteúdo lido, e só declarar sucesso após o código de saída. A regra sobre `exec_command` só aparece quando a ferramenta existe.

| Medida | Antes | Depois | Teto |
|---|---:|---:|---:|
| `# Tool contract` (maior da matriz) | 560 | 353 | 400 (registrado com justificativa) |
| Prefixo estático padrão | 5.509 | 5.302 | 5.400 (inalterado) |
| Prefixo estático em modo plano | 7.176 | 6.969 | 7.000 (inalterado) |

`SYSTEM_PROMPT_VERSION` passou para `20261111.tool-contract-dedup`, já que o prefixo mudou em relação ao medido na 3.16.24.

O teste legado `system-prompt.test.ts` › "OpenAI-compatible preamble for OpenRouter" também falhava no último commit. O lado desatualizado era o teste: o commit `bafca3dc` (08/11) mapeou `openrouter` para o preâmbulo neutro de propósito, porque a rota pode servir qualquer família de modelo. O teste, alterado pela última vez em 24/10, ainda esperava o preâmbulo da família GPT. Ele foi atualizado para exigir o preâmbulo neutro e proibir a identidade "OpenAI GPT family". Com isso, os testes que montam o system prompt passam integralmente.

## 5. O que não está provado e riscos

- **Não houve nova rodada com modelo.** As economias das categorias de poll, log redirecionado e releitura dependem do comportamento do modelo e precisam do protocolo de repetição do relatório consolidado (§8.9).
- **Espera mais longa:** um processo travado faz cada poll vazio durar até 30s, contra 5–10s antes. Cancelamento e zero explícito continuam imediatos. Servidores continuam desaconselhados no `exec_command`.
- **Tolerância do `apply_patch`:** um bloco que só difere em indentação de outro trecho pode casar no lugar errado. Mitigações: níveis estritos primeiro, busca a partir do cursor, preferência pelo `@@`, aviso no sucesso. É a mesma semântica do Codex.
- **Mais contexto por lote:** um `code_exec` pode inserir até 96k caracteres no nível *economic*. Isso substitui releituras, mas fica no prefixo das rodadas seguintes.
- **Aviso de saída fora da UI ao vivo:** ele é anexado depois que o evento `tool_call_result` já foi emitido. Fica no transcript persistido, mas não aparece no card ao vivo da ferramenta.

Ajustes para reverter ou calibrar: `DEFAULT_EXEC_YIELD_MS` e `COMPLETION_POLL_FLOOR_MS` em `exec-command.ts`; `MAX_BATCH_BUDGET_UNITS` em `batch-return-format.ts` (1 desliga o orçamento por lote).

## 6. Próxima prova

Rodar a candidata com estas mudanças no mesmo protocolo (Ky, `gpt-6.1-sol`/high, isolamento semântico conferido), de preferência 5 amostras alternadas com a 3.16.24, e comparar **rodadas por categoria** da tabela do §1, além de tempo, entrada e os 45 critérios. Critério de sucesso: categorias "recuperação de patch" e "poll" vazias ou menores, sem regressão de qualidade.
