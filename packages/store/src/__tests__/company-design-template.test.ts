import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { CompanyStore } from '../company-store.js';
import { companyAgents018 } from '../migrations/018_company_agents.js';
import { appSettings105 } from '../migrations/105_app_settings.js';

it('atomically records a template and the Company draft receipt in SQLite', () => {
  const SQLite = createRequire(import.meta.url)('better-sqlite3');
  const db = new SQLite(':memory:');
  try {
    companyAgents018.up(db);
    appSettings105.up(db);
    const store = new CompanyStore(db);
    const roles = [
      {
        role: 'master',
        provider: 'chatgpt',
        model: 'sol',
        tier: 'navigate' as const,
        projectHints: ['Backend'],
      },
    ];
    db.exec(
      "CREATE TRIGGER stop_receipt BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'simulated failure'); END",
    );
    expect(() => store.createTemplateForDraft('fixture', 'Audit', '', roles)).toThrow(/simulated failure/);
    expect(store.listTemplates()).toHaveLength(0);
    db.exec('DROP TRIGGER stop_receipt');
    const first = store.createTemplateForDraft('fixture', 'Audit', '', roles);
    expect(store.createTemplateForDraft('fixture', 'Audit', '', roles).id).toBe(first.id);
    expect(store.listTemplates()).toMatchObject([{ roles }]);
  } finally {
    db.close();
  }
});
