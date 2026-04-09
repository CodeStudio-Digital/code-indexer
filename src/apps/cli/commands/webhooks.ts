import type { Command } from 'commander';
import { WebhookDispatcher } from '../../../core/services/webhooks.js';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  const webhooks = program.command('webhooks').description('Manage webhooks');

  webhooks.command('list').option('-p, --project <name>', 'Project name').action((opts: { project?: string }) => {
    const db = getDB();
    const projectId = opts.project ? db.getProjectByName(opts.project)?.id : undefined;
    const list = db.listWebhooks(projectId);
    for (const w of list) { console.log(`  #${w.id} ${w.url} | events: ${w.events} | active: ${w.active}`); }
    db.close();
  });

  webhooks.command('add <url>').option('-p, --project <name>').option('-e, --events <events>', 'Comma-separated events').option('-s, --secret <secret>')
    .action((url: string, opts: { project?: string; events?: string; secret?: string }) => {
      const db = getDB();
      const projectId = opts.project ? db.getProjectByName(opts.project)?.id : undefined;
      const events = opts.events?.split(',').map(e => e.trim()) ?? ['index.done'];
      const webhook = db.createWebhook({ projectId, url, events, secret: opts.secret });
      console.log(`Webhook #${webhook.id} created.`);
      db.close();
    });

  webhooks.command('remove <id>').action((id: string) => {
    const db = getDB();
    db.deleteWebhook(parseInt(id, 10));
    console.log(`Webhook #${id} deleted.`);
    db.close();
  });

  webhooks.command('test <id>').action(async (id: string) => {
    const db = getDB();
    const dispatcher = new WebhookDispatcher(db);
    const result = await dispatcher.testWebhook(parseInt(id, 10));
    console.log(`Test result: HTTP ${result.status}`);
    db.close();
  });
}
