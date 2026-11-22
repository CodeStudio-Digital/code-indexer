import { createSymbolFtsUpdateTrigger } from '../db/schema/fts.js';
import type { Migration } from './types.js';

export const symbolFtsUpdates286: Migration = {
  version: 286,
  name: 'symbol_fts_updates',
  runsOnTrimmedProject: true,
  up: createSymbolFtsUpdateTrigger,
};
