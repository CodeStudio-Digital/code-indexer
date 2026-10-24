# 02 — Spec de configuração do runtime

> Documento histórico anterior à remoção do runtime Rust. Os caminhos e resultados descrevem o checkpoint da época; consulte o [estado atual](../runtime-retirement.md).

> **Status:** proposta normativa para aprovação  
> **Requisitos:** `CFG-*`

## 1. Objetivo

Substituir leituras dispersas de env por uma política tipada, pequena e
reproduzível. A solução NÃO DEVE recriar as 208 chaves como 208 propriedades.

## 2. Autoridades

### CFG-001 — Schema único

Deve existir um schema versionado `RuntimePolicySchema` no pacote de contratos.
O mesmo parser/validador é usado por admin API, control plane, launcher,
Provider Gateway, ToolHost e adapters de compatibilidade.

### CFG-002 — Resolução em camadas

Ordem de resolução:

1. defaults de produto versionados no código;
2. configuração de deployment/host validada;
3. configuração durável do operador, apenas para campos permitidos;
4. preset de agente/workspace/sessão;
5. overrides explícitos do request permitidos pelo schema;
6. clamps de provider, plataforma, segurança e resource grant.

Cada campo guarda `value`, `source`, `sourceRevision` e eventual `clampedBy`.

### CFG-003 — Snapshot por attempt

O resolver produz:

```ts
interface ResolvedRuntimePolicyV1 {
  schemaVersion: 1;
  policyId: string;
  policyDigest: string;
  resolvedAt: string;
  productPreset: string;
  provider: ProviderPolicy;
  context: ContextPolicy;
  capabilities: CapabilityProjectionPolicy;
  execution: ExecutionBudgetPolicy;
  subagents: SubagentPolicy;
  host: HostResourcePolicy;
  diagnostics: DiagnosticsPolicy;
  provenance: readonly ResolvedFieldProvenance[];
}
```

O snapshot é persistido na attempt spec. Código da attempt recebe esse objeto,
não store, resolver ou `process.env`.

### CFG-004 — Segredos são refs

Policy contém `credentialRef`/`secretRef`, nunca valor secreto. A resolução do
segredo ocorre na borda autorizada e não entra em prompt, journal ou digest
público.

## 3. Superfície permitida

### 3.1 Defaults de produto, sem toggle

São comportamento do produto:

- loop atual do agente;
- compaction/summarization atual aprovado;
- conversation chapters e reducer;
- reparo de transcript e output spill;
- guards objetivos e enforcement de policy;
- descoberta determinística de capabilities;
- compatibilidade de argumentos durante sua janela de migração.

Não aparecem na UI como liga/desliga.

### 3.2 Política tipada

Campos que representam decisão legítima:

| Grupo | Exemplos |
|---|---|
| provider | provider/model, reasoning, deadlines e retry budget |
| context | orçamento do contexto, output preview/spill e compaction profile |
| capabilities | allow/deny, namespaces, risk policy, schema budget |
| execution | wall time, max turns/calls, background e cancellation |
| subagents | perfis permitidos, concorrência e orçamento agregado |
| host | memória/CPU/disco/processos por attempt e run-tree |
| diagnostics | trace level, redaction e sampling |

Esses campos são agrupados em presets com poucos overrides, não expostos como
dezenas de números independentes.

### 3.3 Constantes internas

Heurísticas como fuzzy tolerance, dominance window, retry jitter, LRU size,
flush tranche e cooldown deixam de ser settings. São constantes versionadas,
cobertas por testes/benchmarks e alteradas por revisão de código.

### 3.4 Env permitida

Uma allowlist explícita pode conter somente:

- bootstrap de path/endpoint/port necessário antes do config store;
- segredo ou referência de segredo que ainda não tenha secret store;
- diagnóstico de desenvolvimento (`log level`, trace, prompt watch);
- kill switch de emergência fail-closed;
- seleção temporária de canário/rollback, com owner e expiry.

Cada chave deve possuir owner, motivo, data de expiração e teste de remoção.
Leitura fora do módulo allowlisted falha em lint/CI.

## 4. Invariantes que não podem ser relaxados

### CFG-005

Configuração comum não pode desligar:

- Policy Engine e approvals;
- workspace/environment binding e fencing;
- resource enforcement;
- transcript/tool pairing repair;
- tuple-hash, doom-loop, failure-streak e dominance;
- caps/spill de output;
- cleanup, cancel e reaping;
- schema validation e sanitização de metadata externa.

### CFG-006

“Unrestricted” nunca significa sem limites. Significa um preset com budgets
maiores, ainda limitado pelo resource grant e pela policy.

### CFG-007

Valor inválido não pode cair silenciosamente para outro default. O resolver
falha fechado para segurança/recursos e retorna erro de validação para política
de produto.

## 5. Preservação da configuração atual

### CFG-008 — Legacy resolution snapshot

Antes da migração, um collector read-only deve registrar, sem segredos:

```text
key
raw DB value
raw inherited env value
catalog default
consumer fallback
effective value no processo/worker
consumer locations
read timing (module/boot/attempt/turn)
```

O artifact é versionado pelo commit, build, host e timestamp.

### CFG-009 — Regra de conflito

1. override DB explícito e válido é preservado como configuração durável;
2. na ausência de override, prevalece o comportamento realmente executado;
3. `.env` local só prevalece se comprovadamente herdado pelo processo alvo;
4. default divergente apenas exibido pela UI é corrigido, não preservado;
5. row sem consumer é reportada e removida por migration;
6. chave com mais de um consumer divergente bloqueia cutover até decisão.

### CFG-010 — Comparador shadow

Por um período, o host calcula legacy e new policy lado a lado, sem alterar a
execução, e emite somente diferenças redigidas. Zero diferenças inexplicadas é
gate para canário.

## 6. API e UI

### CFG-011

A API administrativa deve mostrar exatamente o snapshot que o launcher usará:

- valor efetivo;
- origem;
- clamp;
- necessidade e escopo de reinício;
- attempts afetadas (novas somente);
- versão/digest da policy.

### CFG-012

Não existe mutação “hot” de uma attempt em andamento. Alteração produz nova
revision de configuração e vale para a próxima attempt compatível.

### CFG-013

A UI padrão mostra presets e decisões operacionais. Constantes internas,
rollouts e diagnóstico ficam fora da tela comum.

## 7. Contratos de teste

### CFG-014 — Paridade

Golden tests devem provar o mesmo resultado em:

- resolver puro;
- API administrativa;
- attempt spec persistida;
- Rust deserializado;
- Provider Gateway;
- ToolHost.

### CFG-015 — Determinismo

Mesmo input canônico produz os mesmos bytes e digest em Rust/TypeScript,
independentemente de ordem de objeto, locale e processo.

### CFG-016 — Proibição estrutural

Após cutover:

```text
process.env.CODER_* == 0 ocorrências em engine/tools/skills/MCP/provider
process.env.MCP_PIPELINES_* == 0 ocorrências no code-run
```

Exceções existem apenas no módulo de bootstrap allowlisted e são verificadas
por AST, não por regex textual simples.

## 8. Não objetivos

- transformar todos os knobs em CLI flags;
- permitir ajuste fino por sessão de heurísticas internas;
- hot-reload de policy dentro de attempt;
- armazenar segredos no snapshot;
- usar SQLite como barramento de configuração em tempo real.

