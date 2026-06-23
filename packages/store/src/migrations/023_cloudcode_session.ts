import type DatabaseConstructor from 'better-sqlite3';
type DB = InstanceType<typeof DatabaseConstructor>;

export const cloudcodeSession023 = {
  version: 23,
  name: 'cloudcode_session_id',
  up(db: DB) {
    db.exec(`
      ALTER TABLE coder_sessions
      ADD COLUMN cloudcode_session_id TEXT DEFAULT NULL;
    `);
  },
};
