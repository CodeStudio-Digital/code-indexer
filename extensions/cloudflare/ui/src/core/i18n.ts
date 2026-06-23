/**
 * Translation entry point. The plugin ships its own catalogs (en + pt-BR);
 * the host injects the active locale and `mcp.i18n.translator` resolves
 * current locale → en → raw key, with {var} interpolation.
 */
import { configureKitLabels } from '@mcp/plugin-sdk/ui';
import { mcp } from './mcp.js';
import { MESSAGES_EN } from './messages.en.js';
import { MESSAGES_PT_BR } from './messages.pt-BR.js';

export const t = mcp.i18n.translator({ en: MESSAGES_EN, 'pt-BR': MESSAGES_PT_BR });

// Localize the SDK kit builders' built-in strings (table/list/state labels).
configureKitLabels({
  loading: t('common.loading'),
  noRows: t('common.noRows'),
  noMatches: t('common.noMatches'),
  actions: t('common.actions'),
  create: t('common.create'),
  filter: t('common.filter'),
  confirm: t('common.confirm'),
  cancel: t('common.cancel'),
  done: t('common.done'),
  streamStopped: t('stream.stopped'),
  streamDone: t('stream.done'),
  toolFailed: t('error.toolFailed'),
  badJson: t('error.badJson'),
});
