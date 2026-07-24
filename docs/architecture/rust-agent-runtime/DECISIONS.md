# Registro vinculante de decisões

> **Status:** aceito para implementação  
> **Detalhamento:** [00-scope-decisions.md](./00-scope-decisions.md)

Alterar uma decisão abaixo exige ADR no mesmo diretório, atualização da
checklist e reexecução dos gates afetados.

| ID | Status | Decisão |
|---|---|---|
| D-RUST-001 | Aceita | Rust é o runtime de agentes e tools nativas |
| D-RUST-002 | Aceita | Um processo single-tenant por `AgentRunAttempt` |
| D-RUST-003 | Aceita | Supervisor persistente não mantém estado de agente |
| D-RUST-004 | Aceita | Attempt, owner e fencing definem authority física |
| D-RUST-005 | Aceita | Attempts isolam; run-tree possui orçamento agregado |
| D-RUST-006 | Aceita | TypeScript continua control/integration plane |
| D-RUST-007 | Aceita | Host TypeScript é o único escritor do SQLite central |
| D-RUST-008 | Aceita | Provider Gateway permanece TypeScript na V1 |
| D-RUST-009 | Aceita | `code_exec` executa em subprocesso descartável |
| D-RUST-010 | Aceita | `.proto` gerado é a única autoridade cross-language |
| D-RUST-011 | Aceita | Terminal só existe após barreira durável |
| D-RUST-012 | Aceita | Legado é oracle/fallback temporário, não alvo de remendos |

## Decisões históricas afetadas

| Decisão histórica | Novo entendimento |
|---|---|
| D-002 — convergência híbrida | Preserva capacidades e contratos, não o motor TypeScript |
| D-006 — preservar BT runner | Restrita ao runtime legado; supersedida no Rust |
| D-016 — composition root shadow | Continua como adapter legado, não composição do Rust |
| D-019 — child owner é worker pai | Válida só no legado; no Rust o executor físico é o owner |
| 14 §24 — não reescrever `CoderRunner` | Não se aplica ao novo programa |

## Decisões que permanecem

Continuam vinculantes as decisões históricas sobre:

- journal canônico e projeções;
- Ultra como preset ortogonal;
- tiers como visibilidade;
- Policy Engine único;
- foreground/background compartilhando `AgentRun`;
- memória em camadas;
- eficácia condicionada a benchmark;
- `waitMode` como snapshot;
- um root `AgentRun` por command e filhos hierárquicos.

## Como registrar mudança

Um ADR novo DEVE conter:

1. contexto e evidência;
2. decisão anterior;
3. decisão nova;
4. alternativas;
5. impacto em protocolo, persistência e rollout;
6. riscos e rollback;
7. requisitos/checks afetados;
8. aprovação e data.

