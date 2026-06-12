/**
 * Translation entry point. The plugin ships its own catalogs (en + pt-BR);
 * the host injects the active locale and `mcp.i18n.translator` resolves
 * current locale → en → raw key, with {var} interpolation.
 */
import { mcp } from './mcp.js';
import { MESSAGES_EN } from './messages.en.js';
import { MESSAGES_PT_BR } from './messages.pt-BR.js';

export const t = mcp.i18n.translator({ en: MESSAGES_EN, 'pt-BR': MESSAGES_PT_BR });
