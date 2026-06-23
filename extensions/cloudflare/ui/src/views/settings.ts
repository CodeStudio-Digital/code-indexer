/** Settings: API token (plugin-scoped storage) and target account. */
import { button, div, el, field, input, select } from '../core/dom.js';
import { mutate, toast } from '../core/api.js';
import { pop, registerView } from '../core/router.js';
import { fetchAccounts } from '../core/status.js';
import { invalidateRows } from '../core/state.js';
import { t } from '../core/i18n.js';

export function registerSettingsView(): void {
  registerView({
    id: 'settings',
    label: () => t('settings.title'),
    render(host) {
      const card = div('mcp-card mcp-stack');
      card.append(
        el('div', 'mcp-card-title', t('settings.tokenTitle')),
        el('p', 'mcp-card-sub', t('settings.notice')),
      );
      const tokenInput = input(t('settings.tokenPh'), 'password');
      const save = button(t('settings.save'), 'primary sm', async () => {
        const token = tokenInput.value.trim();
        if (!token) {
          toast('error', t('settings.tokenRequired'));
          return;
        }
        save.disabled = true;
        const r = await mutate('cf_set_token', { token });
        save.disabled = false;
        if (r) {
          tokenInput.value = '';
          invalidateRows();
          await fetchAccounts(true);
          toast('success', t('settings.connected'));
          pop();
        }
      });
      card.append(field(t('settings.tokenLabel'), tokenInput), save);
      host.appendChild(card);

      const accountCard = div('mcp-card mcp-stack');
      accountCard.appendChild(el('div', 'mcp-card-title', t('settings.accountTitle')));
      accountCard.appendChild(el('p', 'mcp-card-sub', t('home.accountHint')));
      void fetchAccounts(false).then((info) => {
        if (!info) {
          accountCard.appendChild(el('p', 'mcp-row-meta', t('home.noTokenHint')));
          return;
        }
        const sel = select(
          info.rows.map((a) => ({ value: a.id, label: a.name, selected: a.selected })),
        );
        sel.onchange = async () => {
          const r = await mutate('cf_set_account', { accountId: sel.value });
          if (r) {
            invalidateRows();
            await fetchAccounts(true);
          }
        };
        accountCard.appendChild(field(t('settings.accountLabel'), sel));
      });
      host.appendChild(accountCard);
    },
  });
}
