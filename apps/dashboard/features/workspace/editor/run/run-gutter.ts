/**
 * IntelliJ-style run gutter for Monaco — a clickable ▶ in the glyph margin
 * next to each runnable line: every script in package.json/composer.json and
 * Python's `if __name__ == "__main__":`. Clicking launches the run and reveals
 * the Runners tab. Mirrors `attachConflictUI` (decorations collection + live
 * refresh on content change + a disposable).
 *
 * The glyph margin has no native per-decoration command, so clicks are caught
 * via `editor.onMouseDown` (hit-test GUTTER_GLYPH_MARGIN → line → action).
 */

import type * as MonacoNs from 'monaco-editor';
import type { FileRunTarget, RunnerManager } from '@mcp/api-bus';
import type { OpenFile } from '../../../../state/workspace.js';
import { snippetRunFor } from '@mcp/api-bus';
import { apiCall } from '../../../../lib/api-client.js';
import { launchFileRun, launchRun, launchSnippet } from '../../../../state/run-launch.js';
import {
  findCodeBlocks,
  findCsharpMainLine,
  findJavaMainLine,
  findProjectRunLine,
  findPythonMainLine,
  findScriptLines,
} from '../../../../lib/run-target.js';

interface RunCmd {
  /** Shell command (manifests/files); empty for snippets — the backend builds it. */
  command: string;
  label: string;
  manager: RunnerManager;
  /** Project-relative working dir (the manifest's folder) for nested manifests. */
  cwd?: string;
  /** A markdown code block to run (the backend materialises + executes it). */
  snippet?: { language: string; code: string };
  /** Manifest script name; resolved/quoted by the backend only when clicked. */
  manifestScript?: string;
  reason?: string;
}

type Kind =
  | 'npm-manifest'
  | 'composer-manifest'
  | 'maven-project'
  | 'gradle-project'
  | 'dotnet-project'
  | 'python'
  | 'java'
  | 'csharp'
  | 'markdown';

function kindFor(path: string): Kind | null {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base === 'package.json') return 'npm-manifest';
  if (base === 'composer.json') return 'composer-manifest';
  if (base === 'pom.xml') return 'maven-project';
  if (base === 'build.gradle' || base === 'build.gradle.kts') return 'gradle-project';
  if (base.endsWith('.csproj')) return 'dotnet-project';
  if (base.endsWith('.py')) return 'python';
  if (base.endsWith('.java')) return 'java';
  if (base.endsWith('.cs')) return 'csharp';
  if (base.endsWith('.md') || base.endsWith('.markdown')) return 'markdown';
  return null;
}

function isProjectKind(kind: Kind): boolean {
  return kind === 'maven-project' || kind === 'gradle-project' || kind === 'dotnet-project';
}

function managerForKind(kind: Kind): RunnerManager {
  if (kind === 'maven-project') return 'maven';
  if (kind === 'gradle-project') return 'gradle';
  if (kind === 'dotnet-project' || kind === 'csharp') return 'dotnet';
  if (kind === 'java') return 'java';
  if (kind === 'python') return 'python';
  if (kind === 'composer-manifest') return 'composer';
  return 'npm';
}

/** Project-relative directory of a file path ('' for a root-level file). */
function dirOf(path: string): string {
  const ix = path.lastIndexOf('/');
  return ix > 0 ? path.slice(0, ix) : '';
}

export function attachRunGutter(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  file: OpenFile,
): { dispose(): void } {
  const noop = { dispose() { /* */ } };
  const model = editor.getModel();
  const kind = kindFor(file.path);
  if (!model || !kind) return noop;

  const collection = editor.createDecorationsCollection([]);
  let lineMap = new Map<number, RunCmd>();
  let disposed = false;
  let sourceTarget: FileRunTarget | null = null;

  const build = (): void => {
    const text = model.getValue();
    const map = new Map<number, RunCmd>();
    if (kind === 'markdown') {
      // Each runnable fenced code block gets a ▶ on its opening fence line.
      for (const block of findCodeBlocks(text)) {
        const run = snippetRunFor(block.language);
        if (!run) continue;
        map.set(block.line, {
          command: '',
          label: `Run ${block.language}`,
          manager: run.manager,
          snippet: { language: block.language, code: block.code },
        });
      }
    } else if (kind === 'python') {
      const line = findPythonMainLine(text);
      if (line && sourceTarget) {
        map.set(line, {
          command: sourceTarget.command ?? '',
          label: sourceTarget.label,
          manager: sourceTarget.manager,
          cwd: sourceTarget.cwd,
          reason: sourceTarget.reason,
        });
      }
    } else if (kind === 'java' || kind === 'csharp') {
      const line = kind === 'java' ? findJavaMainLine(text) : findCsharpMainLine(text);
      if (line && sourceTarget) {
        map.set(line, {
          command: sourceTarget.command ?? '',
          label: sourceTarget.label,
          manager: sourceTarget.manager,
          cwd: sourceTarget.cwd,
          reason: sourceTarget.reason,
        });
      }
    } else if (isProjectKind(kind)) {
      const line = findProjectRunLine(text);
      if (line && sourceTarget) {
        map.set(line, {
          command: sourceTarget.command ?? '',
          label: sourceTarget.label,
          manager: sourceTarget.manager,
          cwd: sourceTarget.cwd,
          reason: sourceTarget.reason,
        });
      }
    } else {
      // Nested manifest → run in its OWN folder so `composer run` / `npm run`
      // find it (the runner defaults cwd to the project root otherwise).
      const cwd = dirOf(file.path) || undefined;
      for (const [line, name] of findScriptLines(text)) {
        map.set(line, {
          command: '',
          label: name,
          manager: kind === 'composer-manifest' ? 'composer' : 'npm',
          cwd,
          manifestScript: name,
        });
      }
    }
    lineMap = map;
    collection.set(
      [...map.entries()].map(([line, cmd]) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: cmd.reason ? 'mcp-run-glyph mcp-run-glyph-disabled' : 'mcp-run-glyph',
          glyphMarginHoverMessage: { value: cmd.reason ?? (cmd.snippet
            ? `Run \`${cmd.snippet.language}\` block`
            : cmd.manifestScript ? `Run \`${cmd.manifestScript}\`` : '`' + cmd.command + '`') },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  };

  const resolveSource = (): void => {
    void apiCall<FileRunTarget>('runner.fileRunTarget', {
      projectId: file.projectId,
      file: file.path,
      content: model.getValue(),
    }).then((target) => {
      if (disposed) return;
      sourceTarget = target;
      build();
    }).catch((err) => {
      if (disposed) return;
      sourceTarget = { label: `Run ${file.path.split('/').pop() ?? file.path}`, manager: managerForKind(kind), reason: err instanceof Error ? err.message : String(err) };
      build();
    });
  };
  if (kind === 'java' || kind === 'csharp' || kind === 'python' || isProjectKind(kind)) {
    resolveSource();
  } else {
    build();
  }

  const mouse = editor.onMouseDown((e) => {
    if (!e.event.leftButton) return; // ignore right/middle click (don't launch + don't fight the context menu)
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber;
    if (line == null) return;
    const cmd = lineMap.get(line);
    if (!cmd) return;
    if (cmd.reason || (!cmd.command && !cmd.snippet && !cmd.manifestScript)) return;
    if (cmd.snippet) {
      void launchSnippet({ projectId: file.projectId, language: cmd.snippet.language, code: cmd.snippet.code, label: cmd.label });
    } else if (cmd.manifestScript) {
      void launchFileRun({
        projectId: file.projectId,
        file: file.path,
        content: model.getValue(),
        script: cmd.manifestScript,
        label: cmd.label,
      });
    } else {
      void launchRun({ projectId: file.projectId, command: cmd.command, label: cmd.label, manager: cmd.manager, cwd: cmd.cwd });
    }
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed) return;
      if (kind === 'java' || kind === 'csharp' || kind === 'python' || isProjectKind(kind)) resolveSource();
      else build();
    }, 300);
  });

  return {
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      collection.clear();
      mouse.dispose();
      sub.dispose();
    },
  };
}
