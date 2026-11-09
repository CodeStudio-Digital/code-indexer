/** Scrub only explicitly supplied disposable evaluation profiles, including migration backups. */
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { resolve, relative, join, isAbsolute } = require('node:path');
const Database = require('better-sqlite3');
function scrubReliabilityProfile(profile) {
  const root = resolve('.tmp/agent-ide-reliability');
  profile = resolve(profile);
  const rel = relative(root, profile);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(join(profile, 'evaluation-owner.json'))) {
    throw new Error('Not an owned evaluation profile');
  }
  let databases = 0;
  for (const name of readdirSync(profile)) {
    if (!/^index\.db(?:$|\..*bak$)/.test(name)) continue;
    const path = join(profile, name);
    if (readFileSync(path).subarray(0, 16).toString() !== 'SQLite format 3\0') continue;
    const db = new Database(path);
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_configs'").get()) {
        db.pragma('secure_delete=ON');
        db.prepare('UPDATE provider_configs SET api_key=NULL').run();
        db.pragma('wal_checkpoint(TRUNCATE)');
        if (db.prepare('SELECT count(*) AS n FROM provider_configs WHERE api_key IS NOT NULL').get().n) throw new Error('Credential cleanup incomplete');
        databases++;
      }
    } finally { db.close(); }
  }
  return { profile, databases, credentialsRemaining: 0 };
}
module.exports = { scrubReliabilityProfile };
if (require.main === module) for (const profile of process.argv.slice(2)) console.log(JSON.stringify(scrubReliabilityProfile(profile)));
