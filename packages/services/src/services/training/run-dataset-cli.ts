/**
 * Phase A validation CLI — proves the dataset generator end-to-end against a
 * REAL indexed project + a configured teacher provider, before any training
 * infra is built. Reports the acceptance rate (the key Phase-A success signal).
 *
 * Usage (run from the repo root so the Vite fixture path resolves):
 *   tsx packages/services/src/services/training/run-dataset-cli.ts \
 *     --project <name|id> [--profile react-shadcn-vite] [--provider <name>] \
 *     [--model <id>] [--count 8]
 *
 * Requires the node ABI of better-sqlite3 (`pnpm node:rebuild`) and the fixture
 * deps installed (`cd sidecars/fixtures/react-shadcn-vite && npm install`).
 */
import { dirname } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { TrainingStore } from '@mcp/store/training-store.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { runDatasetJob } from './dataset-job.js';

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const projectRef = arg('--project');
  if (!projectRef) throw new Error('Pass --project <name|id>');
  const profileId = arg('--profile', 'react-shadcn-vite')!;
  const provider = arg('--provider');
  const model = arg('--model');
  const count = Number(arg('--count', '8'));

  const { dbPath } = loadConfig();
  const dataDir = dirname(dbPath);
  const db = new CodeIndexDB(dbPath);

  const project = /^\d+$/.test(projectRef)
    ? db.getProject(Number(projectRef))
    : db.getProjectByName(projectRef);
  if (!project) throw new Error(`Project '${projectRef}' not found in ${dbPath}`);

  console.log(`▶ dataset: project=${project.name} root=${project.root_path}`);
  console.log(`  profile=${profileId} teacher=${provider ?? '(default)'} model=${model ?? '(default)'} count=${count}\n`);

  const store = new TrainingStore(db.raw());
  const result = await runDatasetJob(
    {
      projectId: project.id,
      projectRoot: project.root_path,
      name: `cli-${profileId}-${count}`,
      stackProfileId: profileId,
      teacherProvider: provider,
      teacherModel: model,
      targetCount: count,
    },
    {
      db,
      store,
      shell: defaultLocalShellPort(),
      dataDir,
      onProgress: (p) => {
        if (p.event === 'example') {
          process.stdout.write(
            `  [${(p.index ?? 0) + 1}/${p.total}] ${p.verdict === 'pass' ? '✓' : '✗'} ` +
              `accepted=${p.accepted} cost=$${(p.costUsd ?? 0).toFixed(4)}\n`,
          );
        } else if (p.event === 'error') {
          console.error(`  ✖ ${p.message}`);
        }
      },
    },
  );

  const rate = result.total > 0 ? ((result.accepted / result.total) * 100).toFixed(0) : '0';
  console.log(`\n✔ done — accepted ${result.accepted}/${result.total} (${rate}%), cost $${result.costUsd.toFixed(4)}`);
  console.log(`  dataset id=${result.datasetId} → ${dataDir}/training/datasets/${result.datasetId}.jsonl`);
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
