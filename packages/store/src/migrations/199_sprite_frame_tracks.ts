/**
 * Migration 199 — sprite_frames ganha MULTI-TRACK (camadas de animação estilo
 * Aseprite: grade de tempo compartilhada, célula pode ficar vazia, composição
 * bottom-up no preview/GIF/export).
 *
 * Por que recreate-table: a UNIQUE constraint muda de
 * (animation_id, frame_index) para (animation_id, track, frame_index) e o
 * SQLite não altera constraints in-place — é o 12-step ALTER TABLE oficial,
 * mesmo padrão da migration 103 (outsideTransaction + PRAGMA foreign_keys
 * OFF fora de tx + foreign_key_check antes do COMMIT).
 *
 * Dados existentes: preservados verbatim com track=0 (o default da coluna) —
 * animações viram automaticamente 1 camada "Base" sem nenhum backfill de
 * settings_json (o normalizador de tracks injeta a Base em leitura).
 *
 * Idempotência: PRAGMA table_info guard — coluna `track` presente = no-op.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const spriteFrameTracks199: Migration = {
  version: 199,
  name: 'sprite_frame_tracks',
  // Gerencia a própria transação: foreign_keys OFF precisa acontecer ANTES do
  // BEGIN (dentro de tx o pragma é no-op silencioso).
  outsideTransaction: true,
  up: (db: DB): void => {
    const cols = db
      .prepare(`PRAGMA table_info(sprite_frames)`)
      .all() as Array<{ name: string }>;
    if (cols.length === 0) return; // sprite studio nunca inicializado (196 cria)
    if (cols.some((c) => c.name === 'track')) return;

    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE sprite_frames_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            animation_id INTEGER NOT NULL REFERENCES sprite_animations(id) ON DELETE CASCADE,
            frame_index INTEGER NOT NULL,
            version_id INTEGER NOT NULL,
            duration_ms INTEGER,
            track INTEGER NOT NULL DEFAULT 0,
            UNIQUE (animation_id, track, frame_index)
          );
        `);
        db.exec(`
          INSERT INTO sprite_frames_new (id, animation_id, frame_index, version_id, duration_ms)
          SELECT id, animation_id, frame_index, version_id, duration_ms FROM sprite_frames;
        `);
        db.exec(`DROP TABLE sprite_frames`);
        db.exec(`ALTER TABLE sprite_frames_new RENAME TO sprite_frames`);

        const violations = db.prepare(`PRAGMA foreign_key_check`).all();
        if (violations.length > 0) {
          throw new Error(
            `foreign_key_check found ${violations.length} violation(s) after sprite_frames recreate-table: ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
      });
      tx();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  },
};
