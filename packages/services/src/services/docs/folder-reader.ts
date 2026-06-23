/**
 * folder-reader — varre recursivamente uma pasta no filesystem do
 * servidor e produz `RawPage[]` para o mesmo pipeline (chunk → enrich →
 * embed → persist) que `url` e `pdf` usam.
 *
 * Caso de uso canônico: indexar a documentação local do Unity Editor
 * (`…\Editor\Data\Documentation\en\ScriptReference\`) sem precisar
 * bater em `docs.unity3d.com`, lidar com JS-rendered sidebar, contornar
 * 429, etc. A pasta inteira é HTML estático cru — ler do disco resolve
 * em segundos o que o crawler levaria horas.
 *
 * Pipeline interno por arquivo:
 *   - `.html` / `.htm`       → `convertHtmlToMarkdown` (reuso direto)
 *   - `.md` / `.markdown`    → texto direto (já é markdown); title =
 *                              primeiro `# heading` ou nome do arquivo
 *   - `.pdf`                 → `parsePdf` (reuso direto; gera N pages)
 *   - `.txt`                 → texto puro como markdown; title = nome
 *
 * Safety guards:
 *   - Skip arquivos > 10 MB (heurística contra binários gigantes ou
 *     dumps acidentais).
 *   - Skip arquivos cujo head (1 KB) contém NUL bytes (binary
 *     heurística — evita tentar tratar `.exe` como `.txt`).
 *   - Symlinks NÃO seguidos (default do `glob`).
 *   - `node_modules`, `.git`, `dist`, `build` excluídos por padrão.
 *
 * NÃO faz watch — o operador re-indexa manualmente pelo botão
 * "Re-indexar" no SourceList. Watch via chokidar fica como follow-up.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import type { RawPage } from './types.js';
import { convertHtmlToMarkdown } from './html-to-markdown.js';
import { parsePdf } from './pdf-parser.js';

/**
 * Hard ceiling no use-case — operador customiza via UI, server clampa.
 *
 * Histórico dos valores:
 *   v1 (PR 10): default=5_000,  hard=50_000   — conservador, cobria Unity
 *               6000.3 (~5-8k) "no limite". Operador reportou que indexação
 *               parou em ~1000 arquivos (causa raiz: dev server com binário
 *               antigo cacheado pelo tsx watch); confirmou que defaults
 *               estavam sufocando frameworks médios e pediu "sem cap prático".
 *   v2 (PR 11): default=50_000, hard=500_000  — Unity sobra; .NET 8 ref
 *               (~30k) cabe; só frameworks gigantes (Boost full, full Java
 *               JDK API) precisam subir até o hard cap. Na prática, antes
 *               do hard cap o operador já bate no `HARD_MAX_CHUNKS_PER_SOURCE
 *               = 50_000` em `runIngest` — o que é OK, é uma proteção real
 *               contra explosão de custo de embedding e fica visível em
 *               warning. Filesize cap (10 MB) + binary-sniff continuam
 *               protegendo o cenário "operador apontou pra /usr".
 */
export const FOLDER_HARD_MAX_FILES = 500_000;
export const FOLDER_DEFAULT_MAX_FILES = 50_000;
/** Limite por arquivo lido. Binários grandes (PDFs de manuais inteiros)
 *  costumam estourar isso — tratar como skip + log antes de cair em OOM. */
export const FOLDER_FILE_SIZE_CAP_BYTES = 10 * 1024 * 1024;
/** Quantos bytes do head usados pra heurística "isBinary". */
const BINARY_SNIFF_BYTES = 1024;

export const FOLDER_DEFAULT_INCLUDE_GLOB =
  '**/*.{html,htm,md,markdown,pdf,txt}';
/** Diretórios que tipicamente NÃO contêm docs reais — economizar a
 *  iteração inteira sobre eles é uma vitória grande em monorepos. */
export const FOLDER_DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,.next,target,vendor,.cache}/**';

/**
 * Per-file callback. `index`/`total` são pra renderizar o progress
 * bar do dashboard (SSE event `progress`). `kind` distingue arquivo
 * processado vs. pulado vs. erro pra eventual telemetria.
 *
 * `scan` é emitido UMA vez, logo após o `glob` retornar e antes do
 * loop processar qualquer arquivo. Permite a UI mostrar "Encontrados N
 * arquivos · vou processar M (cap K)" como pré-flight sem esperar o
 * primeiro `file` (que pode demorar segundos em pastas grandes).
 */
export type FolderReaderEvent =
  | { kind: 'scan'; totalMatches: number; willProcess: number; cap: number }
  | { kind: 'file'; filePath: string; index: number; total: number; bytes: number; pages: number }
  | { kind: 'skip'; filePath: string; reason: string }
  | { kind: 'error'; filePath: string; message: string };

export interface ReadFolderOptions {
  /** Caminho ABSOLUTO da raiz. Validação do path é feita pelo route. */
  rootPath: string;
  /** Glob de inclusão. Default `FOLDER_DEFAULT_INCLUDE_GLOB`. */
  includeGlob?: string | null;
  /** Glob de exclusão. Default `FOLDER_DEFAULT_EXCLUDE_GLOB`. */
  excludeGlob?: string | null;
  /** Cap de arquivos processados (clamped a `FOLDER_HARD_MAX_FILES`). */
  maxFiles?: number | null;
  /**
   * source_id usado pra montar `candidateId`/`uri` no formato
   * `folder://<sourceId>#file=<relPath>`. Espelha o que `parsePdf`
   * faz com `pdf://<sourceId>#page=<N>`.
   */
  sourceId: number;
  /** Callback per-file pra progresso (SSE / logs). Opcional. */
  onEvent?: (event: FolderReaderEvent) => void;
  /** Aborta entre arquivos (não interrompe leitura em andamento). */
  signal?: AbortSignal;
}

export interface ReadFolderResult {
  pages: RawPage[];
  filesScanned: number;
  filesProcessed: number;
  filesSkipped: number;
  filesErrored: number;
}

export async function readFolder(opts: ReadFolderOptions): Promise<ReadFolderResult> {
  const rootPath = opts.rootPath;
  const includePattern = (opts.includeGlob ?? FOLDER_DEFAULT_INCLUDE_GLOB).trim() ||
    FOLDER_DEFAULT_INCLUDE_GLOB;
  const excludePattern = (opts.excludeGlob ?? FOLDER_DEFAULT_EXCLUDE_GLOB).trim() ||
    FOLDER_DEFAULT_EXCLUDE_GLOB;
  const maxFiles = clamp(
    opts.maxFiles ?? FOLDER_DEFAULT_MAX_FILES,
    1,
    FOLDER_HARD_MAX_FILES,
  );

  // Diagnostic log ANTES do glob — quando uma indexação misteriosamente
  // "parou em N", o primeiro passo é olhar o log e confirmar qual cap
  // está em vigor. Distingue 3 fontes: o valor que o caller pediu, o
  // default da função, e o hard cap. Sem esse log a investigação de
  // "indexou só 1000" exige adivinhar entre essas três fontes (foi o
  // que aconteceu no incidente que motivou o PR 11).
  console.log(
    `[doc-indexer] folder reading rootPath=${rootPath} ` +
      `include=${includePattern} exclude=${excludePattern} ` +
      `cap_effective=${maxFiles} ` +
      `(request=${opts.maxFiles ?? 'unset'}, default=${FOLDER_DEFAULT_MAX_FILES}, hard=${FOLDER_HARD_MAX_FILES})`,
  );

  // glob v11 resolve em uma única passada. `absolute: true` retorna
  // paths absolutos; `nodir: true` filtra entradas que são diretórios;
  // `dot: false` ignora dotfiles (`.git/`, `.ds_store`); `follow: false`
  // evita ciclos por symlink (default já é false mas explicito = melhor).
  const matches = await glob(includePattern, {
    cwd: rootPath,
    absolute: true,
    nodir: true,
    dot: false,
    follow: false,
    ignore: [excludePattern],
  });

  const filesScanned = matches.length;
  // Trunca ao cap. O sort dá determinismo entre runs (importante pra
  // testes + pra "re-indexar" produzir mesmo conjunto).
  const ordered = matches.slice().sort().slice(0, maxFiles);

  // Pre-flight `scan` event — UMA emissão, antes de qualquer trabalho
  // per-file. UI mostra "Encontrados N arquivos · vou processar M (cap
  // K)" sem esperar o primeiro `file` event. Quando totalMatches >
  // willProcess o operador sabe imediatamente que bateu no cap e pode
  // subir o valor em "Avançado".
  opts.onEvent?.({
    kind: 'scan',
    totalMatches: filesScanned,
    willProcess: ordered.length,
    cap: maxFiles,
  });

  const pages: RawPage[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;
  let filesErrored = 0;

  for (let i = 0; i < ordered.length; i++) {
    if (opts.signal?.aborted) break;
    const absPath = ordered[i]!;
    const relPath = path.relative(rootPath, absPath);
    try {
      const filePages = await readSingleFile({
        absPath,
        relPath,
        rootPath,
        sourceId: opts.sourceId,
      });
      if (filePages === 'skipped-binary') {
        filesSkipped++;
        opts.onEvent?.({ kind: 'skip', filePath: relPath, reason: 'binary or NUL bytes' });
        continue;
      }
      if (filePages === 'skipped-too-large') {
        filesSkipped++;
        opts.onEvent?.({
          kind: 'skip',
          filePath: relPath,
          reason: `> ${FOLDER_FILE_SIZE_CAP_BYTES / 1024 / 1024} MB`,
        });
        continue;
      }
      if (filePages === 'skipped-unknown-ext') {
        filesSkipped++;
        opts.onEvent?.({ kind: 'skip', filePath: relPath, reason: 'unknown extension' });
        continue;
      }
      pages.push(...filePages);
      filesProcessed++;
      const totalBytes = filePages.reduce((acc, p) => acc + (p.bytes ?? 0), 0);
      opts.onEvent?.({
        kind: 'file',
        filePath: relPath,
        index: i + 1,
        total: ordered.length,
        bytes: totalBytes,
        pages: filePages.length,
      });
    } catch (err) {
      filesErrored++;
      const message = err instanceof Error ? err.message : String(err);
      opts.onEvent?.({ kind: 'error', filePath: relPath, message });
      // Best-effort: arquivo problemático não derruba o source inteiro.
      // O contador `filesErrored` vira diagnóstico no final.
    }
  }

  return {
    pages,
    filesScanned,
    filesProcessed,
    filesSkipped,
    filesErrored,
  };
}

// ─── Per-file dispatch ───────────────────────────────────────────────

interface ReadSingleFileInput {
  absPath: string;
  relPath: string;
  rootPath: string;
  sourceId: number;
}

type ReadFileResult =
  | RawPage[]
  | 'skipped-binary'
  | 'skipped-too-large'
  | 'skipped-unknown-ext';

async function readSingleFile(input: ReadSingleFileInput): Promise<ReadFileResult> {
  const ext = path.extname(input.absPath).toLowerCase();
  const stat = await fs.stat(input.absPath);
  if (stat.size > FOLDER_FILE_SIZE_CAP_BYTES) return 'skipped-too-large';

  switch (ext) {
    case '.html':
    case '.htm':
      return readHtmlFile(input, stat.size);
    case '.md':
    case '.markdown':
      return readMarkdownFile(input, stat.size);
    case '.pdf':
      return readPdfFile(input, stat.size);
    case '.txt':
      return readTextFile(input, stat.size);
    default:
      // Glob default já filtra por extensão; arquivos que escapam têm
      // ext fora do nosso set conhecido. Skipar é mais seguro que tentar
      // adivinhar — operador adiciona a extensão no glob se quiser.
      return 'skipped-unknown-ext';
  }
}

async function readHtmlFile(input: ReadSingleFileInput, size: number): Promise<ReadFileResult> {
  const html = await fs.readFile(input.absPath, 'utf-8');
  if (looksBinary(html)) return 'skipped-binary';
  // `baseUrl` = file:// — o convertHtmlToMarkdown precisa de algo
  // parseável pra `new URL()`; ignoramos os `links` extraídos (não há
  // BFS no path folder).
  const converted = convertHtmlToMarkdown(html, {
    baseUrl: pathToFileURL(input.absPath).toString(),
    sameOriginOnly: false,
  });
  if (converted.noindex) return 'skipped-binary'; // reusa o bucket "skip"; raro.
  return [
    {
      candidateId: folderCandidateId(input.sourceId, input.relPath),
      uri: folderUri(input.sourceId, input.relPath),
      title: converted.title ?? prettifyName(input.relPath),
      markdown: converted.markdown,
      source: 'folder',
      bytes: size,
    },
  ];
}

async function readMarkdownFile(input: ReadSingleFileInput, size: number): Promise<ReadFileResult> {
  const md = await fs.readFile(input.absPath, 'utf-8');
  if (looksBinary(md)) return 'skipped-binary';
  const title = firstMarkdownHeading(md) ?? prettifyName(input.relPath);
  return [
    {
      candidateId: folderCandidateId(input.sourceId, input.relPath),
      uri: folderUri(input.sourceId, input.relPath),
      title,
      markdown: md,
      source: 'folder',
      bytes: size,
    },
  ];
}

async function readPdfFile(input: ReadSingleFileInput, size: number): Promise<ReadFileResult> {
  const bytes = await fs.readFile(input.absPath);
  const sourceUri = folderUri(input.sourceId, input.relPath);
  // Reuso direto: parsePdf retorna N RawPages com source='pdf'. Aqui
  // preciso reescrever pra source='folder' (manter provenance honesta —
  // a row no doc_sources é tipo 'folder', não 'pdf').
  const pdfPages = await parsePdf(new Uint8Array(bytes), {
    sourceId: input.sourceId,
    sourceUri,
    titleHint: prettifyName(input.relPath),
  });
  const totalSize = size;
  // Distribui o size aproximado entre as pages do PDF — não exato mas
  // suficiente pra heurísticas de gating downstream.
  const perPage = pdfPages.length > 0 ? Math.floor(totalSize / pdfPages.length) : 0;
  return pdfPages.map((p) => ({
    ...p,
    source: 'folder' as const,
    bytes: perPage,
  }));
}

async function readTextFile(input: ReadSingleFileInput, size: number): Promise<ReadFileResult> {
  const text = await fs.readFile(input.absPath, 'utf-8');
  if (looksBinary(text)) return 'skipped-binary';
  return [
    {
      candidateId: folderCandidateId(input.sourceId, input.relPath),
      uri: folderUri(input.sourceId, input.relPath),
      title: prettifyName(input.relPath),
      markdown: text,
      source: 'folder',
      bytes: size,
    },
  ];
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Heurística cheap: se nos primeiros 1 KB tem byte NUL (`\0`), é
 * binário. Files-texto reais nunca têm NUL no head. Cobre o 95%+ dos
 * casos onde o user marcou um glob amplo demais e pegou um .so/.dll.
 */
function looksBinary(content: string): boolean {
  const head = content.length > BINARY_SNIFF_BYTES
    ? content.slice(0, BINARY_SNIFF_BYTES)
    : content;
  return head.includes('\0');
}

/**
 * Extrai o primeiro `# Heading` do markdown como title. Fallback pro
 * nome do arquivo quando não há heading.
 */
function firstMarkdownHeading(md: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(md);
  return match ? match[1]!.trim() : null;
}

/**
 * Nome bonito a partir do path: `Camera.html` → `Camera`,
 * `Manual/Physics.md` → `Physics`. Usado como title-fallback.
 */
function prettifyName(relPath: string): string {
  const base = path.basename(relPath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * URI consistente com o pattern do PDF (`pdf://<sourceId>#page=<N>`).
 * Para folder usamos `folder://<sourceId>#file=<relPath>`. relPath é
 * normalized pra forward-slashes (Windows produz `\` mas a UI espera `/`).
 */
function folderUri(sourceId: number, relPath: string): string {
  return `folder://${sourceId}#file=${relPath.split(path.sep).join('/')}`;
}

function folderCandidateId(sourceId: number, relPath: string): string {
  return folderUri(sourceId, relPath);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
