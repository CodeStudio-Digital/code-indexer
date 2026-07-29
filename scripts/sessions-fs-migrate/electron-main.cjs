const { appendFileSync } = require('node:fs');
const { app } = require('electron');
const tsx = require('tsx/cjs/api');

const phaseLog = process.env.MCP_SESSIONS_MIGRATE_PHASE_LOG;
const emit = (message) => {
  const line = `[sessions-fs-migrate] BOOTSTRAP ${message}\n`;
  if (phaseLog) appendFileSync(phaseLog, line, 'utf8');
  else process.stderr.write(line);
};

emit('Electron main loaded');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

emit('waiting for app ready');
app.whenReady()
  .then(async () => {
    emit('app ready');
    const { runSessionsFsMigrationCli } = tsx.require('./run.ts', __filename);
    emit('migrator loaded');
    await runSessionsFsMigrationCli(process.argv.slice(2));
    emit('command complete');
    app.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    if (phaseLog) {
      appendFileSync(phaseLog, `[sessions-fs-migrate] FATAL: ${message}\n`, 'utf8');
    } else {
      process.stderr.write(`[sessions-fs-migrate] FATAL: ${message}\n`);
    }
    app.exit(1);
  });
