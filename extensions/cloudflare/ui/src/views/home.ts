/**
 * Home: connection card (token/account), project card (cf_detect-driven
 * deploy/build/preview/tail actions) and the domain grid. Account-level
 * domains stay available even when the open project isn't a Cloudflare app —
 * that's why this panel surfaces everywhere (no activation rule).
 */
import { button, clear, div, el, select } from '../core/dom.js';
import { mutate } from '../core/api.js';
import { push, registerView } from '../core/router.js';
import { fetchAccounts, fetchDetect } from '../core/status.js';
import { invalidateRows } from '../core/state.js';
import { loadingBox } from '../core/widgets.js';
import { pushRun } from './run.js';
import { t } from '../core/i18n.js';

interface DomainEntry {
  labelKey: string;
  metaKey: string;
  go(): void;
}

const DOMAINS: DomainEntry[] = [
  { labelKey: 'd1.title', metaKey: 'd1.sub', go: () => push('d1') },
  { labelKey: 'kv.title', metaKey: 'kv.sub', go: () => push('kv') },
  { labelKey: 'r2.title', metaKey: 'r2.sub', go: () => push('r2') },
  { labelKey: 'dns.title', metaKey: 'dns.sub', go: () => push('dns') },
  { labelKey: 'domain.queues', metaKey: 'domain.queuesSub', go: () => push('generic', { domain: 'queues' }) },
  { labelKey: 'domain.workers', metaKey: 'domain.workersSub', go: () => push('generic', { domain: 'workers' }) },
  { labelKey: 'domain.pages', metaKey: 'domain.pagesSub', go: () => push('generic', { domain: 'pages' }) },
  { labelKey: 'domain.vectorize', metaKey: 'domain.vectorizeSub', go: () => push('generic', { domain: 'vectorize' }) },
  { labelKey: 'domain.do', metaKey: 'domain.doSub', go: () => push('generic', { domain: 'do' }) },
  { labelKey: 'domain.hyperdrive', metaKey: 'domain.hyperdriveSub', go: () => push('generic', { domain: 'hyperdrive' }) },
  { labelKey: 'domain.ai', metaKey: 'domain.aiSub', go: () => push('generic', { domain: 'ai' }) },
  { labelKey: 'logs.title', metaKey: 'logs.sub', go: () => push('logs') },
  { labelKey: 'assistant.title', metaKey: 'assistant.sub', go: () => push('assistant') },
];

function connectionCard(): HTMLElement {
  const card = div('mcp-card mcp-stack');
  const paint = async (force: boolean) => {
    clear(card);
    card.append(
      el('div', 'mcp-card-title', t('home.connection')),
      loadingBox(t('shell.checking')),
    );
    const info = await fetchAccounts(force);
    clear(card);
    card.appendChild(el('div', 'mcp-card-title', t('home.connection')));
    if (!info) {
      card.append(
        el('p', 'mcp-card-sub', t('home.noTokenHint')),
        button(t('home.configureToken'), 'primary sm', () => push('settings')),
      );
      return;
    }
    const sel = select(
      info.rows.map((a) => ({ value: a.id, label: a.name, selected: a.selected })),
    );
    sel.onchange = async () => {
      const r = await mutate('cf_set_account', { accountId: sel.value });
      if (r) {
        invalidateRows();
        void paint(true);
      }
    };
    const row = div('mcp-hstack');
    sel.classList.add('mcp-grow');
    row.append(sel, button('⟳', 'sm', () => void paint(true)));
    card.append(el('p', 'mcp-card-sub', t('home.accountHint')), row);
  };
  void paint(false);
  return card;
}

function projectCard(): HTMLElement {
  const card = div('mcp-card mcp-stack');
  const paint = async (force: boolean) => {
    clear(card);
    card.append(el('div', 'mcp-card-title', t('home.project')), loadingBox());
    const d = await fetchDetect(force);
    clear(card);
    card.appendChild(el('div', 'mcp-card-title', t('home.project')));
    if (!d.isCloudflare) {
      card.appendChild(el('p', 'mcp-card-sub', t('home.notCfProject')));
      return;
    }
    const kind =
      d.deployKind === 'opennext'
        ? 'Next.js · OpenNext'
        : d.deployKind === 'pages'
          ? 'Pages'
          : 'Worker';
    const badge = el('span', 'mcp-badge ok', kind);
    const head = div('mcp-hstack', badge);
    if (d.workerName) head.appendChild(el('span', 'mcp-row-meta mcp-truncate', d.workerName));
    card.appendChild(head);

    const actions = div('mcp-toolbar');
    if (d.deployKind === 'opennext') {
      actions.append(
        button(t('home.deploy'), 'primary sm', () =>
          pushRun(t('home.deployOpenNext'), [
            ['opennextjs-cloudflare', 'build'],
            ['opennextjs-cloudflare', 'deploy'],
          ]),
        ),
        button(t('home.build'), 'sm', () =>
          pushRun(t('home.build'), [['opennextjs-cloudflare', 'build']]),
        ),
        button(t('home.preview'), 'sm', () =>
          pushRun(t('home.preview'), [
            ['opennextjs-cloudflare', 'build'],
            ['opennextjs-cloudflare', 'preview'],
          ]),
        ),
      );
    } else {
      actions.appendChild(
        button(t('home.deploy'), 'primary sm', () =>
          pushRun('wrangler deploy', [['wrangler', 'deploy']]),
        ),
      );
    }
    actions.appendChild(button(t('home.tail'), 'sm', () => push('logs')));
    card.appendChild(actions);
  };
  void paint(false);
  return card;
}

export function registerHomeView(): void {
  registerView({
    id: 'home',
    label: () => 'Cloudflare',
    render(host) {
      host.appendChild(connectionCard());
      host.appendChild(projectCard());
      const section = div('mcp-section');
      section.appendChild(el('div', 'mcp-section-title', t('home.domains')));
      const list = div('mcp-list');
      for (const d of DOMAINS) {
        const row = el('button', 'mcp-row');
        row.type = 'button';
        row.append(
          div('mcp-row-main',
            el('span', 'mcp-row-title', t(d.labelKey)),
            el('span', 'mcp-row-meta', t(d.metaKey)),
          ),
          el('span', 'mcp-row-chev', '›'),
        );
        row.onclick = d.go;
        list.appendChild(row);
      }
      section.appendChild(list);
      host.appendChild(section);
    },
  });
}
