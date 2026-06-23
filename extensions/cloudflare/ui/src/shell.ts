/**
 * App frame for the narrow panel: a compact header (back button, breadcrumb,
 * connection dot, settings gear) over the routed view container. The header
 * repaints on every navigation and on status refresh.
 */
import { clear, div, el, iconButton } from './core/dom.js';
import { current, getStack, onNavigate, pop, popTo, push, viewLabel } from './core/router.js';
import { connectionState, subscribeStatus } from './core/status.js';
import { t } from './core/i18n.js';

export interface Shell {
  root: HTMLElement;
  viewHost: HTMLElement;
}

export function buildShell(): Shell {
  const root = div('mcp-app');
  const header = div('mcp-hstack');
  header.style.cssText = 'padding:6px 8px;border-bottom:1px solid var(--border);flex:none;';
  const viewHost = div('mcp-stack mcp-grow mcp-scroll');
  viewHost.style.cssText = 'padding:10px;';
  root.append(header, viewHost);

  const paint = () => {
    clear(header);
    const stack = getStack();
    if (stack.length > 1) header.appendChild(iconButton('‹', t('shell.back'), pop));

    const crumbs = div('mcp-breadcrumb mcp-grow');
    stack.forEach((frame, i) => {
      const last = i === stack.length - 1;
      if (i > 0) crumbs.appendChild(el('span', 'mcp-crumb-sep', '›'));
      const crumb = el('button', `mcp-crumb${last ? ' current' : ''}`, viewLabel(frame));
      crumb.type = 'button';
      if (!last) crumb.onclick = () => popTo(i);
      crumbs.appendChild(crumb);
    });
    header.appendChild(crumbs);

    const state = connectionState();
    const dot = el('span', `mcp-dot ${state === 'connected' ? 'ok' : state === 'no-token' ? 'err' : ''}`);
    dot.title =
      state === 'connected'
        ? t('shell.connected')
        : state === 'no-token'
          ? t('shell.noToken')
          : t('shell.checking');
    header.appendChild(dot);

    if (current().view !== 'settings') {
      header.appendChild(iconButton('⚙', t('shell.settings'), () => push('settings')));
    }
  };

  onNavigate(paint);
  subscribeStatus(paint);
  paint();
  return { root, viewHost };
}
