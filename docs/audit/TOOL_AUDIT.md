# Auditoria de ferramentas — utilidade, qualidade, descrição e prompt

> **Snapshot**: 2026-07-01 · branch `feature/ide-mvp` · commit `de8499a4`
> **Telemetria**: `~/.mcp-code-indexer/index.db` → `coder_tool_calls`, 11.040 chamadas (2026-06-02 → 2026-07-01)
> **Método**: inventário completo das 4 superfícies + verificação mecânica de terse-safety (script tsx sobre os arrays reais) + telemetria por tool. Este arquivo é um retrato datado; a regra durável fica no teste-guarda `description-style.test.ts`.

Tabelas por superfície: [tools-mcp-server.md](tools-mcp-server.md) · [tools-code-agent.md](tools-code-agent.md) · [tools-company.md](tools-company.md)

## Rubrica

| Eixo | Graus | Evidência |
|---|---|---|
| **U** utilidade | U2 ≥20 calls · U1 1–19 · U0 zero | telemetria 30d + análise de sobreposição |
| **Q** qualidade | Q2 sólida · Q1 lacunas · Q0 arriscada | caps de output, fallback, erro estruturado, err% |
| **D** descrição | D2 house-style · D1 parcial · D0 fraca | 1ª frase terse-safe; USE/DON'T onde ambíguo; caps documentados |
| **G** guidance | G2 · G1 | menção em prompt onde crítico; entrada em SHORT_DESCRIPTIONS |

Flags: `OK` · `WEAK-DESC` · `TERSE-UNSAFE` · `OVERLAP` · `RETIRE-CANDIDATE` · `MISSING-GUIDANCE` · `QUALITY-RISK` · `ZERO-CALL`.

**Caveats de leitura**: (1) tiers gated (admin/master/api/company/builder) têm 0 calls estruturalmente — 0 ≠ morta; (2) a telemetria só cobre o code-agent — chamadas de **clientes MCP externos** (Claude Code etc. conectados ao servidor) não aparecem; (3) janela de 30 dias.

## Template house-style para descrições

```
Linha 1: frase imperativa AUTOSSUFICIENTE, ≤150 chars, termina em '.'.
         Sem 'e.g.'/'i.e.'/nomes-de-arquivo-com-ponto antes do 1º ponto final.
         É tudo que o modelo vê em terse mode — precisa identificar a tool sozinha.
USE: 1–3 linhas, só onde o roteamento entre tools é genuinamente ambíguo.
DON'T: nomeia o anti-padrão E a tool correta pelo nome exato.
Caps/defaults: "Returns at most N…", "Default X, max Y", comportamento de fallback.
Regras: sem interpolação runtime (bit-stable p/ cache); sem emoji; inglês.
```

## Achados

### F1 — Bug sistêmico: `terseDescription()` não reconhece `".\n"` (CRÍTICO)
`descriptions.ts:205` corta na primeira ocorrência de `'. '` (ponto+espaço), mas o house style
dos descriptions usa `".\n"` (ponto+quebra) entre a 1ª frase e o bloco USE/DON'T. Resultado:
**9 tools de alto tráfego sofriam hard-cut no meio da palavra** em terse mode (`git_status` 77 calls,
`lsp_diagnostics` 244, `manage_path` 67, `git_log`, `git_branch`, `lsp_hover`, `lsp_references`,
`web_fetch`, `web_search`, `exit_worktree`, `read_sandbox_logs`, `preview_wait_for`).
O bridge (`mcp-bridge.ts:67`) já corta em `[.\n]` — as duas funções divergiam.
**Correção**: alinhar `terseDescription()` ao regex do bridge (primeiro `[.\n]` ≤150).

### F2 — 11 descrições TERSE-UNSAFE mesmo com a função corrigida
1ª frase curta demais, longa demais (>150) ou com ponto "falso":
`create_file`, `git_diff`, `git_add`, `rag_read_doc`, `update_todo`, `preview_open`,
`preview_press`, `preview_scroll` (code-agent); `docs_index_update` (corta em
"Rewrite \`docs/index." — ponto de nome de arquivo!), `env_delete` (company);
`save_memory` (MCP server). **Correção**: reescrever a 1ª frase de cada uma.

### F3 — 14 descrições fracas no MCP server (WEAK-DESC)
3–6 palavras, sem caps/params/cross-refs: `get_costs`, `estimate_cost`, `get_diff`,
`export_docs`, `list_models`, `index_project` (admin); `get_symbol_details`, `get_class_members`,
`get_hierarchy`, `find_implementations`, `get_dependencies`, `get_dependents`,
`get_recently_modified_files`, `search_concepts`, `get_architecture`.
Contraste: `read_file`/`prepare_edit`/`search_memory` têm o padrão da casa completo.
Como o bridge propaga a descrição do servidor dinamicamente, **uma correção por tool** basta.

### F4 — Metade do MCP server nunca é chamada (17/33 ZERO-CALL)
Com os caveats acima, ainda chama atenção:
- **`prepare_edit` (0 calls)** — a tool composta "substitui 5+ chamadas", promovida em `base.txt`
  e `build.txt`, nunca foi usada; agentes preferem `get_symbol_body` (92) + `find_references` (10).
- Família simbólica parada: `trace_usage`, `semantic_neighbors`, `get_hierarchy`,
  `find_implementations`, `get_class_members`, `get_symbol_details`, `search_by_kind`,
  `search_concepts`, `get_file_structure` — todas 0.
- Família admin (`get_costs`, `estimate_cost`, `list_models`, `export_docs`, `get_diff`,
  `index_project`) — 0 via agente, mas são a superfície de clientes externos/CLI.

### F5 — Sobreposições (OVERLAP)
- **Overview ×4**: `get_project_pulse` (21 calls) venceu; `get_project_overview` (3),
  `get_repo_map` (3), `get_architecture` (2) quase não são usadas. `get_architecture` é
  subconjunto estrito do overview. Recomendação: manter pulse+repo_map (papéis distintos
  ~250 vs ~2000 tokens), rebaixar overview/architecture a candidatas.
- **`get_file_structure` (0) vs `get_file_skeleton` (192)**: skeleton venceu; structure é
  redundante (mesma info + metadados raramente úteis).
- **`search_concepts` (0) / `search_by_kind` (0) vs `search` (24)**: o planner do `search`
  já roteia; as especializadas perderam a função.

### F6 — Taxas de erro altas (QUALITY-RISK)
| tool | calls | err% | leitura |
|---|---|---|---|
| `run_command` | 794 | 20,4% | 1 em 5 falha — investigar mix (comando inválido vs bloqueio de shell vs timeout) |
| `submit_plan` | 37 | 18,9% | rejeições de gate contam como erro? separar verdito de falha |
| `preview_open` | 59 | 15,3% | app não sobe / CDP não conecta |
| `edit_file` | 303 | 14,2% | snippet não encontrado (fuzzy) — descrição já orienta, monitorar |
| `lsp_diagnostics` | 244 | 11,9% | LSP frio? |
| `ds_publish_version` | 9 | 55,6% | pipeline de publish frágil |
| `ds_component` | 13 | 30,8% | nome de componente errado → melhorar erro |
| `grep_code` (sem prefixo!) | 3 | 100% | modelo tenta o nome SEM `mcp__` → confusão de nomes; ver F7 |
Análise por `error_class` fica como follow-up (a tabela tem `is_error` binário).

### F7 — Confusão de nomes com/sem prefixo `mcp__`
`grep_code` (3 calls, 100% err) e chamadas a tools aposentadas (`mcp__list_projects` 3,
`mcp__get_project_stats` 2) mostram o modelo chutando nomes. O alias-normalizer atual
conserta **args**, não nomes. Candidato a follow-up: sugestão "did you mean" no erro
de unknown-tool (já existe no company; portar para o runner single).

### F8 — SHORT_DESCRIPTIONS (tooltips de UI) sem cobertura de preview/api (G1)
104 entradas cobrem bootstrap/navigate/admin/master, mas as famílias `preview_*` (27),
`api_*` (7) e as company estáticas caem no fallback `''` no diálogo de config. Cosmético.

## Candidatas à aposentadoria (só análise — nada removido nesta passada)

Evidência = 0 calls em 30d + sobreposição + sem menção em prompts (grep 2026-07-01).

| tool | evidência | risco de remover |
|---|---|---|
| `mcp__get_file_structure` | 0 calls; skeleton cobre | baixo |
| `mcp__search_concepts` | 0 calls; `search` roteia | baixo |
| `mcp__search_by_kind` | 0 calls; `search`+`grep_code` cobrem | baixo |
| `mcp__get_class_members` | 0 calls; skeleton/symbol_body cobrem | baixo |
| `mcp__get_symbol_details` | 0 calls; exige symbol_id (fluxo morto) | baixo |
| `mcp__get_architecture` | 2 calls; subconjunto do overview | baixo |
| `mcp__trace_usage` | 0 calls; find_references cobre 90% | médio (único p/ árvore) |
| `mcp__semantic_neighbors` | 0 calls; exige symbol_id + vetores | médio |
| `mcp__get_hierarchy` / `find_implementations` | 0 calls; LSP cobre p/ TS | médio (outras langs) |
| `mcp__prepare_edit` | 0 calls apesar de promovida | **alto** — decidir: retirar OU consertar a adoção (prompt/descrição); não os dois |
| `list_agents`/`send_message`/`send_input`/`followup_task` | 0 calls (multi-agente single) | médio — feature nova |
Família admin (`get_costs` etc.): **não** aposentar — superfície de CLI/clientes externos fora da telemetria.

## Log de correções aplicadas (2026-07-02)

- [x] F1: `terseDescription()` alinhada ao bridge (`packages/code-agent/src/tools/descriptions.ts`) — corta em `[.\n]` ≤150, hard-cut com `.trim()` idêntico. Resolve sozinha 9 hard-cuts de alto tráfego.
- [x] F2: 13 primeiras-frases reescritas — code-agent: `create_file`, `git_diff`, `git_add`, `rag_read_doc`, `update_todo`, `preview_open`, `preview_press`, `preview_scroll`; company: `docs_index_update`, `env_delete`, `set_agent_status`, `ds_docs` (2 últimas achadas na extração das factory); MCP server: `save_memory`.
- [x] F3: 16 descrições do MCP server reescritas no house style (`misc.ts` ×5, `symbols.ts` ×4, `projects.ts` ×2, `search.ts` ×1, `file.ts` ×3, `snapshots.ts` ×1).
- [x] Guarda: `src/__tests__/description-style.test.ts` — asserta terse-safety (hard-cut/abbrev/min-25) sobre code-agent + company estáticas + MCP server, e paridade entre os dois transforms. Verificação mecânica pós-fix: **0 violações em 131 tools** + 66 company factory limpas.
- [x] `SYSTEM_PROMPT_VERSION` → `20260702.2` (entrada de histórico no arquivo).
- [x] Suítes verdes: description-style, tools-array-stability, tier-contract, tool-priority, prompt-budget, agent-prompts, tiers, system-prompt (95 testes). `SHORT_DESCRIPTIONS` sem mudança (semânticas preservadas).
- Nota: `symbols-disk-fallback` / `read-file-feature-parity` / `file-skeleton-fallback` não rodam neste ambiente — gotcha pré-existente de ABI do better-sqlite3 (buildado p/ Electron, NODE_MODULE_VERSION 146≠127); não relacionado (mudanças são só texto de descrição).
## Follow-ups executados (2026-07-02)

- [x] **F6 — `error_class` na telemetria**: migração 186 (`coder_tool_calls.error_class`), classificador `tool-error-class.ts` (unknown_tool / invalid_args / not_found / command_failed / network / timeout / policy / permission / handler_exception / other; NULL em refusals — analytics usam `COALESCE(refusal_kind, error_class)`), computado nos 3 sites de insert (store appendToolCall + persistAssistantTurn + dbWriter worker). Teste: `classify-tool-error.test.ts` (10 casos).
- [x] **F7 — did-you-mean**: JÁ ESTAVA implementado (`tool-name-suggest.ts`, matching 3 camadas: case-insensitive → namespace-blind → Levenshtein) e ligado no `registry.invoke()` — entrou no lote 20260702.1; teste cobre o caso `grep_code`→`mcp__grep_code`. Nada a fazer.
- [x] **`prepare_edit` — adoção consertada** (decisão do usuário): descrição ganhou 1ª frase de roteamento + USE/DON'T explícito vs `get_symbol_body`; `build.txt` e `builder.txt` agora ensinam `prepare_edit` PRIMEIRO para edições (antes o `get_symbol_body` vinha primeiro na frase e vencia). Reavaliar telemetria na próxima janela.
- [x] **6 aposentadas** (risco baixo, decisão do usuário): `get_file_structure`, `search_concepts`, `search_by_kind`, `get_class_members`, `get_symbol_details`, `get_architecture` — removidas do servidor (33→27), de NAVIGATE_TOOLS/SHORT_DESCRIPTIONS, do EXPLORE_ALLOWLIST/REVIEW, do overlay, das listas de compactação, do master-filter e dos prompts; adicionadas à lista de retired do tier-contract (strict throw). Bônus: prompt do master ensinava `get_project_stats` (aposentada na leva anterior) — corrigido para pulse/overview/search.
- [x] `SYSTEM_PROMPT_VERSION` → `20260702.3` (entrada própria; sessão paralela seguiu para .4 por cima, sem conflito).
- [x] Suítes: 12 arquivos / 125 testes verdes (inclui o teste-guarda pegando 1 violação real introduzida em paralelo — `get_hierarchy` — corrigida). `file-skeleton-fallback`/`messages-tool-pairing` seguem bloqueados pelo ABI do better-sqlite3 (pré-existente, ambiental).
- [ ] Pendente de janela futura: reavaliar adoção de `prepare_edit`; candidatas de risco médio (`trace_usage`, `semantic_neighbors`, `get_hierarchy`/`find_implementations`, família multi-agente single) permanecem só listadas.
