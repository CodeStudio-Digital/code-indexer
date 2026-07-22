# 00 — Escopo, proveniência e método

## 1. Escopo desta pesquisa

Este atlas compara mecanismos observáveis em dois conjuntos de código:

- o snapshot local do ClaudeOpen, composto pelo Claude Code CLI 2.1.215 e por um `app.asar` do Claude Desktop reorganizado por domínio;
- o CodeStudio 3.15.1 no commit observado no início da execução.

A entrega é exclusivamente documental. Não altera código executável, migrations, schemas, APIs, prompts, tools, tiers, sessões ou dashboard.

## 2. Baselines

### 2.1 Claude Code CLI

**Status: VERIFIED**

O corpus declara Claude Code CLI 2.1.215 e informa que o bundle de 19,27 MB foi dividido em 4.764 módulos, reorganizado e desminificado. A conservação é apoiada por contagem, soma de bytes e hash multiconjunto: `claudeopen/claude-code-src/README.md:1-10`.

Os domínios relevantes são explicitamente inventariados como loop, tools, permissions, workflow/ultracode, teams, MCP, memory, prompts, compaction e hooks: `claudeopen/claude-code-src/README.md:12-18`.

### 2.2 Claude Desktop

**Status: VERIFIED com limitação de versão**

O corpus Desktop contém 108 arquivos extraídos de `app.asar`, reorganizados por domínio, com `require()` relativos reescritos e um `_manifest.json` de caminho original para caminho semântico: `claudeopen/asar-src/README.md:1-9`.

O README enumera sessions, permissions, Cowork dispatch, VM, MCP, plugins, telemetry, config, auth, workers, skills, Git, SSH, PTY e IPC: `claudeopen/asar-src/README.md:11-27`.

O corpus não declara a versão do aplicativo Desktop. Portanto:

- não associamos automaticamente esse snapshot ao Desktop 1.8089.1 descrito em `codestudio_mcp-codebase/docs/claude-desktop-electron-notes.md:1-12`;
- claims exclusivas de Desktop são rotuladas como “snapshot Desktop, versão não determinada”;
- qualquer correlação com notas antigas é tratada como comparação entre snapshots, não identidade de build.

### 2.3 CodeStudio

**Status: VERIFIED**

A versão do pacote é 3.15.1: `codestudio_mcp-codebase/package.json:1-18`.

O commit observado antes da escrita foi:

`61e5769cbe2ac2530a32ae547576d5d70f7bc693`.

A árvore já estava modificada por trabalhos concorrentes. Este atlas cria somente arquivos sob `docs/research/claudeopen-convergence/` e não edita os rascunhos não rastreados em `docs/agent-research/claudeopen/`.

## 3. Unidade de análise

Uma claim só entra na síntese quando possui:

1. pergunta respondida;
2. status de evidência;
3. arquivo e linha/faixa;
4. símbolo/contrato quando útil;
5. interpretação limitada ao que a fonte sustenta;
6. impacto para o CodeStudio;
7. decisão de transferência;
8. teste ou benchmark futuro quando houver hipótese de eficácia.

## 4. Taxonomia de evidência

| Marcador | Uso obrigatório | O que não significa |
|---|---|---|
| `VERIFIED` | O código citado contém diretamente o contrato/comportamento descrito | Que o recurso está habilitado para todos os usuários |
| `INFERRED` | Etapas verificadas sustentam um fluxo composto, sem trace runtime único | Que a ordem temporal foi observada em produção |
| `ABSENT_FROM_SNAPSHOT` | A implementação não está no corpus auditado | Que o produto não possui o mecanismo |
| `LEGACY_DOC` | O documento registra uma versão/estado anterior | Que todo o documento está errado |
| `RISK` | A arquitetura permite uma falha plausível e localizável | Que a falha foi reproduzida |
| `BUG` | Existe reprodução ou teste demonstrando comportamento incorreto | Uma mera preferência de produto |
| `UX_GAP` | O runtime modela um estado que a UI não explica ou controla bem | Falha no transporte subjacente |
| `HYPOTHESIS` | Existe uma relação causal proposta a medir | Benefício comprovado |

## 5. Escala de confiança

- **Alta**: contrato explícito, faixa pequena, sem depender de nome minificado para a semântica.
- **Média**: fluxo formado por várias faixas verificadas ou código desminificado com papel contextual claro.
- **Baixa**: depende de componente remoto ausente, feature flag desconhecida ou comportamento do modelo.

Confiança não substitui status. Uma claim pode ser `VERIFIED` com confiança média quando o código é desminificado e a fronteira do módulo é reconstruída.

## 6. Regras para o corpus desminificado

1. Símbolos como `Q_e`, `NVy`, `Gq`, `aue` e `hbo` são coordenadas de auditoria, não APIs públicas.
2. Nomes-alvo do CodeStudio devem expressar o domínio, por exemplo `AgentRunSpec`, `RuntimeEventEnvelope` e `UltraPreset`.
3. Trechos de código devem ser curtos e explicar um contrato; não reproduzir blocos extensos do bundle.
4. Offsets e linhas são válidos para este snapshot. Uma atualização exige revalidar o índice.
5. Código local prova presença, não habilitação por entitlement, organização ou feature flag.
6. Ausência do backend de Cowork impede conclusões sobre scheduling remoto, durability cloud ou critérios server-side.

## 7. Método comparativo

Cada tema é avaliado em seis eixos:

| Eixo | Pergunta |
|---|---|
| Contrato | Quais tipos, entradas, saídas, estados e invariantes existem? |
| Durabilidade | O que sobrevive a turno, processo, aplicativo e runtime destruído? |
| Autorização e isolamento | Quem pode executar, onde, com quais recursos e segredos? |
| Observabilidade | Quais eventos, IDs, traces e superfícies de UI existem? |
| Eficácia | Como contexto, tool choice, resume, fan-out e verifier ajudam o resultado? |
| Custo e latência | Qual impacto em prompt, cache, tokens, concorrência e streaming? |

## 8. Estados de transferência

A matriz usa decisões fechadas:

- **preserve CodeStudio** — o mecanismo interno já é mais adequado;
- **adapt ClaudeOpen** — adotar o princípio, com contrato próprio;
- **merge** — integrar forças complementares;
- **reject** — não adotar, com razão explícita;
- **benchmark first** — só decidir após medição causal;
- **unknown** — evidência insuficiente.

## 9. Regras para classificar uma lacuna

Uma diferença só é “gap” quando:

1. há mecanismo concreto de referência;
2. o CodeStudio foi rastreado até o ponto correspondente;
3. a diferença afeta um requisito declarado;
4. existe caminho de verificação;
5. a recomendação preserva invariantes atuais.

Não são gaps por si só:

- nomes diferentes;
- mais arquivos ou mais tools;
- feature flag encontrada no bundle;
- uma UI visualmente diferente;
- “Claude parece melhor” sem métrica;
- ausência em busca textual.

## 10. Prior art interno e vigência

- `docs/claude-code-parity.md` é canônico para OAuth/request parity do baseline 2.1.215, não para arquitetura completa do CLI: `codestudio_mcp-codebase/docs/claude-code-parity.md:1-10`.
- `docs/claude-desktop-electron-notes.md` registra Desktop 1.8089.1 e deve permanecer versionado: `codestudio_mcp-codebase/docs/claude-desktop-electron-notes.md:1-12`.
- `docs/agent-research/COMPARISON.md` é histórico. Por exemplo, tratava a fronteira estática/dinâmica como gap: `codestudio_mcp-codebase/docs/agent-research/COMPARISON.md:92-140`; o estado atual já a documenta em `codestudio_mcp-codebase/docs/PROMPTS.md:27-38`.
- `docs/PROMPTS.md` e `docs/memory-system.md` são as referências atuais para esses subsistemas.

## 11. Definition of Done

O atlas está completo quando:

- todos os documentos do índice existem e estão linkados;
- toda claim importante aparece no `EVIDENCE_INDEX.md`;
- todo mecanismo possui evidência dos dois lados ou ausência explicitamente rotulada;
- strengths internos não são apagados por busca de paridade;
- toda hipótese de melhoria possui métrica e cenário;
- toda fase futura possui dependências, feature flag/rollout e gate;
- o diff da rodada contém apenas novos Markdown na pasta aprovada;
- links, caminhos, faixas de linha e coerência semântica foram auditados.

## 12. Limites remanescentes

- Nenhum trace runtime do ClaudeOpen foi executado.
- Não sabemos quais feature flags estavam ativas em uma conta real.
- O scheduler remoto de Cowork não está no snapshot.
- Não separamos causalmente qualidade do modelo, prompt, effort e orquestração; isso pertence ao plano de benchmark.
- Riscos de backpressure e crash do CodeStudio são análises estáticas até testes E2E/chaos futuros.
