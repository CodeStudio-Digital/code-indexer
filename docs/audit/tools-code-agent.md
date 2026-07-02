# Tabela — code-agent (83 tools estáticas + factory)

> Snapshot 2026-07-01 · rubrica e flags: [TOOL_AUDIT.md](TOOL_AUDIT.md)
> Tools factory (code_exec, expand_toolset, find_tools, spawn_agent, self_review, remember/recall_memory, skills, ds_*) não são importáveis estaticamente — avaliadas nas notas do TOOL_AUDIT.md via telemetria (todas U1/U2 ativas). api/preview/admin/master são tiers gated: ZERO-CALL esperado.

| tool | tier | calls | err% | len | U | D | G | flags |
|---|---|---|---|---|---|---|---|---|
| enter_worktree | admin | 0 | 0 | 743 | U0 | D2 | G2 | ZERO-CALL |
| exit_worktree | admin | 0 | 0 | 577 | U0 | D0 | G2 | TERSE-UNSAFE(abbrev-cut) ZERO-CALL |
| git_add | admin | 0 | 0 | 253 | U0 | D0 | G2 | TERSE-UNSAFE(too-short) ZERO-CALL |
| git_branch | admin | 0 | 0 | 227 | U0 | D0 | G2 | TERSE-UNSAFE(hard-cut) ZERO-CALL |
| git_commit | admin | 0 | 0 | 331 | U0 | D2 | G2 | ZERO-CALL |
| api_get_request | api | 0 | 0 | 97 | U0 | D1 | G1 | ZERO-CALL |
| api_import_openapi | api | 0 | 0 | 217 | U0 | D1 | G1 | ZERO-CALL |
| api_list_requests | api | 0 | 0 | 187 | U0 | D1 | G1 | ZERO-CALL |
| api_mark_verified | api | 0 | 0 | 260 | U0 | D1 | G1 | ZERO-CALL |
| api_run_collection | api | 0 | 0 | 244 | U0 | D1 | G1 | ZERO-CALL |
| api_run_request | api | 0 | 0 | 324 | U0 | D1 | G1 | ZERO-CALL |
| api_update_request | api | 0 | 0 | 231 | U0 | D1 | G1 | ZERO-CALL |
| ask_user | bootstrap | 23 | 4.3 | 1209 | U2 | D2 | G2 | OK |
| create_goal | bootstrap | 113 | 0 | 500 | U2 | D1 | G2 | OK |
| followup_task | bootstrap | 0 | 0 | 769 | U0 | D2 | G1 | ZERO-CALL |
| get_tool_output | bootstrap | 52 | 3.8 | 646 | U2 | D2 | G2 | OK |
| glob | bootstrap | 93 | 1.1 | 694 | U2 | D2 | G2 | OK |
| list_agents | bootstrap | 0 | 0 | 542 | U0 | D2 | G1 | ZERO-CALL |
| list_directory | bootstrap | 32 | 9.4 | 391 | U2 | D2 | G2 | OK |
| rag_read_doc | bootstrap | 0 | 0 | 629 | U0 | D0 | G2 | TERSE-UNSAFE(hard-cut) ZERO-CALL |
| rag_search_docs | bootstrap | 4 | 0 | 1198 | U1 | D2 | G2 | OK |
| read_file | bootstrap | 1623 | 2.8 | 1056 | U2 | D2 | G2 | OK |
| send_input | bootstrap | 0 | 0 | 874 | U0 | D2 | G1 | ZERO-CALL |
| send_message | bootstrap | 0 | 0 | 939 | U0 | D2 | G1 | ZERO-CALL |
| submit_plan | bootstrap | 37 | 18.9 | 651 | U2 | D2 | G2 | QUALITY-RISK(err 18.9%) |
| submit_spec | bootstrap | 0 | 0 | 324 | U0 | D1 | G1 | ZERO-CALL |
| task_list | bootstrap | 39 | 0 | 1140 | U2 | D1 | G2 | OK |
| update_goal | bootstrap | 116 | 6 | 208 | U2 | D1 | G2 | OK |
| view_image | bootstrap | 1 | 100 | 791 | U1 | D2 | G1 | OK |
| wait_agents | bootstrap | 8 | 0 | 664 | U1 | D2 | G1 | OK |
| apply_patch | navigate | 176 | 6.3 | 883 | U2 | D1 | G1 | OK |
| archive_task_list | navigate | 0 | 0 | 141 | U0 | D1 | G2 | ZERO-CALL |
| cancel_tasks | navigate | 0 | 0 | 153 | U0 | D1 | G2 | ZERO-CALL |
| create_file | navigate | 210 | 0.5 | 470 | U2 | D0 | G2 | TERSE-UNSAFE(too-short) |
| decision_gate | navigate | 2 | 50 | 920 | U1 | D2 | G2 | OK |
| delete_tasks | navigate | 0 | 0 | 168 | U0 | D1 | G2 | ZERO-CALL |
| edit_file | navigate | 303 | 14.2 | 842 | U2 | D2 | G2 | OK |
| exec_command | navigate | 24 | 4.2 | 1354 | U2 | D2 | G2 | OK |
| get_diagnostics | navigate | 203 | 3.9 | 685 | U2 | D2 | G2 | OK |
| get_goal | navigate | 2 | 0 | 202 | U1 | D1 | G2 | OK |
| git_diff | navigate | 163 | 9.8 | 259 | U2 | D0 | G2 | TERSE-UNSAFE(too-short) |
| git_log | navigate | 2 | 0 | 209 | U1 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| git_status | navigate | 77 | 7.8 | 224 | U2 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| http_request | navigate | 3 | 0 | 464 | U1 | D1 | G1 | OK |
| list_sessions | navigate | 14 | 0 | 429 | U1 | D2 | G2 | OK |
| list_tasks | navigate | 0 | 0 | 148 | U0 | D1 | G2 | ZERO-CALL |
| lsp_definition | navigate | 0 | 0 | 571 | U0 | D2 | G2 | ZERO-CALL |
| lsp_diagnostics | navigate | 244 | 11.9 | 624 | U2 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| lsp_hover | navigate | 0 | 0 | 595 | U0 | D0 | G2 | TERSE-UNSAFE(hard-cut) ZERO-CALL |
| lsp_references | navigate | 0 | 0 | 528 | U0 | D0 | G2 | TERSE-UNSAFE(hard-cut) ZERO-CALL |
| manage_path | navigate | 67 | 1.5 | 510 | U2 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| multi_edit | navigate | 284 | 4.2 | 887 | U2 | D2 | G2 | OK |
| run_command | navigate | 794 | 20.4 | 1332 | U2 | D2 | G2 | QUALITY-RISK(err 20.4%) |
| submit_tasks | navigate | 3 | 0 | 945 | U1 | D2 | G2 | OK |
| task_complete | navigate | 3 | 0 | 788 | U1 | D2 | G2 | OK |
| todo_write | navigate | 212 | 0.5 | 2035 | U2 | D2 | G2 | OK |
| update_task | navigate | 1 | 0 | 327 | U1 | D1 | G2 | OK |
| update_todo | navigate | 512 | 0.6 | 896 | U2 | D1 | G2 | OK |
| web_fetch | navigate | 14 | 0 | 763 | U1 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| web_search | navigate | 6 | 0 | 609 | U1 | D0 | G2 | TERSE-UNSAFE(hard-cut) |
| write_file | navigate | 48 | 2.1 | 616 | U2 | D2 | G2 | OK |
| write_stdin | navigate | 20 | 0 | 660 | U2 | D2 | G2 | OK |
| preview_click | preview | 26 | 0 | 229 | U2 | D1 | G1 | OK |
| preview_close | preview | 2 | 0 | 85 | U1 | D1 | G1 | OK |
| preview_console | preview | 60 | 0 | 216 | U2 | D1 | G1 | OK |
| preview_double_click | preview | 0 | 0 | 105 | U0 | D1 | G1 | ZERO-CALL |
| preview_eval | preview | 138 | 0.7 | 234 | U2 | D1 | G1 | OK |
| preview_fill | preview | 0 | 0 | 238 | U0 | D1 | G1 | ZERO-CALL |
| preview_hover | preview | 0 | 0 | 169 | U0 | D1 | G1 | ZERO-CALL |
| preview_inspect_css | preview | 0 | 0 | 102 | U0 | D1 | G1 | ZERO-CALL |
| preview_memory | preview | 0 | 0 | 70 | U0 | D1 | G1 | ZERO-CALL |
| preview_navigate | preview | 33 | 6.1 | 84 | U2 | D1 | G1 | OK |
| preview_network | preview | 1 | 0 | 293 | U1 | D1 | G1 | OK |
| preview_open | preview | 59 | 15.3 | 711 | U2 | D0 | G1 | TERSE-UNSAFE(hard-cut) QUALITY-RISK(err 15.3%) |
| preview_performance | preview | 0 | 0 | 117 | U0 | D1 | G1 | ZERO-CALL |
| preview_press | preview | 0 | 0 | 295 | U0 | D1 | G1 | ZERO-CALL |
| preview_right_click | preview | 0 | 0 | 113 | U0 | D1 | G1 | ZERO-CALL |
| preview_screenshot | preview | 45 | 13.3 | 343 | U2 | D1 | G1 | OK |
| preview_scroll | preview | 1 | 0 | 209 | U1 | D0 | G1 | TERSE-UNSAFE(too-short) |
| preview_storage | preview | 0 | 0 | 97 | U0 | D1 | G1 | ZERO-CALL |
| preview_type | preview | 0 | 0 | 142 | U0 | D1 | G1 | ZERO-CALL |
| preview_viewport | preview | 15 | 6.7 | 423 | U1 | D1 | G1 | OK |
| preview_wait_for | preview | 34 | 0 | 183 | U2 | D0 | G1 | TERSE-UNSAFE(abbrev-cut) |

**Tools factory na telemetria** (p/ referência de utilidade): code_exec 1402 (7,7% err) · find_tools 60 · self_review 116 · spawn_agent 19 (10,5% err) · expand_toolset 15 · recall_memory 17 · remember 1 · save_note 24 · recall_investigations 14 · invoke_skill 3 · get_skills_list 9 · create_skill 2 (50% err) · ds_record_component 63 · ds_component 13 (30,8% err) · ds_publish_version 9 (55,6% err).
