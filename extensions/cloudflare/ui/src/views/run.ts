/**
 * "Run" view: streams a sequence of `npx <args…>` steps (build/deploy/
 * preview) into a full-height log with a Stop button. Narrow-first
 * replacement for the old streamDeploy modal.
 *
 * Streams cannot survive an iframe remount, and a restored stack must NOT
 * re-execute a deploy by itself — so auto-start is armed only by pushRun()
 * (an in-memory flag). A restored frame renders the log idle with a
 * "run again" button instead.
 */
import { button, div, el } from '../core/dom.js';
import { confirmDanger } from '../core/api.js';
import { push, registerView } from '../core/router.js';
import { streamLog } from '../core/widgets.js';
import { t } from '../core/i18n.js';

let armed = false;

/** Confirm, then open the run view auto-started with the given steps. */
export async function pushRun(title: string, steps: string[][]): Promise<void> {
  const plan = steps.map((s) => `npx ${s.join(' ')}`).join('\n');
  if (!(await confirmDanger(title, plan))) return;
  armed = true;
  push('run', { title, steps: JSON.stringify(steps) });
}

function parseSteps(raw: string): string[][] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((s) => Array.isArray(s))) {
      return (parsed as string[][]).map((s) => s.map(String));
    }
  } catch {
    /* corrupted persisted params — treat as no steps */
  }
  return [];
}

export function registerRunView(): void {
  registerView({
    id: 'run',
    label: (params) => params.title || t('run.title'),
    render(host, params) {
      const steps = parseSteps(params.steps ?? '[]');
      const bar = div('mcp-toolbar');
      let queue: string[][] = [];

      // On each stream end: run the queued next step, else flip the toolbar.
      const log = streamLog(() => {
        if (!log.running() && queue.length) {
          const step = queue.shift();
          if (step) log.start('npx', step);
          return;
        }
        paintBar();
      });
      log.node.classList.add('mcp-grow');

      const startAll = () => {
        log.node.textContent = '';
        queue = steps.slice(1);
        if (steps[0]) log.start('npx', steps[0]);
      };
      const paintBar = () => {
        bar.textContent = '';
        if (log.running()) {
          bar.appendChild(
            button(t('run.stop'), 'danger sm', () => {
              queue = [];
              log.stop();
            }),
          );
        } else if (steps.length) {
          bar.appendChild(button(t('run.again'), 'primary sm', startAll));
        }
      };

      host.append(el('div', 'mcp-section-title', params.title || t('run.title')), bar, log.node);
      if (armed && steps.length) {
        armed = false;
        startAll();
      } else {
        log.append(`${t('run.idle')}\n`);
      }
      paintBar();
      return () => {
        queue = [];
        log.stop();
      };
    },
  });
}
