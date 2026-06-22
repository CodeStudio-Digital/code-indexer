/** Podman panel boot: top bar (brand + liveness dot + refresh) and a
 *  master-detail shell whose icon rail drives the resource tables. */
import { clear, div, el, iconBtn, masterDetail, mcp } from '@mcp/plugin-sdk/ui';
import { RESOURCES } from './resources.js';
import { renderContent } from './views.js';
import { t } from './i18n.js';

const root = document.getElementById('root');
if (root) boot(root);

function boot(host: HTMLElement): void {
  const dot = el('span', 'mcp-dot');
  const statusText = el('span', 'mcp-muted pod-status', t('status.checking'));
  const refresh = iconBtn('refresh-cw', t('common.refresh'), () => {
    checkStatus();
    rerender();
  });
  const topbar = div('pod-topbar', el('span', 'pod-brand', 'Podman'), dot, statusText, div('mcp-grow'), refresh);

  const shellHost = div('pod-shell-host');
  host.append(topbar, shellHost);

  let active = 'containers';
  const items = () => RESOURCES.map((r) => ({ id: r.id, label: t(`${r.id}.title`), icon: r.icon, group: t(r.group) }));

  function rerender(): void {
    clear(shellHost);
    shellHost.appendChild(
      masterDetail({
        items: items(),
        active,
        onSelect: (id) => {
          active = id;
        },
        renderContent: (pane, id) => renderContent(pane, id, t),
      }),
    );
  }

  function checkStatus(): void {
    mcp.invokeTool('podman_ps', { all: true })
      .then((r) => {
        if (r.isError) throw new Error('unavailable');
        dot.className = 'mcp-dot ok';
        statusText.textContent = t('status.ready');
      })
      .catch(() => {
        dot.className = 'mcp-dot err';
        statusText.textContent = t('status.unavailable');
      });
  }

  if (!mcp || !mcp.invokeTool) {
    statusText.textContent = t('status.bridge');
    return;
  }
  checkStatus();
  rerender();
}
