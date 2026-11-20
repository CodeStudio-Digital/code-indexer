import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import type { ParityCase } from './compare.js';
import type { ParityRoute } from './route.js';

const t = (tool: string) => `mcp__${tool}`;
const x = (tool: string) => `mcp__parity_second__${tool}`;
const c = (id: string, tool: string, args: ParityCase['args'] = {}, extra: Partial<ParityCase> = {}): ParityCase =>
  ({ id, tool: t(tool), args, ...extra });
const marked = (path: string) => (route: ParityRoute): Partial<ToolContext> => {
  const overlay = new SessionOverlay(route.fx.root);
  overlay.mark(path);
  return { overlay };
};
const abortAfter = (ms: number) => (): Partial<ToolContext> => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('parity abort')), ms);
  return { signal: controller.signal };
};
const alreadyAborted = (): Partial<ToolContext> => {
  const controller = new AbortController();
  controller.abort(new Error('parity abort'));
  return { signal: controller.signal };
};
const offline = { before: (r: ParityRoute) => { r.fakes.offline = true; }, after: (r: ParityRoute) => { r.fakes.offline = false; } };

/** Read-only cases over one shared fixture (the main and ghost routes read the same files and database). */
export const READ_CASES: ParityCase[] = [
  c('R1', 'read_file', { file_path: 'src/target.ts' }),
  c('R2', 'read_file', { file_path: 'src/big.ts' }),
  c('R3', 'read_file', { file_path: 'src/big.ts', start_line: 850, end_line: 900 }),
  c('R4', 'read_file', { file_path: 'src/big.ts', max_lines: 5000 }),
  c('R4-max', 'read_file', { file_path: 'src/big.ts', max_lines: 5000 }, { ctx: () => ({ toolOutputCapLevel: 'max' }) }),
  c('R5', 'read_file', { file_path: 'src/target.ts', symbol: 'target' }),
  c('R6', 'read_file', { file_path: 'src/target.ts', around_line: 45 }),
  c('R7', 'read_file', { file_path: 'src/target.ts', search_term: 'PUBLIC_LIMIT' }),
  c('R8', 'read_file', { file_path: 'src/target.ts', search_term: 'nao_existe' }),
  c('R9', 'read_file', { file_path: 'src/huge.txt', byte_offset: 0, max_bytes: 65536 }),
  c('R10', 'read_file', { file_path: 'assets/blob.bin', byte_offset: 0, max_bytes: 16, encoding: 'base64' }),
  c('R11', 'read_file', { file_path: 'src/new-file.ts' }),
  c('R12', 'read_file', { file_path: '../fora.txt' }),
  c('R13', 'read_file', { file_path: 'nao-existe.ts' }),
  c('R14', 'read_file', { file_path: 'src/target.ts', symbol: 'x', byte_offset: 0 }),
  c('R15', 'read_file', { file_path: 'src/huge.txt', force: true }),
  c('G1', 'grep_code', { pattern: 'target' }),
  c('G2', 'grep_code', { pattern: 'target', literal: true, case_sensitive: true }),
  c('G3', 'grep_code', { pattern: '(sem_fechar' }),
  c('G4', 'grep_code', { pattern: 'license', literal: true }),
  c('G5', 'grep_code', { pattern: 'target', glob: 'docs/**/*.md' }),
  c('G6', 'grep_code', { pattern: 'target', language: 'typescript', max_results: 1 }),
  c('G7', 'grep_code', { pattern: 'NEW_ONLY' }),
  c('G8', 'grep_code', { pattern: 'target', glob: 'docs/**/*.md' }, { ctx: marked('src/caller.ts') }),
  c('S1', 'search', { query: 'widget shape' }),
  c('S2', 'search', { query: 'Widget', mode: 'fts' }),
  c('S3', 'search', { query: 'offline' }),
  c('S4', 'search', { query: 'zzz_nada', mode: 'fts' }),
  c('S5', 'search', { query: '' }),
  c('S6', 'search', { query: 'hang' }, { ctx: abortAfter(50) }),
  c('S7', 'search', { query: 'widget shape', type: 'symbols', limit: 1 }),
  c('S-company', 'search', { query: 'widget shape' }, { ctx: () => ({ companyContext: { companySessionId: 'c-parity' } as ToolContext['companyContext'] }) }),
  c('P1', 'prepare_edit', { symbol_name: 'target' }),
  c('P2', 'prepare_edit', { symbol_name: 'target', file_path: 'src/target.ts', max_callers: 1 }),
  c('P3', 'prepare_edit', { symbol_name: 'nao_existe' }),
  c('P4', 'prepare_edit', { symbol_name: 'target', format: 'json' }),
  c('P5', 'prepare_edit', { symbol_name: 'onlyOnDisk', file_path: 'src/new-file.ts' }),
  c('P6', 'prepare_edit', { symbol_name: 'dupe' }),
  c('K1', 'get_file_skeleton', { file_path: 'src/target.ts' }),
  c('K2', 'get_file_skeleton', { file_path: 'src/target.ts', format: 'json' }),
  c('K3', 'get_file_skeleton', { file_path: 'src/target.ts', kind: 'function' }),
  c('K4', 'get_file_skeleton', { file_path: 'src/target.ts', filter: '^tar' }),
  c('K5', 'get_file_skeleton', { file_path: 'src/new-file.ts' }),
  c('K6', 'get_file_skeleton', { file_path: 'src' }),
  c('K7', 'get_file_skeleton', { file_path: 'src/target.ts', max_symbols: 1, offset: 1 }),
  c('K8', 'get_file_skeleton', { file_path: 'src/target.ts' }, { ctx: marked('src/target.ts') }),
  c('B1', 'get_symbol_body', { symbol_name: 'target' }),
  c('B2', 'get_symbol_body', { symbol_name: 'target', file_path: 'src/target.ts', max_lines: 2 }),
  c('B3', 'get_symbol_body', { symbol_name: 'next', file_path: 'src/big.ts' }),
  c('B4', 'get_symbol_body', { symbol_name: 'nao_existe' }),
  c('B5', 'get_symbol_body', { symbol_name: 'dupe' }),
  c('B6', 'get_symbol_body', { symbol_name: 'target' }, { ctx: marked('src/target.ts') }),
  c('F1', 'find_references', { symbol_name: 'target' }),
  c('F2', 'find_references', { symbol_name: 'target', limit: 1 }),
  c('F3', 'find_references', { symbol_name: 'target', source: 'disk' }),
  c('F4', 'find_references', { symbol_name: 'target', reference_kind: 'import' }),
  c('F5', 'find_references', { symbol_name: 'target', format: 'json' }),
  c('I1', 'find_implementations', { interface_name: 'Shape' }),
  c('I2', 'find_implementations', { interface_name: 'Nada' }),
  c('H1', 'get_hierarchy', { symbol_name: 'Widget' }),
  c('H2', 'get_hierarchy', { symbol_name: 'Widget', format: 'json' }),
  c('U1', 'trace_usage', { symbol_name: 'target' }),
  c('U2', 'trace_usage', { symbol_name: 'target', depth: 5 }),
  c('N1', 'semantic_neighbors', { symbol_name: 'target' }),
  c('N2', 'semantic_neighbors', { symbol_name: 'target' }, offline),
  c('N3', 'semantic_neighbors', fx => ({ symbol_id: fx.ids.target })),
  c('D1', 'get_dependencies', { file_path: 'src/caller.ts' }),
  c('D2', 'get_dependents', { file_path: 'src/target.ts' }),
  c('D3', 'get_dependents', { file_path: 'src/target.ts', limit: 1 }),
  c('D4', 'get_dependencies', { file_path: 'nao-existe.ts' }),
  c('M1', 'get_recently_modified_files'),
  c('M2', 'get_recently_modified_files', { limit: 1, offset: 1 }),
  c('L1', 'list_directory'),
  c('L2', 'list_directory', { path: 'src', depth: 1 }),
  c('L3', 'list_directory', { path: 'src', limit: 1 }),
  c('L4', 'list_directory', { path: 'pasta-sem-indice' }),
  c('L5', 'list_directory', {}, { ctx: marked('src/new-file.ts') }),
  c('RM1', 'get_repo_map'),
  c('RM2', 'get_repo_map', { format: 'json', limit: 1 }),
  c('RM3', 'get_repo_map', { max_tokens: 200 }),
  c('O1', 'get_project_overview'),
  c('O2', 'get_project_overview', { compact: true, max_files: 1 }),
  c('PU1', 'get_project_pulse'),
  c('PU2', 'get_project_pulse', { format: 'json' }),
  c('SM1', 'search_memory', { query: 'decision' }),
  c('SM2', 'search_memory', { query: 'offline' }),
  c('SM3', 'search_memory', fx => ({ memory_id: fx.ids.memories[0] })),
  c('SM4', 'search_memory', fx => ({ memory_id: fx.ids.memories[0], content_offset: 10, content_limit: 20 })),
  c('SM5', 'search_memory'),
  c('C1', 'get_costs'),
  c('C2', 'get_costs', { since: '2026-01-01' }),
  c('LM1', 'list_models'),
  c('LM2', 'list_models', { provider: 'openai', limit: 1 }),
  c('T3', 'read_file', { file_path: 123 }),
  c('T4', 'grep_code', { pattern: 'target', max_results: '3' }),
  c('T5', 'grep_code', { pattern: 'repeat-me', max_results: 1000 }),
  { id: 'X-G1', tool: x('grep_code'), args: { pattern: 'SECOND' } },
  { id: 'X-R1', tool: x('read_file'), args: { file_path: 'lib/a.ts' } },
  { id: 'X-L1', tool: x('list_directory'), args: {} },
  { id: 'X-K1', tool: x('get_file_skeleton'), args: { file_path: 'lib/a.ts' } },
];

/** T1: one tool per family, cancelled before the call. */
const T1_TOOLS = ['read_file', 'grep_code', 'search', 'get_file_skeleton', 'get_symbol_body', 'find_references',
  'prepare_edit', 'get_repo_map', 'get_project_overview', 'search_memory', 'save_memory', 'get_costs', 'list_models'];
export const T1_CASES: ParityCase[] = T1_TOOLS.map(tool => c(`T1-${tool}`, tool, {}, { ctx: alreadyAborted }));

/** T2: a tool instance bound to a project that does not exist. */
export const T2_TOOLS = ['read_file', 'grep_code', 'search', 'get_file_skeleton', 'find_references', 'get_repo_map',
  'get_project_overview', 'get_project_pulse', 'search_memory', 'get_dependencies', 'list_directory'];
