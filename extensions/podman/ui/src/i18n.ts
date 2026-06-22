/** Builds the translator over the plugin's own catalogs and localizes the
 *  shared SDK kit labels (loading / actions / create …) so the data-table,
 *  list and state builders speak the active locale too. */
import { configureKitLabels, mcp } from '@mcp/plugin-sdk/ui';
import { MESSAGES } from './messages.js';

export type Translate = (key: string, vars?: Record<string, unknown>) => string;

export const t: Translate = mcp.i18n.translator(MESSAGES);

configureKitLabels({
  loading: t('kit.loading'),
  noRows: t('kit.noRows'),
  noMatches: t('kit.noMatches'),
  actions: t('kit.actions'),
  create: t('common.create'),
  filter: t('common.filter'),
  confirm: t('common.confirm'),
  cancel: t('common.cancel'),
  done: t('kit.done'),
  toolFailed: t('kit.toolFailed'),
});
