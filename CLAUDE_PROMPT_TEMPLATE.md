# Instruções de Assistência com MCP Code Indexer v3.3

Este projeto possui um índice semântico mantido pelo **MCP Code Indexer v3.3**. Você tem acesso a **41 tools MCP** otimizadas para **economia de tokens**. **Use essas tools como fonte primária de informação antes de ler arquivos diretamente.**

---

## Regra principal

> Sempre que precisar entender código, encontrar algo, ou navegar o projeto — use as tools MCP primeiro.
> Ler arquivos diretamente (`Read`, `cat`) deve ser o último recurso.
> **Prefira sempre as tools v3.3 (token-efficient) sobre as clássicas equivalentes.**

---

## Identificação do projeto

`project_name` segue o formato `Owner/Repo`. Se não souber, comece com:

```
mcp__code-indexer__list_projects
```

---

## Tools v3.3 — PREFIRA ESTAS (token economy)

| Tool | Substitui | Economia |
|---|---|---|
| `get_project_pulse` | `get_project_overview` | ~70× |
| `get_file_skeleton` | `get_file_structure` | ~6× |
| `get_symbol_body` | `Read` do arquivo inteiro | ~10× |
| `prepare_edit` | 5+ chamadas separadas | ~5× |
| `get_context_for` | exploração manual | ~3× |
| `query_snapshots` | `get_project_context` | ~5× |
| `grep_code` | `Grep` cego | filtros semânticos |
| `read_file` (com range) | `Read` integral | sob demanda |
| `list_directory` | navegação manual | indexada |
| `get_recently_modified_files` | git log + ls | direto |

---

## Fluxo recomendado por situação

### Primeira vez no projeto / novo contexto

1. **`get_project_pulse`** — visão ultra-compacta (~100 tokens). Sempre primeiro.
2. **`query_snapshots`** com a área de interesse — chequa conhecimento já indexado.
3. **`get_architecture`** — só se precisar ver camadas em detalhe.
4. **`get_project_context`** ou **`get_project_overview`** com `compact: true` / `max_tokens` se precisar de mais profundidade.

### Usuário pergunta "como funciona X?"

1. **`get_context_for`** com a pergunta em linguagem natural — bundle curado (snapshots + top files + top symbols).
2. Se insuficiente: **`search`** com `mode: "hybrid"`.
3. **`get_file_skeleton`** nos arquivos relevantes (não `get_file_structure`).
4. **`get_symbol_body`** se precisar ver o corpo de uma função.
5. **`trace_usage`** para entender quem chama o quê.

### Usuário pede para modificar código

1. **`prepare_edit`** com o nome do symbol — retorna body + callers + neighbors + imports + tests num só shot. **Substitui 5+ chamadas.**
2. Se prepare_edit não bastar: **`find_references`** + **`get_dependents`**.
3. Edite com `Edit` no arquivo identificado.

### Buscar texto literal

- **`grep_code`** com filtros: `literal`, `case_sensitive`, `language`, `layer`, `glob`.
- Não use `Grep` direto a menos que precise de algo fora do índice.

### Ler partes de um arquivo

- **`read_file`** com `start_line`/`end_line`. Aceita arquivos até **400L** sem range. Para >400L, passe range explícito ou `force: true`. Para arquivos críticos pequenos (errors.ts, constants.ts) prefira ler inteiro — economiza retries e dá contexto completo.

### Fallbacks robustos (v3.3+)

Tools com fallback regex automático quando a DB está incompleta:
- **`get_symbol_body`** acha symbol mesmo se não estiver indexado
- **`get_file_skeleton`** suplementa skeletons esparsos com regex
- **`find_references`** cai pra grep textual quando refs DB estão vazias

Output marcado com `[regex fallback]` / `[grep fallback]` — confie nos resultados, mas considere reindexar com `index_project --force` se ver isso muito.

---

## Tools clássicas (referência)

### Descoberta
- `list_projects`, `get_project_stats`, `get_project_overview` (use `compact: true`), `get_architecture`, `get_project_context` (use `max_tokens`)

### Busca
- `search` (mode: fts/vector/hybrid; type: files/symbols/all)
- `search_global`, `search_concepts`, `search_by_kind`

### Navegação
- `get_file_structure` (verboso — prefira `get_file_skeleton`)
- `get_symbol_details` (por ID)
- `get_class_members`

### Dependências/Refs
- `get_dependencies`, `get_dependents`
- `find_references`, `trace_usage`

### Hierarquia
- `get_hierarchy`, `find_implementations`

### Snapshots
- `list_snapshots` (compact por default), `add_snapshot`, `update_snapshot`, `delete_snapshot`, `get_snapshot_history`

### Admin
- `index_project`, `delete_project`, `get_diff`, `get_costs`, `estimate_cost`, `export_docs`, `list_models`

---

## Regras de ouro de economia

1. **`get_project_pulse` antes de `get_project_overview`** — sempre.
2. **`query_snapshots` antes de explorar código** — muitas perguntas já têm resposta indexada.
3. **`prepare_edit` antes de várias chamadas** — para qualquer edição não trivial.
4. **`get_file_skeleton` antes de `Read`** — quase sempre você só precisa do outline.
5. **Passe `compact: true` ou `max_tokens`** em qualquer tool verbosa quando disponível.
6. **`get_symbol_body` em vez de `Read` integral** quando souber o symbol alvo.
7. **Para arquivos críticos pequenos (errors.ts, constants.ts, types.ts)** use `read_file` integral — o contexto completo evita decisões hesitantes que custam mais retries depois.

---

## Snapshots como memória do projeto

Snapshots armazenam decisões, patterns, arquitetura e convenções. Gerados automaticamente, mas podem ser criados manualmente:

- Decisões importantes → `add_snapshot` (`category: decision`)
- Patterns identificados → `add_snapshot` (`category: pattern`)
- TODOs arquiteturais → `add_snapshot` (`category: todo`)

Sempre consulte `query_snapshots` antes de tomar decisões arquiteturais.

---

## Convenções

- `file_path` é sempre **relativo** à raiz do projeto, com `/` (ex: `src/agent/indexer.ts`).
- `mode: "hybrid"` é o default mais robusto para `search`.
- Cobertura típica de refs após indexação: ~97%.

---

## Quando NÃO usar MCP

- Conteúdo literal de arquivo de config pequeno → `Read` direto.
- Inspeção de mudança não indexada (arquivo recém-criado) → `Read` direto, depois `index_project --force`.
- Operações de filesystem (mv, rm) → bash.
