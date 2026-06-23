/**
 * Wrangler logs: login + live tail through the plugin exec bridge. Streams
 * die with the iframe (panel switch / locale change) — the view restores
 * idle with a hint instead of pretending the tail survived.
 */
import { button, div, el } from '../core/dom.js';
import { registerView } from '../core/router.js';
import { streamLog } from '../core/widgets.js';
import { t } from '../core/i18n.js';

export function registerLogsView(): void {
  registerView({
    id: 'logs',
    label: () => t('logs.title'),
    render(host) {
      const bar = div('mcp-toolbar');
      const log = streamLog(() => paint());
      log.node.classList.add('mcp-grow');

      const paint = () => {
        bar.textContent = '';
        bar.append(
          button(t('logs.tail'), 'primary sm', () =>
            log.start('npx', ['wrangler', 'tail', '--format', 'pretty']),
          ),
          button(t('logs.login'), 'sm', () => log.start('npx', ['wrangler', 'login'])),
        );
        if (log.running()) bar.appendChild(button(t('logs.stop'), 'danger sm', () => log.stop()));
      };

      host.append(
        el('p', 'mcp-card-sub', t('logs.sub')),
        bar,
        log.node,
      );
      log.append(`${t('logs.ready')}\n`);
      paint();
      return () => log.stop();
    },
  });
}
