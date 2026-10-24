const probe = require('./release/lsp-probe.cjs');
const path = require('node:path');
async function main() {
  const rounds = Number(process.argv[3] ?? 5), runs = [];
  for (let index = 0; index < rounds; index++) {
    const result = await probe(path.resolve(process.argv[2] ?? '.'));
    runs.push(result); console.log(JSON.stringify({ round: index + 1, ...result }));
    if (!result.ok) throw new Error('Native LSP process stress failed');
  }
  console.log(JSON.stringify({ passed: true, rounds, confirmedReaps: runs.reduce((sum, run) => sum + run.physicalReaps, 0) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
