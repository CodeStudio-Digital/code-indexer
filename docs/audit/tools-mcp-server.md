# Tabela — MCP server (33 tools)

> Snapshot 2026-07-01 · rubrica e flags: [TOOL_AUDIT.md](TOOL_AUDIT.md)
> calls = coluna mcp__<nome> na telemetria do code-agent; clientes MCP externos NÃO aparecem. len = tamanho da descrição em chars.

| tool | tier | calls | err% | len | U | D | G | flags |
|---|---|---|---|---|---|---|---|---|
| estimate_cost | admin | 0 | 0 | 22 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| export_docs | admin | 0 | 0 | 28 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| get_costs | admin | 0 | 0 | 16 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| get_diff | admin | 0 | 0 | 30 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| index_project | admin | 0 | 0 | 27 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| list_models | admin | 0 | 0 | 25 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| get_file_skeleton | bootstrap | 192 | 3.1 | 224 | U2 | D1 | G2 | OK |
| get_project_pulse | bootstrap | 21 | 0 | 137 | U2 | D1 | G2 | OK |
| grep_code | bootstrap | 756 | 1.1 | 159 | U2 | D1 | G2 | OK |
| list_directory | bootstrap | 43 | 2.3 | 203 | U2 | D1 | G2 | OK |
| rag_search_docs | bootstrap | 4 | 0 | 669 | U1 | D2 | G2 | OK |
| read_file | bootstrap | 1785 | 2.4 | 952 | U2 | D1 | G2 | OK |
| search | bootstrap | 24 | 0 | 175 | U2 | D1 | G2 | OK |
| find_implementations | navigate | 0 | 0 | 36 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| find_references | navigate | 10 | 0 | 236 | U1 | D1 | G2 | OK |
| get_architecture | navigate | 2 | 0 | 58 | U1 | D0 | G2 | WEAK-DESC |
| get_class_members | navigate | 0 | 0 | 22 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| get_dependencies | navigate | 0 | 0 | 31 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| get_dependents | navigate | 2 | 0 | 37 | U1 | D0 | G2 | WEAK-DESC |
| get_file_structure | navigate | 0 | 0 | 152 | U0 | D1 | G2 | ZERO-CALL |
| get_hierarchy | navigate | 0 | 0 | 63 | U0 | D1 | G2 | ZERO-CALL |
| get_project_overview | navigate | 3 | 0 | 148 | U1 | D1 | G2 | OK |
| get_recently_modified_files | navigate | 2 | 0 | 37 | U1 | D0 | G2 | WEAK-DESC |
| get_repo_map | navigate | 3 | 0 | 287 | U1 | D1 | G2 | OK |
| get_symbol_body | navigate | 92 | 5.4 | 257 | U2 | D1 | G2 | OK |
| get_symbol_details | navigate | 0 | 0 | 24 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| prepare_edit | navigate | 0 | 0 | 357 | U0 | D1 | G2 | ZERO-CALL |
| save_memory | navigate | 2 | 0 | 319 | U1 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| search_by_kind | navigate | 0 | 0 | 115 | U0 | D1 | G2 | ZERO-CALL |
| search_concepts | navigate | 0 | 0 | 21 | U0 | D0 | G2 | WEAK-DESC ZERO-CALL |
| search_memory | navigate | 7 | 0 | 348 | U1 | D1 | G2 | OK |
| semantic_neighbors | navigate | 0 | 0 | 264 | U0 | D1 | G2 | ZERO-CALL |
| trace_usage | navigate | 0 | 0 | 81 | U0 | D1 | G2 | ZERO-CALL |
