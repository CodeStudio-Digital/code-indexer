import type { Migration } from './types.js';

/** Content-addressed vectors survive catalog refreshes, which can replace every row of one account. */
export const modelCatalogSearch285: Migration = {
  version: 285,
  name: 'model_catalog_search',
  scope: 'central',
  up(db) {
    db.exec(`
      CREATE TABLE model_catalog_revision (revision INTEGER NOT NULL);
      INSERT INTO model_catalog_revision VALUES (0);
      CREATE TABLE model_catalog_embeddings (
        encoder TEXT NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY (encoder, content_hash)
      ) WITHOUT ROWID;
    `);
    for (const [table, fields] of [
      ['provider_configs', ['id', 'name', 'kind', 'base_url', 'enabled']],
      ['provider_models', ['provider_id','model_id','mode','name','display_name','description','input_modalities',
        'context_window','context_window_overridden','source','can_reason','default_reasoning_level','supported_reasoning_levels','enabled']],
    ] as const) {
      const changed = fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(' OR ');
      for (const [suffix, event] of [['add','INSERT'], ['remove','DELETE'], ['change',`UPDATE OF ${fields.join(',')} `]] as const) {
        db.exec(`CREATE TRIGGER catalog_${table}_${suffix} AFTER ${event} ON ${table}
          ${suffix === 'change' ? 'WHEN ' + changed : ''}
          BEGIN UPDATE model_catalog_revision SET revision = revision + 1; END`);
      }
    }
  },
};
