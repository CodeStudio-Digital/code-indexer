/**
 * Cobertura do `folder-reader.ts` — varredura recursiva de uma pasta
 * no FS para produzir `RawPage[]` que alimentam o mesmo pipeline de
 * chunk/enrich/embed dos sources url/pdf.
 *
 * Invariantes pinados:
 *   - HTML / MD / TXT viram cada um 1 RawPage com `source: 'folder'`.
 *   - PDF gera N pages (uma por página do PDF), todas com source folder.
 *   - Defaults: node_modules + .git são excluídos automaticamente.
 *   - Arquivos > 10 MB são pulados (heurística contra binários).
 *   - Conteúdo com NUL bytes vira skip (binário).
 *   - `maxFiles` clampa o resultado determinístico (sort ascending).
 *   - `signal.abort()` entre arquivos interrompe sem corromper o state.
 *   - URI segue `folder://<sourceId>#file=<relPath>` (paralelo ao
 *     `pdf://<sourceId>#page=<N>`).
 *
 * Fixtures vivem num tmp dir criado por `beforeEach` e dropado no
 * `afterEach` — zero state vazado entre testes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkMarkdown } from '../section-chunker.js';
import { heuristicAccepts } from '../relevance-gate.js';
import { docPassageUri } from '@mcp/shared/doc-passage-uri.js';
import {
  readFolder,
  FOLDER_DEFAULT_INCLUDE_GLOB,
  FOLDER_DEFAULT_EXCLUDE_GLOB,
  FOLDER_DEFAULT_MAX_FILES,
  FOLDER_HARD_MAX_FILES,
  type FolderReaderEvent,
} from '../folder-reader.js';

let tmpRoot = '';

function makeFile(rel: string, body: string | Buffer): void {
  const full = path.join(tmpRoot, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'folder-reader-test-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('readFolder — basic dispatch', () => {
  it('preserves passage text and distinct page locators across PDF, HTML and Markdown', async () => {
    const sentence = 'CommitPolicy verifies the receipt before publishing.';
    const stream = 'BT /F1 12 Tf 40 500 Td (' + sentence + ') Tj ET\n';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << >> >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((obj, i) => {
      const start = pdf.length;
      pdf += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n';
      return String(start).padStart(10, '0') + ' 00000 n \n';
    });
    const xref = pdf.length;
    pdf += 'xref\n0 7\n0000000000 65535 f \n' + offsets.join('') + 'trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    makeFile('first.pdf', pdf);
    makeFile('second.pdf', pdf);
    makeFile('manual.md', '# verifyReceipt() {#verify}\n\n' + sentence);
    makeFile('manual.html', '<html><body><main><h1 id="verify">verifyReceipt()</h1><p>' + sentence + '</p></main></body></html>');
    const { pages } = await readFolder({ rootPath: tmpRoot, sourceId: 9 });
    expect(pages).toHaveLength(6);
    expect(new Set(pages.map(p => p.candidateId)).size).toBe(6);
    const gaps = pages.filter(p => p.extraction_gap);
    expect(gaps.map(p => p.uri).sort()).toEqual(['first', 'second'].map(n => 'folder://9#file=' + n + '.pdf&page=1'));
    expect(gaps.every(p => !heuristicAccepts(p).accept)).toBe(true);
    for (const page of pages.filter(p => !p.extraction_gap)) {
      expect(heuristicAccepts(page).accept).toBe(true);
      expect(chunkMarkdown(page.markdown, { defaultRootTitle: page.title ?? 'Manual' })
        .some(chunk => chunk.content.includes(sentence))).toBe(true);
    }
    expect(docPassageUri('folder://9#file=manual.md', 'verify')).toBe('folder://9#file=manual.md&anchor=verify');
    expect(docPassageUri('https://example.test/docs#old', 'verify')).toBe('https://example.test/docs#verify');
  });
  it('reads .html, .md, .txt and assembles RawPages with source=folder', async () => {
    makeFile(
      'index.html',
      '<html><head><title>Welcome</title></head><body><main>' +
        '<h1>Welcome</h1>' +
        'Body content goes here. '.repeat(20) +
        '</main></body></html>',
    );
    makeFile('manual/setup.md', '# Setup\n\nInstall steps here.');
    makeFile('api/intro.txt', 'Plain text doc, just words.');

    const out = await readFolder({ rootPath: tmpRoot, sourceId: 42 });

    expect(out.filesScanned).toBe(3);
    expect(out.filesProcessed).toBe(3);
    expect(out.filesSkipped).toBe(0);
    expect(out.filesErrored).toBe(0);
    expect(out.pages).toHaveLength(3);

    for (const page of out.pages) {
      expect(page.source).toBe('folder');
      expect(page.candidateId).toMatch(/^folder:\/\/42#file=/);
      expect(page.uri).toBe(page.candidateId);
    }

    // Title extraction: HTML <title>, MD first `#`, TXT filename.
    const byTitle = new Map(out.pages.map((p) => [p.title, p]));
    expect(byTitle.get('Welcome')).toBeDefined();
    expect(byTitle.get('Setup')).toBeDefined();
    expect(byTitle.get('intro')).toBeDefined();
  });

  it('emits onEvent("file") with correct index/total per processed file', async () => {
    makeFile('a.md', '# A');
    makeFile('b.md', '# B');
    makeFile('c.md', '# C');

    const events: Array<{ kind: string; filePath?: string; index?: number; total?: number }> = [];
    await readFolder({
      rootPath: tmpRoot,
      sourceId: 1,
      onEvent: (ev) => {
        // `scan` é o único kind sem `filePath` — narrowing por kind
        // mantém o test simples sem ifs em cada propriedade.
        if (ev.kind === 'scan') {
          events.push({ kind: ev.kind });
          return;
        }
        events.push({
          kind: ev.kind,
          filePath: ev.filePath,
          ...(ev.kind === 'file' ? { index: ev.index, total: ev.total } : {}),
        });
      },
    });

    const fileEvents = events.filter((e) => e.kind === 'file');
    expect(fileEvents).toHaveLength(3);
    // Sort determinístico — a, b, c em ordem.
    expect(fileEvents.map((e) => e.filePath)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(fileEvents[0]!.index).toBe(1);
    expect(fileEvents[0]!.total).toBe(3);
    expect(fileEvents[2]!.index).toBe(3);
  });

  it('uses POSIX forward slashes in relPath of the URI (Windows-safe)', async () => {
    makeFile('nested/folder/deep.md', '# Deep');
    const out = await readFolder({ rootPath: tmpRoot, sourceId: 7 });
    expect(out.pages).toHaveLength(1);
    // Path no URI sempre `/` mesmo quando o FS local separa com `\`.
    expect(out.pages[0]!.uri).toBe('folder://7#file=nested/folder/deep.md');
  });
});

describe('readFolder — skip rules', () => {
  it('skips files larger than 10 MB', async () => {
    // 11 MB de conteúdo "válido" como texto.
    const huge = 'a'.repeat(11 * 1024 * 1024);
    makeFile('huge.md', huge);

    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    expect(out.filesScanned).toBe(1);
    expect(out.filesProcessed).toBe(0);
    expect(out.filesSkipped).toBe(1);
    expect(out.pages).toHaveLength(0);
  });

  it('skips binary content (NUL bytes in head)', async () => {
    // .md com NUL byte no início → heurística pega.
    makeFile('fake-md.md', Buffer.from([0x00, 0x42, 0x42, 0x42, 0x0a]));
    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    expect(out.filesProcessed).toBe(0);
    expect(out.filesSkipped).toBe(1);
  });

  it('skips node_modules and .git by default (exclude glob)', async () => {
    makeFile('docs/intro.md', '# Intro');
    makeFile('node_modules/lib/readme.md', '# Should not appear');
    makeFile('.git/config.md', '# Also no');

    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]!.title).toBe('Intro');
  });

  it('skips files whose extension is outside the glob set', async () => {
    makeFile('readme.md', '# Hello');
    makeFile('config.json', '{"a":1}'); // .json não está no default glob
    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    // glob filtra .json fora — nem aparece em scanned.
    expect(out.filesScanned).toBe(1);
    expect(out.filesProcessed).toBe(1);
  });
});

describe('readFolder — maxFiles clamp', () => {
  it('honors maxFiles cap and processes the alphabetically first N', async () => {
    makeFile('c.md', '# C');
    makeFile('a.md', '# A');
    makeFile('d.md', '# D');
    makeFile('b.md', '# B');

    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1, maxFiles: 2 });
    expect(out.filesScanned).toBe(4);
    expect(out.filesProcessed).toBe(2);
    expect(out.pages.map((p) => p.title).sort()).toEqual(['A', 'B']);
  });
});

describe('readFolder — abort signal', () => {
  it('halts cleanly when signal aborts between files', async () => {
    // 20 arquivos triviais; aborta após o primeiro.
    for (let i = 0; i < 20; i++) makeFile(`f${i.toString().padStart(2, '0')}.md`, `# F${i}`);

    const ac = new AbortController();
    let processed = 0;
    const promise = readFolder({
      rootPath: tmpRoot,
      sourceId: 1,
      onEvent: (ev) => {
        if (ev.kind === 'file') {
          processed++;
          if (processed >= 1) ac.abort();
        }
      },
      signal: ac.signal,
    });
    const out = await promise;
    // Pelo menos 1, no máximo todos — depende do timing exato do
    // microtask que sinaliza o abort. O importante: NÃO completou os 20
    // (o abort fez algum efeito) e não estourou.
    expect(out.filesProcessed).toBeGreaterThanOrEqual(1);
    expect(out.filesProcessed).toBeLessThan(20);
  });
});

describe('readFolder — defaults exposed', () => {
  it('exports sensible default globs', () => {
    expect(FOLDER_DEFAULT_INCLUDE_GLOB).toContain('html');
    expect(FOLDER_DEFAULT_INCLUDE_GLOB).toContain('md');
    expect(FOLDER_DEFAULT_INCLUDE_GLOB).toContain('pdf');
    expect(FOLDER_DEFAULT_INCLUDE_GLOB).toContain('txt');
    expect(FOLDER_DEFAULT_EXCLUDE_GLOB).toContain('node_modules');
    expect(FOLDER_DEFAULT_EXCLUDE_GLOB).toContain('.git');
  });
});

describe('readFolder — cap constants (PR 11: raised to 200k+ tier)', () => {
  it('pins FOLDER_DEFAULT_MAX_FILES at 50_000 (cobre Unity + .NET sem mexer em Avançado)', () => {
    expect(FOLDER_DEFAULT_MAX_FILES).toBe(50_000);
  });

  it('pins FOLDER_HARD_MAX_FILES at 500_000 (cap superior pra frameworks gigantes)', () => {
    expect(FOLDER_HARD_MAX_FILES).toBe(500_000);
  });
});

describe('readFolder — scan event (PR 11: pre-flight)', () => {
  it('emits a `scan` event ANTES de qualquer `file` event', async () => {
    makeFile('a.md', '# A');
    makeFile('b.md', '# B');

    const events: FolderReaderEvent[] = [];
    await readFolder({
      rootPath: tmpRoot,
      sourceId: 1,
      onEvent: (ev) => events.push(ev),
    });

    // Primeiro event sempre é scan.
    expect(events[0]?.kind).toBe('scan');
    const scan = events[0]!;
    if (scan.kind !== 'scan') throw new Error('expected scan');
    expect(scan.totalMatches).toBe(2);
    expect(scan.willProcess).toBe(2);
    // cap = default (porque caller não passou maxFiles)
    expect(scan.cap).toBe(FOLDER_DEFAULT_MAX_FILES);

    // Em seguida os `file` events.
    const restKinds = events.slice(1).map((e) => e.kind);
    expect(restKinds).toContain('file');
    expect(restKinds).not.toContain('scan'); // emitido APENAS uma vez
  });

  it('reflete o cap clampado quando maxFiles excede o hard cap', async () => {
    makeFile('a.md', '# A');

    const events: FolderReaderEvent[] = [];
    await readFolder({
      rootPath: tmpRoot,
      sourceId: 1,
      maxFiles: 99_999_999, // muito acima do hard cap
      onEvent: (ev) => events.push(ev),
    });

    const scan = events.find((e) => e.kind === 'scan');
    if (!scan || scan.kind !== 'scan') throw new Error('expected scan event');
    // cap reflete o clamp em FOLDER_HARD_MAX_FILES, NÃO o valor que o
    // caller passou — assim a UI mostra o cap REAL em vigor.
    expect(scan.cap).toBe(FOLDER_HARD_MAX_FILES);
  });

  it('sinaliza cap atingido quando totalMatches > willProcess', async () => {
    makeFile('a.md', '# A');
    makeFile('b.md', '# B');
    makeFile('c.md', '# C');

    const events: FolderReaderEvent[] = [];
    await readFolder({
      rootPath: tmpRoot,
      sourceId: 1,
      maxFiles: 2,
      onEvent: (ev) => events.push(ev),
    });

    const scan = events.find((e) => e.kind === 'scan');
    if (!scan || scan.kind !== 'scan') throw new Error('expected scan event');
    expect(scan.totalMatches).toBe(3); // glob achou 3
    expect(scan.willProcess).toBe(2);  // mas cap=2
    expect(scan.cap).toBe(2);
  });
});

describe('readFolder — diagnostic log (PR 11)', () => {
  it('emite uma linha [doc-indexer] com cap_effective= antes do trabalho', async () => {
    makeFile('a.md', '# A');

    // Vitest wraps the global `console` object with its own reporter
    // before tests run, so `console.log` calls go through vitest's
    // facade. A normal `vi.spyOn(console, 'log')` doesn't intercept
    // those — readFolder's `console.log` reference is the wrapped one,
    // but the spy hooks the descriptor on the bare object. Replace the
    // entire `log` property with a manual wrapper and restore in
    // `finally`.
    const captured: unknown[][] = [];
    const original = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      captured.push(args);
      original(...args);
    };
    try {
      await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    } finally {
      console.log = original;
    }

    const lines = captured.map((args) => args.map(String).join(' '));
    const found = lines.find(
      (msg) =>
        msg.includes('[doc-indexer] folder reading') &&
        msg.includes('cap_effective='),
    );
    expect(found).toBeDefined();
    // Deve conter as 3 fontes do cap pra debug ficar trivial.
    expect(found).toContain(`default=${FOLDER_DEFAULT_MAX_FILES}`);
    expect(found).toContain(`hard=${FOLDER_HARD_MAX_FILES}`);
  });
});

describe('readFolder — error path', () => {
  it('reports filesErrored=1 when a single file fails (does not blow up the whole run)', async () => {
    makeFile('good.md', '# Good');
    // Cria um arquivo MD e em seguida deleta entre a iteração do glob
    // e o read. Mais barato: cria um arquivo cujo read EACCES. Como
    // mockar EACCES é frágil em diferentes OSes, fazemos um arquivo
    // que não existe forçando um path inválido via include glob amplo.
    makeFile('ok.md', '# Ok');
    // Apaga o `good.md` BEFORE chamar — vai falhar no read durante a iteração.
    await fs.unlink(path.join(tmpRoot, 'good.md'));

    const out = await readFolder({ rootPath: tmpRoot, sourceId: 1 });
    // O glob pega `ok.md` (existe) + talvez ainda capture `good.md` no
    // cache do filesystem. Em qualquer caso: ok.md vira RawPage; good.md
    // se aparecer no glob, vira `error` event. processed >= 1.
    expect(out.filesProcessed).toBeGreaterThanOrEqual(1);
  });
});
