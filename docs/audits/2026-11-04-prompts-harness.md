# Revisão dos prompts do harness — 2026-11-04

Foram corrigidos problemas concretos de intenção, aprovação, continuidade, verificação e composição nos prompts mantidos pelo projeto. Os gates do runtime não foram flexibilizados. Esta revisão não certifica o comportamento de todas as combinações de modelo, provedor e ferramentas reais.

## Inventário

| Superfície | Fontes | Resultado |
| --- | --- | --- |
| Compositor principal e famílias de provedor | `packages/code-agent/src/core/system-prompt.ts`, `core/runner/assembly/system-prompt.ts` | Dez famílias na matriz: Anthropic, Claude Code, Codex, OpenAI, OpenRouter, ZAI, Gemini, DeepSeek, Kimi e genérica. OpenRouter deixou de presumir família GPT. Marcador de cache preservado; versão `20261104.intent-safe-recovery`. |
| Base e modos | `packages/code-agent/src/prompts/{base,admin,api,app_db,build,builder,diagram,explore,plan,research,spec}.txt` | Os dez agentes entram na matriz de composição, com Plan ligado/desligado. Builder, Diagram e Spec preservados; contratos de outros modos corrigidos. |
| Compactação e recuperação do Master | `prompts/{summarize,summarize-v2,summarize-v3,master-recovery}.txt` | Preservação de pendências, efeitos desconhecidos e limites da evidência; sem inventar autorização ou sucesso. Carga de v3 incluída nos testes. |
| Permissões | `core/permissions-prompt.ts` | Texto alinhado a `ask`, `auto`, `unrestricted`, grants salvos e exceções de banco/recovery; implementação do gate preservada. |
| Delegação | `sessions/ultra-policy.ts`, `buildSubagentLoopFraming`, `tools/implement-subagent.ts` | Ultra compacto, limite efetivo zero/off respeitado, replay seguro e verificação compatível com checkout isolado. A última alteração em implement-subagent foi exclusivamente textual. |
| Skills e lembretes | `skills/prompt-injector.ts`, `core/runner/assembly/dynamic-injection.ts` | Leitura pertinente sem impedir comentário inicial; respeito à autoridade do usuário e aos gates. Revisão proporcional ao risco, reutilizando evidência ainda válida. |
| Código gerado para orquestração | `tools/code-exec.ts`, somente `CODE_EXEC_DESC` | Descrição do executor isolado, espera de todas as promises, controles no nível superior, Plan apenas quando ativo e proibição de replay cego do lote. Nenhuma lógica de execução alterada nesta revisão. |
| DocsAgent | `packages/docs-agent/src/prompts/{system-prompt,synthesis-prompt}.ts` | Busca vazia deixa de provar ausência no corpus; passagens são evidência, não instruções. Síntese sem mínimo artificial de 400 palavras. |
| Pré-análise e autocomplete | `packages/services/src/services/task-preflight/preflight-prompt.ts`, `packages/api-handlers/src/editor/completion-prompt.ts` | Intenção distinta da gramática da pergunta; contrato JSON e inserção entre prefixo/sufixo preservados diante de instruções em conteúdo. |
| Revisão automática | `packages/services/src/services/snapshot-review-prompt.ts` | Mantido: já distingue contexto não confiável, diffs, referências e itens omitidos. Testes existentes incluídos. |
| Company | `packages/company/src/system-prompts.ts`, `services/master/prompt-builder.ts`, `services/company-master-prompt-files.ts` | Composição, protocolos de entrega e instruções persistidas identificados. Testes existentes incluídos. Overrides do operador, sessões salvas e migrações históricas não foram reescritos. |

## Problemas corrigidos

- A frase “Questions are read-only” podia transformar “can you fix…?” em simples resposta. Agora pedidos de ação são executados dentro do modo ativo; Explore e Plan mantêm seus limites.
- Retry genérico deixou de autorizar repetição de operações com efeito desconhecido. Pai, filhos, recuperação e descrição de `code_exec` exigem reconciliação antes de nova mutação e preservam recusas.
- Admin afirmava que toda operação destrutiva obrigatoriamente chamava `ask_user`; o texto agora descreve o gate real e evita confirmação duplicada. `auto` não é descrito como livre para shell, e `unrestricted` não elimina as exceções de banco/recovery.
- O Master Recovery sugeria promover Review para Done pela mera ausência de problema reportado e consumir quotas de turnos. Agora Done exige verificação, atividade é reconciliada e investigação termina por evidência suficiente.
- API tratava 400/422 e 404/405 como erro do Swagger e promovia 2xx a sucesso. Agora distingue defeito do servidor, requisição e contrato; expectativas não são alteradas apenas para deixar o teste verde.
- Learning deixava código obrigatório incompleto em `TODO(human)`, inclusive em conflito com comentários desabilitados. Agora termina o trabalho e oferece exercício opcional no texto final.
- Skills impediam qualquer ferramenta ou prosa antes de carregar instruções, conflitando com descoberta e progresso público. Agora bloqueiam somente o trabalho da área antes da leitura pertinente.
- Composições com ferramentas nativas limitadas deixaram de anunciar semantic search ausente. Textos de modos incluem fallback para busca/leitura disponíveis.

## Orçamento e evidências

Os limites existentes não foram aumentados. A cobertura agora inclui todas as famílias e agentes; foram cadastrados limites para modos antes ausentes da matriz.

| Trecho | Antes | Depois |
| --- | ---: | ---: |
| Template Ultra, caracteres | 2.174 | 1.614 |
| Master Recovery, caracteres | 8.358 | 3.227 |
| Admin, caracteres | 2.577 | 1.425 |
| Base, caracteres | 1.153 | 1.125 |

A seção Ultra passa no teto original de 1.800 caracteres. Os limites das composições canônicas de 5.400/7.000 também passam. Caracteres não equivalem a tokens exatos de um provedor.

- Bateria focal: **175/175 testes**, 12 arquivos, sem skips (`.tmp/harness-retest-2026-11-04/prompts/prompt-verified.json`).
- Após mover os testes entre pacotes para a composição raiz: **14/14 testes afetados** (`prompt-imports.json`). Os testes especializados estão em `src/__tests__/prompt-input-boundaries.test.ts`; os contratos próprios em `packages/code-agent/src/prompts/__tests__/prompt-contract-regressions.test.ts`.
- O build identificou uma fixture parcial de `ResolvedSkill` que o Vitest transpila sem checagem de tipos. Ela foi substituída pelo objeto completo e tipado, sem cast; os **11/11 testes do arquivo** passaram novamente (`prompt-fixture.json`).
- Uma checagem adicional no sandbox reportou 542 diagnósticos de testes. A execução canônica **no host** (`node .tmp/harness-retest-2026-11-04/run-check.mjs typecheck --host`) passou com exit 0 em 22,8 s, incluindo os novos testes de dependências e antes do último ajuste textual do legado v2; os diagnósticos não se reproduziram nesse ambiente. Registro: `typecheck-host.result.json`.
- Após o ajuste do legado v2: **12/12 testes de contrato** (`prompt-legacy-verified.json`). A primeira regressão falhou somente ao extrair o exemplo JSON de um TXT com CRLF; a extração passou a normalizar as quebras de linha, preservando as mesmas asserções de schema e orçamento.
- Primeira tentativa em sandbox: 12 arquivos não puderam ser coletados por `EPERM` no rename do cache do Vitest. A execução no host com Electron, um worker, dotenv vazio e perfil temporário isolado resolveu a limitação (`prompt-focused.log`). Isso não foi contado como falha de produto nem como teste passado.
- Snapshot e comparação desta frente: `.tmp/harness-retest-2026-11-04/before-prompts/` e `prompts/prompt-changes.json` (28 arquivos existentes alterados; hashes antes/depois). Dois arquivos novos de testes completam a mudança. O snapshot de implement-subagent foi reconstruído com a inversão exata das três linhas textuais após a cópia PowerShell terminar assincronamente.

## Limites e próximos testes

Os testes verificam composição, contratos textuais, orçamento, cache e fronteiras entre pacotes; não provam obediência perfeita do modelo. Permanecem úteis avaliações reais, com fixtures sintéticas, para pedidos em forma de pergunta, recusa de ferramenta, timeout após mutação, compactação com aprovação pendente e diferenças de modelo. Nenhum teste desta frente acessou um banco remoto, enviou mensagens externas ou substituiu prompts personalizados do usuário. Build e suíte geral são registrados na auditoria principal do harness.

O legado v2 também foi corrigido: a lista verbatim passou a ter no máximo oito trechos, incluindo indicação de omissões, e deve diminuir quando necessário para respeitar os 800 tokens. Objetivo, restrições, aprovações e efeitos desconhecidos permanecem nos demais campos. O schema de nove campos foi preservado e ganhou regressão; o caminho v3 continua com seu contrato próprio.
