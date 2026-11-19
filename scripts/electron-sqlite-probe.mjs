import { spawnSync } from 'node:child_process';

const query = `
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const result = db.prepare('SELECT 1 AS ok').get();
  db.close();
  if (result.ok !== 1) process.exitCode = 1;
`;

export function probeElectronSqlite(electron, cwd) {
  return spawnSync(electron, ['-e', query], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
}
