# 04 — Plano de migração, validação e retirada

> **Status:** P0-P2 e bridge P3 local executados; gate P3 físico e P4-P6 pendentes
> **Regra:** nenhuma fase promove apenas por código escrito

## 1. Princípios

- preservar sessões ativas;
- mudanças aditivas antes de destrutivas;
- comparar comportamento real, não prosa de agente;
- uma variável por experimento sempre que possível;
- fallback não pode produzir execução duplicada;
- o legado não recebe uma reestruturação arquitetural;
- toda compatibilidade temporária nasce com owner e prazo de remoção.

## 2. Sequência

```mermaid
flowchart LR
    P0["P0 Baseline"] --> P1["P1 Resolver shadow"]
    P1 --> P2["P2 Contratos e catálogo"]
    P2 --> P3["P3 Engine/ToolHost shadow"]
    P3 --> P4["P4 Canário"]
    P4 --> P5["P5 Default Rust"]
    P5 --> P6["P6 Retirada"]
```

## 3. P0 — Freeze e baseline

Entregáveis:

- collector AST de env/settings/consumers;
- snapshot de resolução efetiva sem segredos;
- benchmark versionado de prompts, schemas e turns;
- corpus de tarefas para native tools, Unity MCP, plugin, skill, Company,
  subagente, policy/approval e output spill;
- lista de rows SQLite órfãs;
- owners para cada família de configuração.

Gate `P0`:

- todos os identifiers têm consumer e disposição conhecidos;
- valores conflitantes têm decisão explícita;
- baseline é reproduzível no build instalado;
- nenhum arquivo do runtime foi alterado.

## 4. P1 — Resolver tipado em shadow

Implementar schema/resolver e adapter legacy, sem mudar execução. Para cada
launch, calcular legacy e new result e armazenar diff redigido.

Gate `P1`:

- 100% de parse/validation tests;
- digest idêntico Rust/TS;
- zero diferença inexplicada nos cenários suportados;
- invalidez e clamp têm comportamento tipado;
- API/UI mostram o mesmo valor da attempt spec;
- nenhuma leitura nova de env fora da allowlist.

Rollback: desligar somente o comparador shadow; execução continua legacy.

## 5. P2 — Contratos de catálogo e projeção

Implementar no alvo Rust/Host:

- descriptor canônico;
- host catalog snapshot;
- authorized set na attempt;
- provider projection;
- `capability_catalog`;
- adapters para fontes native, ToolHost, MCP, plugin e skill;
- eventos/digests.

O legado pode exportar seu catálogo como oracle, sem trocar seu registry.

Gate `P2`:

- golden hashes e schemas;
- projection não inclui catálogo integral;
- search/activate não concede permission;
- MCP tardio altera apenas próxima attempt;
- todos os providers suportados passam seus limites;
- nenhuma mutação é repetida após accepted sem idempotency/probe.

## 6. P3 — Shadow de execução

Seguir os gates do corpus Rust para provider, tools nativas e ToolHost. O
runtime Rust executa apenas tarefas shadow/read-only ou replay controlado até
provar equivalência.

Matrizes mínimas:

| Cenário | Prova |
|---|---|
| filesystem/search/patch/git/process/http | resultado, limite, cancel e cleanup |
| MCP read-only | discovery, schema, call e output |
| MCP mutante | accepted/started/terminal e unknown |
| skill | seleção, ativação e instruções |
| plugin | manifest/revision/executor |
| policy | allow/ask/deny/fence |
| subagente | budget agregado, cancel e resultado |
| Company | role/catalog/session lifecycle |
| output grande | reducer/preview/artifact/refetch |
| restart | journal/checkpoint/recovery sem duplicar efeito |

Gate `P3`: equivalência funcional executável e nenhuma regressão crítica de
segurança/dados.

### Estado local em 2026-08-05

A bridge de código e o corpus local estão implementados no documento 11. Esse
slice prova o dispatch único e os controles antes do executor, mas não fecha o
gate acima: MCP/plugin externos físicos, subagentes/Company completos,
restart/recovery e comparação no build instalado permanecem obrigatórios.

## 7. P4 — Canário por attempt

Roteamento é escolhido antes do launch e persistido. Fallback só ocorre antes
de `LaunchAccepted` ou por contrato explícito que prove inexistência de efeito.

Ramp sugerido: ambiente interno -> 1% -> 5% -> 25% -> 50% -> 100%, sempre com
janela mínima de observação e rollback testado. Percentuais podem mudar por ADR;
os gates não.

Stop conditions:

- corrupção/perda de sessão;
- bypass de policy/fence;
- leak de processo/recurso;
- mutação duplicada ou outcome falsamente classificado;
- regressão estatisticamente/materialmente relevante de sucesso;
- crescimento de latency/token/schema além do budget aprovado.

## 8. P5 — Rust como default

Pré-condições:

- novas attempts usam Rust por default;
- restart e recovery estão provados;
- dashboards e runbooks usam métricas novas;
- rollback para última versão Rust estável não reativa dual-execution;
- bridge legacy existe apenas para exceções enumeradas.

## 9. P6 — Retirada

Ordem segura:

1. bloquear novos callers do executor legado;
2. drenar attempts/sessões compatíveis;
3. remover worker pools/launchers legados;
4. remover `runCoder` e registry/tools de execução;
5. remover code-exec legado;
6. remover package/dependências/bundles;
7. remover flags/settings/UI/telemetria/runbooks;
8. limpar rows órfãs por migration;
9. manter somente bridges de leitura histórica necessários;
10. provar build instalada sem artefato executor legado.

## 10. Gates de desempenho

Os targets abaixo são budgets de planejamento. P0 pode torná-los mais rígidos;
afrouxá-los exige ADR.

| Métrica | Baseline | Gate proposto |
|---|---:|---:|
| schemas visíveis, mediana | 20.683 chars | <= 12 KiB ou redução >= 40% |
| catálogo elegível serializado | ~117 KiB antes do cap | 0 bytes do catálogo integral |
| churn sem ativação | 11/26 runs tiveram múltiplos fingerprints | 0 |
| resolver/projeção local p95 | não isolado | <= 50 ms |
| search local p95 | não isolado | <= 50 ms, sem I/O MCP |
| preflight síncrono | mediana 5.637 ms | removido do caminho crítico padrão |

Também são gates:

- task success e first-pass success não inferiores ao baseline;
- capability obrigatória no top-5 >= 95% no corpus e 100% nos cenários
  críticos explicitamente rotulados;
- primeira tool correta não inferior;
- nenhum aumento não explicado de tokens, tempo ou correções humanas;
- memory/CPU/process count dentro dos gates do runtime Rust.

## 11. Gates estruturais

CI deve falhar para:

- novo acesso direto a `process.env.CODER_*`;
- nova flag `MCP_PIPELINES_*` no code-run;
- descriptor sem version/digest/owner;
- alias legado sem expiry;
- capability que mistura visibility e authorization;
- catalog mutation durante attempt;
- retry de host mutation após accepted sem probe/idempotency;
- schema/prompt sem byte budget;
- configuração exposta na UI sem consumer no resolver.

## 12. Validação final

Checklist de conclusão:

- [ ] config resolver é autoridade única;
- [ ] UI/API/attempt/Rust/host têm paridade;
- [ ] catálogo completo nunca entra no provider;
- [ ] tools, skills, plugins e MCP usam um descriptor/lifecycle;
- [ ] discovery universal substituiu superfícies antigas;
- [ ] guards objetivos permanecem sempre ativos;
- [ ] benchmarks e chaos passaram no build instalado;
- [ ] canário e rollback foram exercitados;
- [ ] sessões ativas foram preservadas durante rollout;
- [ ] flags, rows, código e telemetria mortos foram retirados;
- [ ] não resta executor TypeScript novo ou fallback indefinido.

## 13. Registro de aprovação

A execução de P0-P2 e do adapter B2 foi autorizada em 2026-08-05. A aprovação
confirmou:

1. regra de baseline efetivo;
2. campos finais da `RuntimePolicy`;
3. UX de presets e overrides;
4. contrato `capability_catalog`;
5. política de MCP tardio;
6. budgets de desempenho;
7. corpus de aceitação;
8. owners/expiries de compatibilidade.

Esta autorização não promove o runtime em produção. P3-P6 continuam exigindo
os gates executáveis deste documento e os receipts descritos no documento 10.
