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
import type { DetectedRunners, RunnerManager } from '@mcp/api-bus';
import type { OpenFile } from '../../../../state/workspace.js';
import { snippetRunFor } from '@mcp/api-bus';
import { apiCall } from '../../../../lib/api-client.js';
import { launchRun, launchSnippet } from '../../../../state/run-launch.js';
import { fileRunCommand, findCodeBlocks, findPythonMainLine, findScriptLines } from '../../../../lib/run-target.js';

interface RunCmd {
  /** Shell command (manifests/files); empty for snippets — the backend builds it. */
  command: string;
  label: string;
  manager: RunnerManager;
  /** Project-relative working dir (the manifest's folder) for nested manifests. */
  cwd?: string;
  /** A markdown code block to run (the backend materialises + executes it). */
  snippet?: { language: string; code: string };
}

type Kind = 'npm-manifest' | 'composer-manifest' | 'python' | 'markdown';

function kindFor(path: string): Kind | null {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (base === 'package.json') return 'npm-manifest';
  if (base === 'composer.json') return 'composer-manifest';
  if (base.endsWith('.py')) return 'python';
  if (base.endsWith('.md') || base.endsWith('.markdown')) return 'markdown';
  return null;
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
  // npm manager is resolved async from runner.detect; composer/python are fixed.
  let manager: RunnerManager = kind === 'composer-manifest' ? 'composer' : 'npm';
  let disposed = false;

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
      if (line) {
        const base = file.path.split('/').pop() ?? file.path;
        map.set(line, { command: fileRunCommand(file.path, 'python'), label: `Run ${base}`, manager: 'python' });
      }
    } else {
      // Nested manifest → run in its OWN folder so `composer run` / `npm run`
      // find it (the runner defaults cwd to the project root otherwise).
      const cwd = dirOf(file.path) || undefined;
      for (const [line, name] of findScriptLines(text)) {
        const command = manager === 'composer' ? `composer run ${name}` : `${manager} run ${name}`;
        map.set(line, { command, label: name, manager, cwd });
      }
    }
    lineMap = map;
    collection.set(
      [...map.entries()].map(([line, cmd]) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: 'mcp-run-glyph',
          glyphMarginHoverMessage: { value: cmd.snippet ? `Run \`${cmd.snippet.language}\` block` : '`' + cmd.command + '`' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  };

  // Resolve the JS package manager once, then paint; composer/python paint now.
  if (kind === 'npm-manifest') {
    void apiCall<DetectedRunners>('runner.detect', { projectId: file.projectId })
      .then((d) => {
        if (disposed) return;
        manager = d.groups.find((g) => g.source === 'package.json')?.manager ?? 'npm';
        build();
      })
      .catch(() => { if (!disposed) build(); });
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
    if (cmd.snippet) {
      void launchSnippet({ projectId: file.projectId, language: cmd.snippet.language, code: cmd.snippet.code, label: cmd.label });
    } else {
      void launchRun({ projectId: file.projectId, command: cmd.command, label: cmd.label, manager: cmd.manager, cwd: cmd.cwd });
    }
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (!disposed) build(); }, 300);
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
